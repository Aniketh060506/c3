"""Ray Jobs entry point for running a user's project once on every live Ray node.

The project's files are bundled with this job. Each node receives a private
copy through Ray's working_dir runtime environment. A project can shard input
using C3_NODE_INDEX/C3_NODE_COUNT and write node-local artifacts to
C3_OUTPUT_DIR. The driver collects those artifacts into one ZIP per node.
"""

import argparse
import io
import json
import os
import re
import shutil
import shlex
import socket
import subprocess
import sys
import zipfile
from pathlib import Path

import ray
from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy

MAX_NODE_OUTPUT_BYTES = 100 * 1024 * 1024


def emit(payload):
    print(json.dumps(payload), flush=True)


def slug(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)[:80] or "node"


@ray.remote(num_cpus=1)
def run_project_on_node(node_id, node_index, node_count, entrypoint, script_args, job_id):
    """Execute one project shard on a specific live Ray node."""
    import tempfile

    project_dir = (Path.cwd() / "project").resolve()
    script_path = (project_dir / entrypoint).resolve()
    if project_dir not in script_path.parents or not script_path.is_file():
        raise RuntimeError(f"Entry point is missing from the worker bundle: {entrypoint}")

    hostname = socket.gethostname()
    with tempfile.TemporaryDirectory(prefix="c3-project-output-") as output_dir:
        env = os.environ.copy()
        env.update({
            "C3_JOB_ID": job_id,
            "C3_NODE_ID": node_id,
            "C3_NODE_INDEX": str(node_index),
            "C3_NODE_COUNT": str(node_count),
            "C3_INPUT_DIR": str(project_dir),
            "C3_OUTPUT_DIR": output_dir,
        })
        requirement_file = project_dir / "requirements.txt"
        dependency_dir = None
        if requirement_file.is_file():
            dependency_dir = Path(tempfile.mkdtemp(prefix="c3-project-deps-"))
            try:
                install = subprocess.run(
                    [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
                     "--target", str(dependency_dir), "-r", str(requirement_file)],
                    cwd=str(project_dir), env=env, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, text=True, timeout=900,
                )
                if install.returncode:
                    raise RuntimeError("Could not install project requirements on " + hostname + ":\n" + install.stdout[-12000:])
                env["PYTHONPATH"] = str(dependency_dir) + os.pathsep + env.get("PYTHONPATH", "")
            except Exception:
                shutil.rmtree(dependency_dir, ignore_errors=True)
                raise

        try:
            run = subprocess.run(
                [sys.executable, str(script_path), *script_args], cwd=str(project_dir),
                env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, timeout=24 * 60 * 60,
            )
        finally:
            if dependency_dir:
                shutil.rmtree(dependency_dir, ignore_errors=True)
        output_text = (run.stdout or "").strip()
        if output_text:
            emit({"type": "log", "message": f"[{hostname}]\n{output_text[-12000:]}"})

        output_root = Path(output_dir)
        total_bytes = sum(path.stat().st_size for path in output_root.rglob("*") if path.is_file() and not path.is_symlink())
        if total_bytes > MAX_NODE_OUTPUT_BYTES:
            raise RuntimeError(f"{hostname} produced {total_bytes} output bytes; the per-node result limit is 100 MiB.")
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
            for path in output_root.rglob("*"):
                if path.is_file() and not path.is_symlink():
                    bundle.write(path, path.relative_to(output_root).as_posix())
        return {
            "node": hostname,
            "index": node_index,
            "exitCode": run.returncode,
            "log": output_text[-12000:],
            "archive": archive.getvalue(),
            "outputBytes": total_bytes,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--entrypoint", required=True)
    parser.add_argument("--script-args", default="")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--results-dir", required=True)
    args = parser.parse_args()

    ray.init(address="auto", logging_level="ERROR")
    live_nodes = [node for node in ray.nodes() if node.get("Alive") and node.get("NodeID")]
    if not live_nodes:
        raise RuntimeError("Ray has no live nodes available for this project job.")

    result_dir = (Path.cwd() / args.results_dir).resolve()
    result_dir.mkdir(parents=True, exist_ok=True)
    script_args = shlex.split(args.script_args)
    futures = [
        run_project_on_node.options(
            scheduling_strategy=NodeAffinitySchedulingStrategy(node["NodeID"], soft=False),
        ).remote(node["NodeID"], index, len(live_nodes), args.entrypoint, script_args, args.job_id)
        for index, node in enumerate(live_nodes)
    ]

    artifacts = []
    failures = []
    for future in futures:
        try:
            result = ray.get(future)
            if result["log"]:
                emit({"type": "log", "message": f"[{result['node']}]\n{result['log']}"})
            filename = f"node-{result['index'] + 1:02d}-{slug(result['node'])}.zip"
            (result_dir / filename).write_bytes(result["archive"])
            artifacts.append({"name": filename, "node": result["node"], "bytes": result["outputBytes"]})
            if result["exitCode"]:
                failures.append(f"{result['node']} exited with code {result['exitCode']}.")
        except Exception as error:
            failures.append(str(error))

    manifest = {
        "jobId": args.job_id,
        "entrypoint": args.entrypoint,
        "nodeCount": len(live_nodes),
        "artifacts": artifacts,
        "failures": failures,
    }
    (result_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    emit({
        "type": "project_result",
        "ok": not failures and len(artifacts) == len(live_nodes),
        "nodes": [item["node"] for item in artifacts],
        "artifacts": artifacts,
        "error": " ".join(failures) if failures else None,
        "message": f"Project ran on {len(artifacts)} of {len(live_nodes)} Ray nodes; per-node result ZIPs are ready.",
    })
    ray.shutdown()
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

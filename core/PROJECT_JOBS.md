# Running a project on C3 Ray nodes

## What C3 does

1. Select a project folder in **Use compute**, launch the C3 cluster, then open **Ray & terminal → AI Training Studio → My project**.
2. Enter a Python entry point relative to the selected folder (for example `train.py` or `src/train.py`) and optional arguments.
3. C3 bundles the project from the mounted workspace and submits it as the Ray job working directory. Ray stages that bundle in the runtime environment on the live Ray nodes. Bundles are limited to 200 MiB. C3 skips `.git`, `node_modules`, Python virtual environments/caches, and prior `C3-results` output.
4. A Ray task pinned to each live Ray node runs the entry point once. Each task gets the same full input folder. The script should shard its inputs itself using `C3_NODE_INDEX` and `C3_NODE_COUNT`.
5. Each task's `C3_OUTPUT_DIR` is collected into a node-specific ZIP. C3 copies those ZIPs and a manifest into `<project>/C3-results/<job-id>/` and offers **Open downloaded results**.

There is no JuiceFS mount or continuously shared filesystem. Files are a per-job snapshot copied through Ray's working-directory runtime environment. One task runs on every reported live Ray node, including the Ray head node.

## Project script contract

The process receives these environment variables:

- `C3_JOB_ID`: C3 job identifier.
- `C3_NODE_ID`: Ray node ID assigned to this task.
- `C3_NODE_INDEX`: zero-based index in the live node list.
- `C3_NODE_COUNT`: number of live Ray nodes targeted by this job.
- `C3_INPUT_DIR`: full project folder copy on this node.
- `C3_OUTPUT_DIR`: empty temporary directory for files to return from this node.

Example `train.py` that assigns CSV files by node and returns a small report:

```python
import json
import os
from pathlib import Path

node_index = int(os.environ["C3_NODE_INDEX"])
node_count = int(os.environ["C3_NODE_COUNT"])
input_dir = Path(os.environ["C3_INPUT_DIR"])
output_dir = Path(os.environ["C3_OUTPUT_DIR"])

files = sorted(input_dir.glob("*.csv"))
assigned = files[node_index::node_count]
# Replace this loop with your actual processing/training code.
report = {"node": node_index, "files": [file.name for file in assigned]}
(output_dir / f"report-{node_index}.json").write_text(json.dumps(report, indent=2))
```

A root `requirements.txt` is installed into a per-task dependency directory on each Ray node before the script starts. Those installs need the package index to be reachable. Script output and errors are shown in the job log. Each node may return up to 100 MiB of uncompressed output; returned output is a ZIP, not automatically merged into one file.

Only submit project files and data to provider nodes you trust. The current cluster does not provide a security sandbox for arbitrary submitted code.

"""Run a distributed NumPy classification workload on an existing Ray cluster.

The input data is generated for a compute benchmark and is intentionally
reported as synthetic. This is not ResNet, LLaMA, or training on user data.
"""

import argparse
import json
import time

import numpy as np
import ray


@ray.remote(num_cpus=1)
def compute_batch(w1, b1, w2, b2, batch_size, input_dim, seed):
    """Compute one real forward/backward pass on the Ray-assigned node."""
    import socket

    rng = np.random.default_rng(seed)
    x = rng.standard_normal((batch_size, input_dim), dtype=np.float32)
    labels = rng.integers(0, w2.shape[1], size=batch_size)
    targets = np.zeros((batch_size, w2.shape[1]), dtype=np.float32)
    targets[np.arange(batch_size), labels] = 1.0

    z1 = x @ w1 + b1
    h = np.maximum(0, z1)
    logits = h @ w2 + b2
    logits -= np.max(logits, axis=1, keepdims=True)
    exp_logits = np.exp(logits)
    probs = exp_logits / np.sum(exp_logits, axis=1, keepdims=True)

    loss = float(-np.mean(np.sum(targets * np.log(probs + 1e-8), axis=1)))
    correct = int(np.sum(np.argmax(probs, axis=1) == labels))
    dz2 = (probs - targets) / batch_size
    dw2 = h.T @ dz2
    db2 = np.sum(dz2, axis=0, keepdims=True)
    dh = dz2 @ w2.T
    dz1 = dh * (z1 > 0)
    dw1 = x.T @ dz1
    db1 = np.sum(dz1, axis=0, keepdims=True)

    return {
        "dw1": dw1,
        "db1": db1,
        "dw2": dw2,
        "db2": db2,
        "loss": loss,
        "correct": correct,
        "samples": batch_size,
        "node": socket.gethostname(),
    }


def emit(payload):
    print(json.dumps(payload), flush=True)


def run(epochs, batch_size, learning_rate):
    ray.init(address="auto", logging_level="ERROR")
    resources = ray.cluster_resources()
    available_cpus = max(1, int(resources.get("CPU", 1)))
    task_count = min(available_cpus, 4, batch_size)

    input_dim, hidden_dim, output_dim = 128, 256, 10
    rng = np.random.default_rng(2026)
    w1 = (rng.standard_normal((input_dim, hidden_dim), dtype=np.float32)
          * np.sqrt(2.0 / input_dim))
    b1 = np.zeros((1, hidden_dim), dtype=np.float32)
    w2 = (rng.standard_normal((hidden_dim, output_dim), dtype=np.float32)
          * np.sqrt(2.0 / hidden_dim))
    b2 = np.zeros((1, output_dim), dtype=np.float32)

    steps_per_epoch = 10
    total_steps = epochs * steps_per_epoch
    emit({
        "type": "log",
        "message": f"Ray connected to {len(ray.nodes())} node(s), {available_cpus} CPU resource(s); running a synthetic NumPy classification workload.",
    })

    seen_nodes = set()
    final_loss = None
    final_accuracy = None
    for epoch in range(1, epochs + 1):
        for step_in_epoch in range(1, steps_per_epoch + 1):
            step_start = time.perf_counter()
            batch_sizes = [batch_size // task_count + (1 if index < batch_size % task_count else 0)
                           for index in range(task_count)]
            batches = [
                compute_batch.remote(
                    w1, b1, w2, b2, batch_sizes[index], input_dim,
                    seed=epoch * 1_000_000 + step_in_epoch * 100 + index,
                )
                for index in range(task_count)
            ]
            results = ray.get(batches)
            samples = sum(result["samples"] for result in results)

            w1 -= learning_rate * sum(r["dw1"] * r["samples"] for r in results) / samples
            b1 -= learning_rate * sum(r["db1"] * r["samples"] for r in results) / samples
            w2 -= learning_rate * sum(r["dw2"] * r["samples"] for r in results) / samples
            b2 -= learning_rate * sum(r["db2"] * r["samples"] for r in results) / samples

            elapsed = max(time.perf_counter() - step_start, 1e-9)
            final_loss = sum(r["loss"] * r["samples"] for r in results) / samples
            final_accuracy = 100.0 * sum(r["correct"] for r in results) / samples
            seen_nodes.update(r["node"] for r in results)

            # Approximate multiply/add operations for the two dense layers' forward
            # and backward passes, divided by measured wall time. This is a model
            # operation estimate, not a hardware-counter measurement.
            estimated_flops = 4 * samples * (input_dim * hidden_dim + hidden_dim * output_dim)
            emit({
                "type": "progress",
                "epoch": epoch,
                "totalEpochs": epochs,
                "step": (epoch - 1) * steps_per_epoch + step_in_epoch,
                "totalSteps": total_steps,
                "loss": round(final_loss, 5),
                "accuracy": round(final_accuracy, 2),
                "throughput": round(samples / elapsed, 2),
                "estimatedGflops": round(estimated_flops / elapsed / 1e9, 5),
                "stepDurationMs": round(elapsed * 1000, 2),
                "nodes": sorted(seen_nodes),
                "dataKind": "synthetic",
                "backend": "Ray + NumPy CPU",
            })

    emit({
        "type": "completed",
        "finalLoss": round(final_loss, 5),
        "finalAccuracy": round(final_accuracy, 2),
        "nodes": sorted(seen_nodes),
        "message": f"Completed {total_steps} distributed steps on {len(seen_nodes)} Ray node(s) using synthetic data.",
    })
    ray.shutdown()


def main():
    parser = argparse.ArgumentParser(description="C3 distributed synthetic compute workload")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=0.001)
    args = parser.parse_args()
    run(max(1, args.epochs), max(1, args.batch_size), max(1e-8, args.lr))


if __name__ == "__main__":
    main()

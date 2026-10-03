# C3: Community Compute Cloud — Implementation Plan

> **Status:** Experimental desktop prototype. Implemented code is not the same as a verified production service.
> **Data rule:** Display measurements only when a host, Kubernetes, Ray, or DynamoDB call returned them. Unknown values stay unknown. Demo and synthetic data must be labeled.

## Current implementation

| Area | Implemented | Not implemented / limits |
|---|---|---|
| Desktop UI and Electron IPC | React UI, isolated preload bridge, hardware and cluster IPC handlers. | Not a production-hardened security boundary for running untrusted provider workloads. |
| Host hardware | CPU thread count, memory, OS, disk, network adapter, latency probes, and NVIDIA `nvidia-smi` readings when available. Unknown physical core counts, RAM generation, GPU readings, and link rates stay unknown. | GPU telemetry supports NVIDIA `nvidia-smi`; it does not enable GPU scheduling in Ray/Kubernetes. Drive technology is not identified. |
| Provider mode | Broadcasts LAN discovery, listens on HTTP RPC port 44344, advertises to DynamoDB when configured, and can launch a K3s worker after the provider accepts an invitation. Provider RPC bind failure is reported as a startup failure. | LAN UDP discovery does not cross subnets. Cloud discovery requires valid AWS identity/table access. Tailscale is detected, not installed or configured by C3. There is no TURN relay or automatic NAT traversal. |
| Provider requests and negotiation | A consumer can queue a provider request; the provider can accept or decline it. The request's chat stores messages and proposed prices, and an agreed quote is recorded for that request. | Price agreement is not payment. The provider accept/chat path still needs a live two-host end-to-end run. Cloud-persisted requests and chat need valid Cognito Identity Pool credentials; direct LAN RPC has separate reachability requirements. |
| Consumer/K3s | Starts a local K3s control plane in Docker, mounts the selected directory at `/workspace`, invites selected providers, and counts only remote Kubernetes nodes that report Ready. | Cross-network K3s networking depends on reachable host addresses and the K3s/flannel network; this is environment-dependent. The selected workspace is bundled per project job and replicated through Ray's working-directory runtime environment (200 MiB cap); this is not a persistent/shared JuiceFS mount. |
| Resource limits | Local cluster and provider worker CPU/RAM selections are bounded by host and Docker capacity; Docker container limits and Kubernetes allocation labels feed Ray pod limits. | Docker Desktop's memory limit is substantially below host RAM. The currently running cluster predates these labels and container caps; new settings apply when a new cluster/worker is created. This prototype does not isolate arbitrary untrusted provider code. |
| Ray compute | Creates Ray head/worker pods on Ready K3s nodes and verifies live membership. The built-in workload performs NumPy forward/backward passes on synthetic data. Project mode bundles a selected workspace, runs a Python entry point once on each live Ray node with node-index environment variables, and copies a ZIP of each node's `C3_OUTPUT_DIR` into `C3-results/<job-id>`. | Project distribution is a per-job bundle capped at 200 MiB, not JuiceFS or live shared storage; each node gets the full input copy and the script must shard it. Per-node outputs are capped at 100 MiB. GPU scheduling, distributed checkpoints, a security sandbox, and a live multi-node run remain outstanding. |
| Credits | New cloud user rows receive a 100 C3 test-credit balance. The +500 test-credit grant is now limited atomically to one claim per account and returns success only after DynamoDB confirms it. | Earlier app builds allowed repeated claims; existing balances (including previously claimed credits) have not been modified. Credits are database test points, not payment. No metering, settlement, or provider earnings. |
| Authentication | Cognito direct sign-up, confirmation, password login, token refresh, and a hosted-login redirect flow exist in code. Startup waits for session restoration and rejects a cached display name as proof of sign-in. | OAuth PKCE is not implemented. AWS cloud features additionally require the Cognito Identity Pool to issue temporary credentials and its authenticated role to have table permissions. Callback/domain settings must match the deployed Cognito app client. |
| UI status and maintenance | Dashboard status is based on live service probes; Consumer configures the local host separately, lists only remote providers for selection, and keeps request chat/price negotiation. Overview reports local capacity separately from cluster state. Unavailable theme/notification controls were removed; network and container maintenance are under Advanced Settings. GPU sharing controls are hidden until Kubernetes/Ray GPU scheduling exists. Pruning only removes stopped C3 K3s containers and preserves running containers. K3s launch attempts Ray startup and returns Ray errors separately from K3s status; Ray can also be started from its dashboard view. | Consumer/provider/Ray still need a full visual audit and consistent layout pass. Provider, chat, Ray jobs, and settings need an end-to-end review on the live app; current screenshots may be from an older installed build. |
| Ray shell | xterm input now converts Enter into a submitted shell line and buffers commands while the container shell starts. Shortcuts inspect cluster nodes, all-namespace pods/services, and live Ray nodes with `kubectl`. | The bridge is pipe-based, not a PTY. Full-screen programs/editors such as `kubectl edit`, `vi`, or `top` are not supported. The shell runs inside the C3 K3s control-plane container, and `kubectl` manages only nodes that actually joined that cluster. |
| Maintenance | Docker/container status, pruning, network diagnostics, and a local history of confirmed DynamoDB test-credit grants. | Local transaction history is a display cache, not an authoritative ledger. |

## Actual Ray job path

1. The consumer starts K3s in Docker and verifies its API server is responding.
2. Selected providers receive a session invitation; each provider must accept it before its K3s agent joins.
3. The Ray engine reads Kubernetes nodes and selects only nodes reporting Ready.
4. It creates one Ray head pod and a Ray worker pod on each other Ready K3s node. A provider that has not accepted or joined is not included.
5. It waits until Ray itself reports each assigned node alive. If a worker cannot connect, the Ray setup fails with an error instead of claiming the cluster is ready.
6. The engine submits `core/ai_trainer.py` as a Ray Job. The script generates synthetic classification batches, distributes CPU tasks, applies real gradient updates, and streams its measured results.
7. In project mode, C3 packages the mounted workspace (excluding common generated folders) with a Ray job runner. Ray runtime environments stage the package on each live node. A node-affinity task runs the selected Python entry point on each node with `C3_NODE_INDEX`, `C3_NODE_COUNT`, `C3_INPUT_DIR`, and `C3_OUTPUT_DIR`. The runner returns a ZIP per node; C3 copies those files to `<workspace>/C3-results/<job-id>` and opens that folder from the UI.

## Deployment prerequisites and connectivity

- Windows with Docker Desktop in Linux-container mode, Node.js, and a working AWS configuration for cloud features.
- For remote workers, each provider must reach the consumer's advertised LAN or Tailscale address. The consumer K3s API uses TCP 6443, and K3s Flannel VXLAN uses UDP 8472 between nodes. Host/container networking and firewalls must allow both directions as appropriate.
- The Ray image `rayproject/ray:2.58.0-py312` and K3s image `rancher/k3s:v1.36.4-k3s1` must be pullable or cached on each host/node that uses them. New Ray pods request resources derived from node allocation labels, reserving part of allocated RAM for K3s and system work; legacy unlabeled nodes use conservative defaults.
- The provider must accept each worker invitation. A reachable invitation endpoint is not proof that a worker joined; Kubernetes Ready and live Ray node responses are the proof.
- Cloud registry and test-credit features require correct Cognito identity, AWS credentials, region, DynamoDB tables, and table permissions.

## Work still required before production

1. Replace public-client secret handling with a Cognito public app client and PKCE-based authorization-code flow; configure the callback through deployment settings.
2. Add authenticated and encrypted provider session negotiation, worker isolation review, and safe secret handling.
3. Add explicit per-job provider approval and review the security boundary before running submitted code on provider machines; the current project bundle path is experimental and relies on resource-provider trust.
4. Implement GPU device plugins/runtime support and verify Ray GPU resources before exposing GPU scheduling.
5. Add shared storage/checkpointing and operator-managed Ray lifecycle for multi-node jobs.
6. Implement metering and a durable settlement ledger before showing provider earnings or treating offer rates as payments.
7. Exercise the full flow on a running Docker/K3s/AWS setup; this repository build alone cannot prove remote peers, credentials, or firewall routes work.
8. Add durable shared storage such as JuiceFS/S3 for datasets larger than the current per-job bundle limits and shared checkpoints between workers.

## Verification state

- UI production build: passed after the current implementation changes (Vite reports the existing large JavaScript chunk warning).
- JavaScript syntax checks: passed for the changed Cognito, Ray, and K3s orchestration modules.
- Local environment observed on 2026-10-02: Docker Desktop Linux engine is running (32 CPUs, about 7.36 GiB available to Docker). `c3-k3s-master` is running with exactly one Ready Kubernetes node and has no Ray pods. `kind-control-plane`, `devops-control-plane`, and `devops-worker` are separate containers/clusters and are not joined to C3. Therefore the live environment does not currently demonstrate a distributed Ray cluster.
- The Ray dashboard and distributed worker join were not live-verified in this check. Starting Ray requires pulling/scheduling its image; remote compute requires a second reachable provider to accept and join.
- `npm run build-ui` passed after the terminal, Ray startup/status, and one-time faucet changes; `node --check` passed for the changed main/preload/backend JavaScript. Vite reports its existing large-bundle warning.
- Current UI status: local resource allocation is separate from remote-provider selection; requests/chat remain in the consumer UI. Full redesign of all tabs, real PTY/editor support, arbitrary project code/data distribution, GPU scheduling, settlement, and a live two-host acceptance/chat/worker-join round-trip remain unfinished.
- Consumer selection behavior: local resources are not provider selections; the local host is added internally to cluster launch using its dedicated CPU/RAM allocation. Only discovered remote providers appear as selectable cards.

# ComputePool

Desktop-first React and TypeScript interface for the ComputePool consumer and provider workflows.

## Run the frontend

```sh
npm install
npm run dev
```

The browser build is for layout development. It does not show substituted hardware, provider, cluster, session, or workload data. Live machine access requires the Windows Tauri app and the native/service commands described in `src/lib/platform.ts`.

## Main workflows

- **Machine readiness:** query this laptop's CPU, memory, GPU, storage, network, and dependency status. Installation starts only after an explicit user action.
- **Consumer:** find providers returned by the live marketplace service, negotiate, wait for provider acceptance, choose a local project folder, and start a session. Connection-stage updates come from the session service. The terminal is available from a ready node in the connected session dashboard.
- **Batch jobs:** choose ready session nodes, request CPU, RAM, and GPU resources, submit Kubernetes Jobs, inspect live job state, and cancel work.
- **Provider:** set resource limits from detected hardware, publish this laptop online, review and decide each request, and view reported session consumption.

## Native integration

`src/lib/platform.ts` is the typed Tauri command boundary. It intentionally has no mock fallback. Cognito Hosted UI provides authentication; the app keeps the current Cognito tokens in process memory. Provider availability, negotiation, chat, and decisions use the Cognito-authenticated AWS API and existing DynamoDB tables. NetBird setup keys are created by the backend and never stored in the desktop build.

The project-folder session call passes the consumer workspace path and `outputPolicy: "consumer_local_only"`. After provider acceptance, ComputePool enrolls missing NetBird peers, creates a temporary access group/policy for only the accepted consumer/providers, starts the consumer's shared K3s server, and joins provider workers. NetBird access is removed when the session ends or when its accepted duration expires. Pod shell and provider-machine SSH are separate operations. Batch Jobs are submitted to Kubernetes with selected-node affinity and resource requests/limits.

Deploy and configure the live AWS/NetBird control plane using [backend/README.md](backend/README.md) before building the distributed-compute installer. The desktop binary must be built with the CloudFormation `ApiUrl` output in `COMPUTEPOOL_API_URL`.

## Current Phase 2 limits

- Batch input archives are transferred to each selected provider over the authenticated NetBird peer service and capped at 256 MiB. Job commands receive `COMPUTEPOOL_INPUT_DIR` and `COMPUTEPOOL_OUTPUT_DIR`. Completed output is collected into a per-node subfolder under the selected consumer output folder. The transfer is a one-time archive snapshot when the job is submitted.
- GPU scheduling requires a working NVIDIA Container Toolkit/runtime on the relevant node and `nvidia.com/gpu` to be advertised by Kubernetes. The dependency screen reports installation state; GPU support has not been live-verified here.
- A live multi-laptop run could not be verified in this environment because Docker Desktop's engine was stopped and the saved `k3d-computepool` context was unreachable. Start Docker Desktop on the consumer and each provider before testing a real session.

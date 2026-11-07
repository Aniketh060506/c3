import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";

/** Typed boundary to the native Tauri/Rust and ComputePool service APIs.
 * No browser fallback is provided: unavailable services stay visibly unavailable.
 */
export type HardwareSnapshot = {
  capturedAt: string;
  cpu: { model: string; physicalCores: number; logicalCores: number; utilizationPercent: number; frequencyMhz?: number };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number };
  gpus: Array<{ id: string; name: string; vendor: string; computeSupported: boolean; telemetryAvailable: boolean; utilizationPercent: number; vramTotalBytes: number; vramUsedBytes: number; driverVersion?: string }>;
  storage: Array<{ name: string; totalBytes: number; availableBytes: number }>;
  network: { connected: boolean; interfaceName?: string; netbirdStatus: "connected" | "disconnected" | "starting" | "unknown"; peerIp?: string };
};
export type DependencyStatus = "installed" | "on_demand" | "missing" | "outdated" | "not_running" | "configuration_required";
export type Dependency = { id: string; name: string; status: DependencyStatus; installedVersion?: string; requiredVersion: string; details?: string };
export type ProviderNode = { id: string; displayName: string; online: boolean; netbirdIp?: string; cpuModel?: string; availableCores?: number; availableMemoryBytes?: number; gpuNames: string[]; price?: { amount: number; currency: string; unit: string }; latencyMs?: number };
export type ProviderLimits = { cpuCores: number; memoryBytes: number; gpuIds: string[] };
export type Negotiation = { id: string; providerId: string; providerSub?: string; providerName?: string; consumerSub?: string; consumer?: string; consumerName?: string; myRole?: "consumer" | "provider"; state: "open" | "accepted" | "rejected" | "expired" | "ended"; updatedAt: string; createdAt?: string; durationMinutes?: number; requestedLimits?: ProviderLimits; workloadDescription?: string };
export type NegotiationMessage = { id: string; sender: "consumer" | "provider"; text: string; createdAt: string; proposal?: { cpuCores: number; memoryBytes: number; gpuIds: string[]; durationMinutes: number; priceAmount: number; currency: string; state: "open" | "accepted" | "rejected" } };
export type ClusterNode = { id: string; name: string; role: string; status: "ready" | "not_ready" | "unknown"; cpuCores?: number | null; memoryBytes?: number | null; cpuUsedCores?: number | null; memoryUsedBytes?: number | null; gpuNames: string[]; cpuPercent?: number | null; memoryPercent?: number | null; gpuPercent?: number | null };
export type ClusterSnapshot = { id: string; status: "connecting" | "ready" | "degraded" | "disconnected"; capturedAt: string; metricsAvailable?: boolean; metricsError?: string | null; nodes: ClusterNode[] };
export type ConnectionStage = { id: string; label: string; status: "pending" | "running" | "completed" | "failed"; detail?: string };
export type SessionSetup = { sessionId: string; clusterId: string };
export type IncomingRequest = { id: string; consumer: string; requestedLimits: ProviderLimits; durationMinutes: number; workloadDescription?: string; createdAt: string };
export type ProviderStatus = { online: boolean; activeSessions: number; capturedAt: string; connectionError?: string; limits?: { cpuCores?: number; memoryBytes?: number; gpuIds?: string[] } };
export type ProviderSessionMetric = { id: string; consumer: string; state: "accepted" | "starting" | "active" | "stopping" | "disconnected"; startedAt: string; containerName?: string; telemetryAvailable?: boolean; requestedCpuCores?: number | null; requestedMemoryBytes?: number | null; requestedGpuIds?: string[]; durationMinutes?: number | null; workloadDescription?: string | null; cpuPercent?: number | null; memoryBytes?: number | null; memoryLimitBytes?: number | null; memoryPercent?: number | null; networkRxBytes?: number | null; networkTxBytes?: number | null; blockReadBytes?: number | null; blockWriteBytes?: number | null; processCount?: number | null; gpuPercent?: number | null };
export type BatchPodStatus = { name: string; phase: string; nodeName?: string | null; ready: boolean; reason: string; detail?: string | null; restartCount: number; logs?: string | null; events?: string[]; imagePullPolicy?: string | null };
export type BatchJob = { id: string; name: string; image: string; imagePullPolicy?: string; status: "submitted" | "queued" | "scheduled" | "starting" | "running" | "completed" | "failed" | "cancelled"; nodeIds: string[]; cpuCores: number; memoryBytes: number; gpuCount?: number; replicas?: number; progressPercent?: number; outputSync?: "pending" | "completed" | "failed"; createdAt: string; error?: string; pods?: BatchPodStatus[] };
export type KubernetesPod = { namespace: string; name: string; phase: string; containers: string[] };
export type NetBirdPeer = { id: string; displayName: string; netbirdIp?: string; connected: boolean; connectionType?: string };
export type NetBirdStatus = { installed: boolean; connected: boolean; status: "connected" | "disconnected" | "starting" | "not_running" | "missing" | string; version?: string; peerIp?: string };
export type AuthStatus = { authenticated: boolean; username?: string; displayName?: string; expiresAt?: number };

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let nativeRequestSequence = 0;
const nativeRequests = new Map<number, string>();
const longNativeRequests = new Set<number>();
const nativeActivityListeners = new Set<() => void>();
const notifyNativeActivity = () => nativeActivityListeners.forEach((listener) => listener());
export const nativeActivity = {
  subscribe: (listener: () => void) => { nativeActivityListeners.add(listener); return () => nativeActivityListeners.delete(listener); },
  count: () => longNativeRequests.size,
  label: () => {
    const commands = [...longNativeRequests].map((id) => nativeRequests.get(id)).filter((value): value is string => Boolean(value));
    const command = commands.at(-1);
    const friendly: Record<string, string> = { start_compute_session: "Connecting cluster nodes", get_cluster_snapshot: "Refreshing cluster status", open_node_shell: "Opening provider shell", execute_node_shell_command: "Running provider command", create_interactive_pod: "Starting Kubernetes pod", open_pod_shell: "Opening pod shell", submit_batch_job: "Submitting batch workload", end_compute_session: "Ending compute session", get_hardware: "Refreshing machine telemetry", check_dependencies: "Checking machine readiness" };
    return command ? (friendly[command] ?? "Waiting for ComputePool services") : "";
  },
};

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Open ComputePool in its Windows desktop app to access live machine and network services.");
  const id = ++nativeRequestSequence;
  nativeRequests.set(id, command);
  const timer = window.setTimeout(() => { if (nativeRequests.has(id)) { longNativeRequests.add(id); notifyNativeActivity(); } }, 450);
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    const message = typeof error === "string" ? error : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : null;
    throw new Error(message ?? `Native command ${command} failed.`);
  } finally {
    window.clearTimeout(timer);
    nativeRequests.delete(id);
    if (longNativeRequests.delete(id)) notifyNativeActivity();
  }
}

export const hardwareService = {
  get: () => invoke<HardwareSnapshot>("get_hardware"),
};

export const dependencyService = {
  list: () => invoke<Dependency[]>("check_dependencies"),
  install: (id: string) => invoke<{ status: DependencyStatus; installedVersion?: string; details?: string }>("install_dependency", { id }),
  verify: (id: string) => invoke<Dependency>("verify_dependency", { id }),
};

export const netbirdService = {
  status: () => invoke<NetBirdStatus>("get_netbird_status"),
  connect: () => invoke<void>("connect_netbird", { role: "consumer" }),
  peers: () => invoke<NetBirdPeer[]>("list_netbird_peers"),
};

export const authService = {
  status: () => invoke<AuthStatus>("get_auth_status"),
  beginHostedLogin: () => invoke<void>("open_cognito_login"),
  signOut: () => invoke<void>("cognito_sign_out"),
};

export const marketplaceService = {
  list: () => invoke<ProviderNode[]>("list_available_providers"),
  get: (providerId: string) => invoke<ProviderNode>("get_provider_details", { providerId }),
};

export const negotiationService = {
  list: () => invoke<Negotiation[]>("list_negotiations"),
  messages: (providerId: string) => invoke<NegotiationMessage[]>("get_negotiation_messages", { providerId }),
  messagesById: (negotiationId: string) => invoke<NegotiationMessage[]>("get_negotiation_messages_by_id", { negotiationId }),
  sendMessage: (providerId: string, body: string) => invoke<void>("send_negotiation_message", { providerId, body }),
  sendMessageById: (negotiationId: string, body: string) => invoke<NegotiationMessage>("send_negotiation_message_by_id", { negotiationId, body }),
  sendProposal: (providerId: string, limits: ProviderLimits, durationMinutes: number) => invoke<Negotiation>("send_resource_proposal", { providerId, limits, durationMinutes }),
  closeRequest: (negotiationId: string) => invoke<void>("close_negotiation_request", { negotiationId }),
  decideProposal: (messageId: string, decision: "accept" | "reject") => invoke<void>("decide_resource_proposal", { messageId, decision }),
  startRequest: (providerId: string, limits: ProviderLimits, durationMinutes: number) => invoke<Negotiation>("start_resource_request", { providerId, limits, durationMinutes }),
};

export const providerService = {
  status: () => invoke<ProviderStatus>("get_provider_status"),
  setLimits: (limits: ProviderLimits) => invoke<void>("set_provider_limits", { limits }),
  setOnline: (online: boolean) => invoke<ProviderStatus>("set_provider_online", { online }),
  requests: () => invoke<IncomingRequest[]>("list_incoming_requests"),
  sessions: () => invoke<ProviderSessionMetric[]>("list_provider_sessions"),
  liveTelemetry: () => invoke<ProviderSessionMetric[]>("list_provider_live_telemetry"),
  decideRequest: (requestId: string, decision: "accept" | "reject") => invoke<void>("decide_provider_request", { requestId, decision }),
  messages: (consumerId: string) => invoke<NegotiationMessage[]>("get_provider_messages", { consumerId }),
  sendMessage: (consumerId: string, body: string) => invoke<void>("send_provider_message", { consumerId, body }),
};

export const clusterService = {
  snapshot: (clusterId?: string) => invoke<ClusterSnapshot>("get_cluster_snapshot", clusterId ? { clusterId } : undefined),
  startSession: (negotiationIds: string[], projectFolder: string) => invoke<SessionSetup>("start_compute_session", { negotiationIds, consumerWorkspacePath: projectFolder, outputPolicy: "consumer_local_only" }),
  connectionStatus: (sessionId: string) => invoke<{ sessionId: string; clusterId: string; status: "connecting" | "ready" | "failed"; stages: ConnectionStage[]; error?: string | null }>("get_session_connection_status", { sessionId }),
  endSession: (clusterId: string) => invoke<void>("end_compute_session", { clusterId }),
  openShell: (clusterId: string, nodeId: string) => invoke<{ shellId: string; peerName: string; peerIp: string; stdout: string }>("open_node_shell", { clusterId, nodeId }),
  executeShellCommand: (shellId: string, command: string) => invoke<{ stdout: string; stderr: string; exitCode: number }>("execute_node_shell_command", { shellId, command }),
  pods: (clusterId: string) => invoke<KubernetesPod[]>("list_running_pods", { clusterId }),
  createInteractivePod: (clusterId: string, spec: { image: string; cpuCores: number; memoryGib: number; gpuCount: number; namespace: string }) => invoke<{ namespace: string; podName: string; image: string; cpuCores: number; memoryGib: number; gpuCount: number }>("create_interactive_pod", { clusterId, ...spec }),
  openPodShell: (clusterId: string, namespace: string, podName: string, container?: string) => invoke<{ shellId: string }>("open_pod_shell", { clusterId, namespace, podName, container }),
  executePodCommand: (shellId: string, command: string) => invoke<{ stdout: string; stderr: string; exitCode: number }>("execute_pod_shell_command", { shellId, command }),
  batchJobs: (clusterId: string) => invoke<BatchJob[]>("list_batch_jobs", { clusterId }),
  submitBatchJob: (clusterId: string, spec: { name: string; image: string; command: string; cpuCores: number; memoryBytes: number; gpuCount: number; replicas: number; inputFolder: string; outputFolder: string; nodeIds: string[] }) => invoke<BatchJob>("submit_batch_job", { clusterId, spec }),
  cancelBatchJob: (jobId: string) => invoke<void>("cancel_batch_job", { jobId }),
};

export const fileService = {
  async chooseProjectFolder(): Promise<string | null> {
    if (!isTauri()) throw new Error("The project folder picker requires the Windows desktop app.");
    const selected = await openNativeDialog({ directory: true, multiple: false, title: "Choose consumer project folder" });
    return typeof selected === "string" ? selected : null;
  },
};

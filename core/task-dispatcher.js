'use strict';

/**
 * core/task-dispatcher.js
 * High-performance Workload Dispatcher & Control Plane Terminal for C3.
 * Supports:
 *  - Direct Kubernetes control plane execution (kubectl, k3s, helm, cluster diagnostics)
 *  - Direct local workspace file inspection (ls, cat, pwd, find, etc.)
 *  - Distributed multi-node container workloads across pooled machines
 */

const { getClusterNodes } = require('./k3s-cluster');
const Docker = require('dockerode');

const MASTER_CONTAINER_NAME = 'c3-k3s-master';
const WORKER_CONTAINER_NAME = 'c3-k3s-worker';

// Section D: overall job timeout (60 min, configurable)
const JOB_OVERALL_TIMEOUT_MS = 60 * 60 * 1000;
// Image pull wait (10 min)
const IMAGE_PULL_TIMEOUT_MS = 10 * 60 * 1000;

let _docker = null;
function getDocker() {
  if (!_docker) {
    _docker = new Docker(
      process.platform === 'win32'
        ? { socketPath: '//./pipe/docker_engine' }
        : { socketPath: '/var/run/docker.sock' }
    );
  }
  return _docker;
}

let activeExecutionProcess = null;

/**
 * Executes a command inside the master container cleanly and returns stdout.
 * Section D: On timeout, rejects with a clear error instead of silently resolving.
 * @param {object} container - Dockerode container.
 * @param {string|string[]} cmd - Command to run.
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function runInContainer(container, cmd, timeoutMs = 25000) {
  const docker = getDocker();
  const exec = await container.exec({
    Cmd: typeof cmd === 'string' ? ['/bin/sh', '-c', cmd] : cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    docker.modem.demuxStream(
      stream,
      { write: chunk => (stdoutBuf += chunk.toString('utf8')) },
      { write: chunk => (stderrBuf += chunk.toString('utf8')) }
    );
    stream.on('end', () => {
      if (!timedOut) resolve((stdoutBuf || stderrBuf).trim());
    });
    stream.on('error', reject);
    setTimeout(() => {
      timedOut = true;
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

const si = require('systeminformation');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

let _cachedContainerStats = {};
let _lastContainerStatsTime = 0;
let _statsQueryPromise = null;

async function getLiveContainerStats() {
  const now = Date.now();
  if (now - _lastContainerStatsTime < 8000 && Object.keys(_cachedContainerStats).length > 0) {
    return _cachedContainerStats;
  }
  if (_statsQueryPromise) return _statsQueryPromise;

  _statsQueryPromise = (async () => {
    try {
      const { stdout } = await execAsync('docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}"');
      const stats = {};
      stdout.trim().split('\n').forEach(line => {
        const parts = line.split('|');
        if (parts.length >= 5) {
          stats[parts[0].trim()] = {
            cpuPercent: parseFloat(parts[1].replace('%', '')) || 0,
            memUsage: parts[2].trim(),
            memPercent: parseFloat(parts[3].replace('%', '')) || 0,
            netIo: parts[4].trim(),
          };
        }
      });
      _cachedContainerStats = stats;
      _lastContainerStatsTime = Date.now();
      return stats;
    } catch {
      return _cachedContainerStats;
    } finally {
      _statsQueryPromise = null;
    }
  })();

  return _statsQueryPromise;
}

let _telemetryCache = null;
let _telemetryCacheTime = 0;
let _telemetryPending = null;

/**
 * Aggregates CPU, RAM, and GPU telemetry from all cluster nodes with real-time utilization.
 * Cached for 5s — prevents concurrent IPC calls from re-running all heavy shell commands.
 * @returns {Promise<{totalCores: number, totalRamGb: number, totalGpus: number, gpuModel: string, nodeCount: number, hostSystem: object, nodes: object[]}>}
 */
async function getAggregatedTelemetry() {
  const now = Date.now();
  // Return cached result if fresh
  if (_telemetryCache && now - _telemetryCacheTime < 5000) return _telemetryCache;
  // Deduplicate concurrent calls
  if (_telemetryPending) return _telemetryPending;

  _telemetryPending = (async () => {
    try {
      const [nodes, hostLoad, hostMem, containerStats] = await Promise.all([
        getClusterNodes(),
        si.currentLoad().catch(() => ({ currentLoad: 0 })),
    si.mem().catch(() => ({ used: 0, total: 0 })),
    getLiveContainerStats(),
  ]);

  // Query live discrete GPU stats dynamically
  let gpuInfo = {
    detected: false,
    name: 'None',
    vramGb: 0,
    gpuPercent: 0,
    memPercent: 0,
    temp: null,
  };

  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.total,memory.free --format=csv,noheader,nounits', { timeout: 1500 });
    const parts = stdout.trim().split(',').map(s => s.trim());
    if (parts.length >= 5 && parts[0]) {
      const gTotalMb = parseInt(parts[3], 10) || 0;
      const gFreeMb = parseInt(parts[4], 10) || 0;
      const gUsedMb = Math.max(0, gTotalMb - gFreeMb);
      gpuInfo = {
        detected: true,
        name: parts[0],
        vramGb: gTotalMb > 0 ? parseFloat((gTotalMb / 1024).toFixed(1)) : 0,
        gpuPercent: parseInt(parts[2], 10) || 0,
        memPercent: gTotalMb > 0 ? Math.round((gUsedMb / gTotalMb) * 100) : 0,
        temp: parseInt(parts[1], 10) || null,
      };
    }
  } catch {}

  let totalCores = 0;
  let totalRamGb = 0;
  let totalGpus = gpuInfo.detected ? 1 : 0;

  const nodeDetails = nodes.map((node, index) => {
    const name = node.metadata?.name || `Node-${index + 1}`;
    const labels = node.metadata?.labels || {};
    const isMaster = labels['node-role.kubernetes.io/control-plane'] !== undefined ||
                     labels['node-role.kubernetes.io/master'] !== undefined;
    const capacity = node.status?.capacity || {};
    const cpuCores = parseInt(capacity.cpu, 10) || 0;
    const memoryKi = parseInt(capacity.memory, 10) || 0;
    const ramGb = memoryKi > 0 ? parseFloat((memoryKi / 1048576).toFixed(1)) : 0;

    totalCores += cpuCores;
    totalRamGb += ramGb;

    const cStat = isMaster ? containerStats['c3-k3s-master'] : containerStats['c3-k3s-worker'];
    const addresses = node.status?.addresses || [];
    const internalIp = addresses.find(a => a.type === 'InternalIP')?.address || '';

    return {
      name,
      displayName: isMaster ? 'Control Plane (Master)' : `Worker Node (${name.slice(0, 12)})`,
      role: isMaster ? 'Master Node' : 'Compute Worker',
      isMaster,
      status: 'Ready',
      ip: internalIp,
      cores: cpuCores,
      ramGb: ramGb,
      cpuPercent: cStat ? cStat.cpuPercent : Math.round(hostLoad.currentLoad || 0),
      memPercent: cStat ? cStat.memPercent : (hostMem.total ? Math.round(((hostMem.used || 0) / hostMem.total) * 100) : 0),
      memUsage: cStat ? cStat.memUsage : (hostMem.total ? `${((hostMem.used || 0) / 1073741824).toFixed(1)}GB / ${(hostMem.total / 1073741824).toFixed(1)}GB` : ''),
      netIo: cStat ? cStat.netIo : 'P2P WireGuard Mesh',
      gpu: gpuInfo.detected ? gpuInfo.name : 'None',
      gpuPercent: gpuInfo.gpuPercent,
      gpuMemPercent: gpuInfo.memPercent,
      gpuTemp: gpuInfo.temp,
    };
  });

  // Ensure Control Plane is always Node 1, and Compute Workers follow
  nodeDetails.sort((a, b) => (b.isMaster ? 1 : 0) - (a.isMaster ? 1 : 0));

  const result = {
        totalCores: totalCores || (nodeDetails.length > 0 ? nodeDetails.reduce((a, n) => a + (n.cores || 0), 0) : 0),
        totalRamGb: parseFloat(totalRamGb.toFixed(1)) || (nodeDetails.length > 0 ? parseFloat(nodeDetails.reduce((a, n) => a + (n.ramGb || 0), 0).toFixed(1)) : 0),
        totalGpus: totalGpus,
        gpuModel: gpuInfo.detected ? `${gpuInfo.name} (${gpuInfo.vramGb}GB VRAM)` : 'None',
        nodeCount: nodeDetails.length,
        hostSystem: {
          cpuPercent: Math.round(hostLoad.currentLoad || 0),
          memUsedGb: hostMem.total ? parseFloat(((hostMem.used || 0) / 1073741824).toFixed(1)) : 0,
          memTotalGb: hostMem.total ? parseFloat(((hostMem.total || 0) / 1073741824).toFixed(1)) : 0,
          memPercent: hostMem.total ? Math.round(((hostMem.used || 0) / hostMem.total) * 100) : 0,
          gpuPercent: gpuInfo.gpuPercent,
          gpuMemPercent: gpuInfo.memPercent,
          gpuTemp: gpuInfo.temp,
          gpuName: gpuInfo.detected ? gpuInfo.name : 'None',
        },
        nodes: nodeDetails,
      };
      _telemetryCache = result;
      _telemetryCacheTime = Date.now();
      return result;
    } catch (err) {
      return _telemetryCache || { totalCores: 0, totalRamGb: 0, totalGpus: 0, nodeCount: 0, hostSystem: null, nodes: [] };
    } finally {
      _telemetryPending = null;
    }
  })();

  return _telemetryPending;
}


// Persistent working directories per target node
const nodeCwds = {
  'node-1': '/workspace',
  'node-2': '/workspace',
  'both': '/workspace',
  'pod': '/workspace',
};

function normalizeTarget(target) {
  if (!target) return 'node-1';
  const t = String(target).toLowerCase();
  if (t === 'pod' || t.includes('runner') || t.includes('workload')) return 'pod';
  if (t === 'both' || t === 'all') return 'both';
  if (t === 'node-2' || t.includes('worker')) return 'node-2';
  return 'node-1';
}

function getTargetContainers(targetKey) {
  const docker = getDocker();
  if (targetKey === 'node-2') {
    return [{ name: 'c3-self-worker', container: docker.getContainer(WORKER_CONTAINER_NAME) }];
  }
  if (targetKey === 'both') {
    return [
      { name: 'control-plane', container: docker.getContainer(MASTER_CONTAINER_NAME) },
      { name: 'c3-self-worker', container: docker.getContainer(WORKER_CONTAINER_NAME) },
    ];
  }
  return [{ name: 'control-plane', container: docker.getContainer(MASTER_CONTAINER_NAME) }];
}

/**
 * Section D: Resolve runner pod name for a specific node.
 * Uses the c3-runner DaemonSet label to find the pod on the requested node.
 * Falls back to the control-plane runner if no worker pod is found.
 * @param {object} masterContainer - Dockerode container
 * @param {string|null} preferredNode - node name, or null for first worker
 * @returns {Promise<{podName: string, nodeName: string}>}
 */
async function resolveRunnerPod(masterContainer, preferredNode) {
  try {
    const out = await runInContainer(
      masterContainer,
      `kubectl get pods -l app=c3-runner -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.nodeName}{"\\n"}{end}' 2>/dev/null`,
      8000
    );
    const entries = (out || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const parts = l.split(' ');
      return { podName: parts[0], nodeName: parts[1] };
    });

    if (entries.length === 0) {
      // Fallback: old single pod name
      return { podName: 'c3-worker-runner', nodeName: 'c3-control-plane' };
    }

    if (preferredNode) {
      const match = entries.find(e => e.nodeName === preferredNode);
      if (match) return match;
    }

    // Prefer non-control-plane runner
    const worker = entries.find(e => !e.nodeName.includes('control-plane') && !e.nodeName.includes('master'));
    if (worker) return worker;

    // Fall back to control-plane runner
    return entries[0];
  } catch (_) {
    return { podName: 'c3-worker-runner', nodeName: 'c3-control-plane' };
  }
}

/**
 * Dispatches an interactive shell command or distributed workload across cluster nodes.
 * Supports:
 *   - cd <dir> / cd .. / cd ~ with persistent cwd tracking
 *   - pwd, ls, cat, mkdir, rm, touch, ps, top, and any Linux command in active cwd
 *   - node shifting (node-1 / control-plane vs node-2 / c3-self-worker vs both)
 *   - kubectl / k3s / docker / crictl cluster administrative commands
 *   - explicit distributed job dispatching via `job <cmd>` or `c3 run <cmd>`
 */
async function dispatchWorkload({ target, command, onLog = () => {} }) {
  const targetKey = normalizeTarget(target);
  if (!nodeCwds[targetKey]) nodeCwds[targetKey] = '/workspace';
  let currentCwd = nodeCwds[targetKey] || '/workspace';

  const trimmed = (command || '').trim();
  if (!trimmed) {
    return { ok: true, cwd: currentCwd, target: targetKey };
  }

  // ── 1. cd Navigation (cd, cd .., cd /path, cd relative) ────────────────────
  if (/^cd(\s+.*)?$/i.test(trimmed)) {
    const rawDest = trimmed.replace(/^cd\s*/i, '').trim();
    const dest = (!rawDest || rawDest === '~') ? '/workspace' : rawDest;

    if (targetKey === 'pod') {
      const docker = getDocker();
      const masterContainer = docker.getContainer(MASTER_CONTAINER_NAME);
      try {
        const { podName } = await resolveRunnerPod(masterContainer, null);
        const out = await runInContainer(masterContainer, `kubectl exec ${podName} -- sh -c "cd '${currentCwd}' 2>/dev/null && cd ${dest} && pwd"`, 8000);
        const line = (out || '').split('\n').map(l => l.trim()).filter(Boolean).pop();
        if (line && line.startsWith('/')) {
          nodeCwds['pod'] = line;
          return { ok: true, cwd: line, target: targetKey };
        } else {
          onLog(`c3-runner: cd: ${dest}: No such file or directory`);
          return { ok: false, cwd: currentCwd, target: targetKey };
        }
      } catch (err) {
        onLog(`[c3-runner] [ERROR] ${err.message}`);
        return { ok: false, cwd: currentCwd, target: targetKey };
      }
    }

    const containers = getTargetContainers(targetKey);

    let newResolvedPath = null;
    let cdError = null;

    for (const { name, container } of containers) {
      try {
        const out = await runInContainer(container, `cd "${currentCwd}" 2>/dev/null && cd ${dest} && pwd`, 8000);
        const line = (out || '').split('\n').map(l => l.trim()).filter(Boolean).pop();
        if (line && line.startsWith('/')) {
          newResolvedPath = line;
        } else {
          cdError = out || `No such file or directory: ${dest}`;
        }
      } catch (err) {
        cdError = err.message;
      }
    }

    if (newResolvedPath) {
      nodeCwds[targetKey] = newResolvedPath;
      if (targetKey === 'both') {
        nodeCwds['node-1'] = newResolvedPath;
        nodeCwds['node-2'] = newResolvedPath;
      }
      return { ok: true, cwd: newResolvedPath, target: targetKey };
    } else {
      onLog(`sh: cd: can't cd to ${dest}: No such file or directory`);
      return { ok: false, cwd: currentCwd, target: targetKey };
    }
  }

  // ── 2. pwd Command ────────────────────────────────────────────────────────
  if (trimmed === 'pwd') {
    onLog(currentCwd);
    return { ok: true, cwd: currentCwd, target: targetKey };
  }

  // ── 3. Direct Kubernetes / Cluster Admin Commands ───────────────────────────
  if (/^(kubectl|k3s|docker|helm|crictl)\b/i.test(trimmed)) {
    const docker = getDocker();
    const container = docker.getContainer(MASTER_CONTAINER_NAME);
    try {
      const output = await runInContainer(container, trimmed, 30000);
      if (output) {
        output.split('\n').forEach(line => onLog(line));
      }
      return { ok: true, cwd: currentCwd, target: targetKey };
    } catch (err) {
      onLog(`[ERROR] ${err.message}`);
      return { ok: false, cwd: currentCwd, target: targetKey, error: err.message };
    }
  }

  // ── 4. Explicit Workload / Distributed Job Dispatch (job ..., c3 run ..., python ...) ──
  // NOTE: if target=pod, skip job dispatch — run directly via kubectl exec into c3-runner
  if (targetKey !== 'pod' && /^(job|c3\s+run|workload|python3?)\b/i.test(trimmed)) {
    const jobCmd = trimmed.replace(/^(job|c3\s+run|workload)\s*/i, '').trim();
    return await runDistributedPodJob({ targetKey, cleanCmd: jobCmd, currentCwd, onLog });
  }

  // ── 5. Node Switching via Terminal (node 1, node 2, node all, worker, master, pod, runner)
  if (/^(node\s+[12]|node\s+all|node\s+both|worker|master|control-plane|pod|runner)\b/i.test(trimmed)) {
    let nextTarget = 'node-1';
    if (/pod|runner/i.test(trimmed)) nextTarget = 'pod';
    else if (/2|worker/i.test(trimmed)) nextTarget = 'node-2';
    else if (/all|both/i.test(trimmed)) nextTarget = 'both';
    const nextCwd = nodeCwds[nextTarget] || '/workspace';
    const label = nextTarget === 'pod' ? 'Workload Pod (c3-runner)' : nextTarget === 'node-2' ? 'Node 2 (Worker)' : nextTarget === 'both' ? 'All Nodes (Parallel)' : 'Node 1 (Control Plane)';
    onLog(`[c3] Active target switched to: ${label}`);
    return { ok: true, cwd: nextCwd, target: nextTarget, switchTarget: nextTarget };
  }

  // ── 6. Standard Interactive Shell Command on Target Node(s) / Pod ──────────
  let cleanCmd = trimmed;
  if (/^[A-Za-z]:\\/.test(cleanCmd)) {
    cleanCmd = `ls -lh`;
  }

  // If targeting dedicated workload Pod
  if (targetKey === 'pod') {
    const docker = getDocker();
    const masterContainer = docker.getContainer(MASTER_CONTAINER_NAME);
    try {
      const { podName, nodeName } = await resolveRunnerPod(masterContainer, null);
      const output = await runInContainer(masterContainer, `kubectl exec ${podName} -- sh -c "cd '${currentCwd}' && ${cleanCmd}"`, 45000);
      if (output) {
        output.split('\n').forEach(line => onLog(line));
      }
    } catch (err) {
      onLog(`[c3-runner] [ERROR] ${err.message}`);
    }
    return { ok: true, cwd: currentCwd, target: targetKey };
  }

  if (targetKey === 'both') {
    const docker = getDocker();
    const masterContainer = docker.getContainer(MASTER_CONTAINER_NAME);
    // Section D/E9: resolve runner pod per node and label with real node name
    const nodes = await getClusterNodes().catch(() => []);
    // Run on control plane container directly
    try {
      const outMaster = await runInContainer(masterContainer, `cd "${currentCwd}" && ${cleanCmd}`, 30000);
      if (outMaster) {
        outMaster.split('\n').forEach(line => onLog(`[control-plane] ${line}`));
      }
    } catch (err) {
      onLog(`[control-plane] [ERROR] ${err.message}`);
    }
    // Run on each non-control-plane runner pod
    try {
      const out = await runInContainer(masterContainer,
        `kubectl get pods -l app=c3-runner -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.nodeName}{"\\n"}{end}' 2>/dev/null`,
        8000
      );
      const runnerPods = (out || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const p = l.split(' ');
        return { podName: p[0], nodeName: p[1] };
      }).filter(e => e.nodeName && !e.nodeName.includes('control-plane'));

      for (const { podName, nodeName } of runnerPods) {
        try {
          const podOut = await runInContainer(masterContainer, `kubectl exec ${podName} -- sh -c "cd '${currentCwd}' && ${cleanCmd}"`, 30000);
          if (podOut) {
            podOut.split('\n').forEach(line => onLog(`[${nodeName}] ${line}`));
          }
        } catch (err) {
          onLog(`[${nodeName}] [ERROR] ${err.message}`);
        }
      }
    } catch (err) {
      onLog(`[worker] [ERROR] ${err.message}`);
    }
    return { ok: true, cwd: currentCwd, target: 'both' };
  }

  const containers = getTargetContainers(targetKey);
  for (const { name, container } of containers) {
    try {
      const output = await runInContainer(container, `cd "${currentCwd}" && ${cleanCmd}`, 30000);
      if (output) {
        output.split('\n').forEach(line => onLog(line));
      }
    } catch (err) {
      onLog(`[${name}] [ERROR] ${err.message}`);
    }
  }

  return { ok: true, cwd: currentCwd, target: targetKey };
}

/**
 * Section D: Runs a distributed pod job with proper lifecycle management.
 * 1. Applies the pod (with base64-encoded command to avoid shell injection).
 * 2. Waits up to 10 min for image pull (Pending -> Running).
 * 3. Streams logs live via kubectl logs -f.
 * 4. Reads final phase and exit code.
 * 5. Deletes the pod (no --force).
 * 6. Runs "both" targets in parallel with Promise.all.
 */
async function runDistributedPodJob({ targetKey, cleanCmd, currentCwd, onLog }) {
  const docker = getDocker();
  const masterContainer = docker.getContainer(MASTER_CONTAINER_NAME);
  const nodes = await getClusterNodes();
  const nodeNames = nodes.map(n => n.metadata?.name).filter(Boolean);

  if (nodeNames.length === 0) {
    onLog(`[ERROR] No active compute nodes found in the cluster.`);
    return { ok: false, cwd: currentCwd, target: targetKey };
  }

  const masterNode = nodes.find(n =>
    n.metadata?.labels?.['node-role.kubernetes.io/control-plane'] !== undefined ||
    n.metadata?.labels?.['node-role.kubernetes.io/master'] !== undefined
  ) || nodes[0];
  const masterNodeName = masterNode?.metadata?.name || nodeNames[0];

  const targets = [];
  if (targetKey === 'node-1') {
    targets.push(masterNodeName);
  } else if (targetKey === 'node-2') {
    const workerNode = nodeNames.find(name => name !== masterNodeName) || masterNodeName;
    targets.push(workerNode);
  } else {
    targets.push(...nodeNames);
  }

  onLog(`[dispatcher] Launching job across: ${targets.join(', ')}`);

  // Section D: run "both" in parallel
  const runOneNode = async (nodeName) => {
    const podId = `c3-job-${Math.random().toString(36).substring(2, 7)}`;
    onLog(`[node:${nodeName}] Submitting job pod: ${podId}...`);

    let runnerImage = 'alpine:latest';
    if (/python/i.test(cleanCmd)) runnerImage = 'python:3.10-slim';
    else if (/rust|cargo/i.test(cleanCmd)) runnerImage = 'rust:latest';
    else if (/node|npm/i.test(cleanCmd)) runnerImage = 'node:20-slim';

    // Section D: base64-encode command to avoid shell injection issues
    const fullCmd = `cd ${currentCwd} 2>/dev/null || cd /workspace 2>/dev/null || cd /; ${cleanCmd}`;
    const b64Cmd = Buffer.from(fullCmd).toString('base64');

    const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: ${podId}
spec:
  nodeName: "${nodeName}"
  restartPolicy: Never
  containers:
    - name: runner
      image: ${runnerImage}
      command: ["/bin/sh", "-c"]
      args:
        - "echo ${b64Cmd} | base64 -d | sh"
      volumeMounts:
        - name: workspace-vol
          mountPath: /workspace
  volumes:
    - name: workspace-vol
      hostPath:
        path: /workspace`.trim();

    try {
      // Apply the pod
      await runInContainer(masterContainer, `cat <<'EOF' | kubectl apply -f -\n${podYaml}\nEOF`, 10000);

      // Section D step 2: Wait up to 10 min for phase to leave Pending (image pull)
      const pullDeadline = Date.now() + IMAGE_PULL_TIMEOUT_MS;
      let phase = '';
      let lastLoggedPhase = '';
      while (Date.now() < pullDeadline) {
        phase = await runInContainer(masterContainer, `kubectl get pod ${podId} -o jsonpath='{.status.phase}' 2>/dev/null`, 4000).catch(() => '');
        phase = (phase || '').replace(/'/g, '').trim();

        if (phase === 'Running' || phase === 'Succeeded' || phase === 'Failed') break;

        // Check for image pull errors
        const containerStatus = await runInContainer(masterContainer,
          `kubectl get pod ${podId} -o jsonpath='{.status.containerStatuses[0].state.waiting.reason}' 2>/dev/null`, 4000
        ).catch(() => '');
        const reason = (containerStatus || '').replace(/'/g, '').trim();
        if (reason === 'ErrImagePull' || reason === 'ImagePullBackOff') {
          onLog(`✗ [node:${nodeName}] Image pull failed (${reason}). Check image name: ${runnerImage}`);
          await runInContainer(masterContainer, `kubectl delete pod ${podId} --ignore-not-found 2>/dev/null`, 5000).catch(() => {});
          return;
        }

        if (phase !== lastLoggedPhase) {
          onLog(`[node:${nodeName}] waiting for image pull... (${phase || 'pending'})`);
          lastLoggedPhase = phase;
        }
        await new Promise(r => setTimeout(r, 10000));
      }

      if (phase !== 'Running' && phase !== 'Succeeded' && phase !== 'Failed') {
        onLog(`✗ [node:${nodeName}] Image pull timed out after 10 minutes.`);
        await runInContainer(masterContainer, `kubectl delete pod ${podId} --ignore-not-found 2>/dev/null`, 5000).catch(() => {});
        return;
      }

      // Section D step 3: Stream logs live with kubectl logs -f
      if (phase === 'Running') {
        onLog(`[node:${nodeName}] Job running — streaming logs...`);
        await streamPodLogs(masterContainer, podId, nodeName, onLog);
      }

      // Section D step 4: Read final phase and exit code
      const finalPhase = await runInContainer(masterContainer, `kubectl get pod ${podId} -o jsonpath='{.status.phase}' 2>/dev/null`, 4000).catch(() => '');
      const exitCodeStr = await runInContainer(masterContainer,
        `kubectl get pod ${podId} -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}' 2>/dev/null`, 4000
      ).catch(() => '');
      const exitCode = parseInt((exitCodeStr || '').replace(/'/g, '').trim(), 10);

      if (exitCode === 0 || finalPhase === 'Succeeded') {
        onLog(`✓ [node:${nodeName}] Job completed (exit 0)`);
      } else {
        onLog(`✗ [node:${nodeName}] Job failed (exit ${isNaN(exitCode) ? '?' : exitCode})`);
      }

      // Section D step 5: Delete pod without --force
      await runInContainer(masterContainer, `kubectl delete pod ${podId} --ignore-not-found 2>/dev/null`, 10000).catch(() => {});
    } catch (err) {
      onLog(`✗ [node:${nodeName}] Error: ${err.message}`);
    }
  };

  // Section D step 6: run in parallel for "both"
  if (targetKey === 'both' || targets.length > 1) {
    await Promise.all(targets.map(nodeName => runOneNode(nodeName)));
  } else {
    for (const nodeName of targets) {
      await runOneNode(nodeName);
    }
  }

  return { ok: true, cwd: currentCwd, target: targetKey };
}

/**
 * Section D: Stream pod logs live with kubectl logs -f using a Dockerode exec stream.
 * Each line is pushed to onLog as it arrives. Overall timeout: JOB_OVERALL_TIMEOUT_MS.
 * @param {object} masterContainer
 * @param {string} podId
 * @param {string} nodeLabel - label prefix for each log line
 * @param {function} onLog
 */
async function streamPodLogs(masterContainer, podId, nodeLabel, onLog) {
  return new Promise(async (resolve) => {
    const docker = getDocker();
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };

    const overallTimer = setTimeout(() => {
      onLog(`[node:${nodeLabel}] Job log stream timed out after ${JOB_OVERALL_TIMEOUT_MS / 60000} minutes.`);
      done();
    }, JOB_OVERALL_TIMEOUT_MS);

    try {
      const execObj = await masterContainer.exec({
        Cmd: ['/bin/sh', '-c', `kubectl logs -f ${podId} 2>/dev/null`],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await execObj.start({ hijack: true, stdin: false });

      let lineBuf = '';
      const handleChunk = (chunk) => {
        const text = chunk.toString('utf8');
        lineBuf += text;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          onLog(`[${nodeLabel}] ${line}`);
        }
      };

      docker.modem.demuxStream(
        stream,
        { write: handleChunk },
        { write: handleChunk }
      );

      stream.on('end', () => {
        // Flush remaining buffer
        if (lineBuf.trim()) onLog(`[${nodeLabel}] ${lineBuf}`);
        clearTimeout(overallTimer);
        done();
      });
      stream.on('error', () => {
        clearTimeout(overallTimer);
        done();
      });
    } catch (err) {
      onLog(`[node:${nodeLabel}] Log stream error: ${err.message}`);
      clearTimeout(overallTimer);
      done();
    }
  });
}

module.exports = {
  getAggregatedTelemetry,
  dispatchWorkload,
};

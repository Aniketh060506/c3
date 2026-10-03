'use strict';

/**
 * core/cluster-orchestrator.js
 * Phase 4: Consumer Studio Distributed Cluster Orchestrator for C3
 * Manages:
 *  - P2P LAN UDP + DynamoDB Cloud Node Discovery
 *  - Local folder picker & workspace validator
 *  - 1-Click K3s Supercomputer Control Plane deployment
 *  - Provider node dispatch & handshake
 *  - Live cluster node inspector & telemetry
 */

const dgram = require('dgram');
const http = require('http');
const net = require('net');
const { exec, spawn } = require('child_process');

function probeHostLatency(host, port = 44344, timeout = 400) {
  return new Promise((resolve) => {
    if (!host || host === '127.0.0.1') return resolve(null);
    const start = Date.now();
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(timeout);

    socket.on('connect', () => {
      if (!done) {
        done = true;
        const lat = Date.now() - start;
        socket.destroy();
        resolve(lat);
      }
    });

    const onFail = () => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(null);
      }
    };

    socket.on('error', onFail);
    socket.on('timeout', onFail);
    socket.connect(port, host);
  });
}

function sendProviderInvitation(host, payload, timeout = 3000) {
  return new Promise((resolve) => {
    if (!host) return resolve({ ok: false, error: 'No reachable provider address is available.' });
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: host,
      port: 44344,
      path: '/session/join',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout,
    }, response => {
      let responseBody = '';
      response.on('data', chunk => {
        responseBody += chunk.toString();
        if (responseBody.length > 16384) req.destroy(new Error('Provider response exceeded the allowed size.'));
      });
      response.on('end', () => {
        try {
          const result = JSON.parse(responseBody);
          resolve(response.statusCode >= 200 && response.statusCode < 300 && result.ok
            ? { ok: true, host, status: result.status || 'DELIVERED' }
            : { ok: false, host, error: result.error || `Provider returned HTTP ${response.statusCode}.` });
        } catch (_) {
          resolve({ ok: false, host, error: `Provider returned HTTP ${response.statusCode} with an invalid response.` });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Provider invitation timed out.')));
    req.on('error', err => resolve({ ok: false, host, error: err.message }));
    req.end(body);
  });
}

function sendProviderStop(host, payload, timeout = 1500) {
  return new Promise(resolve => {
    if (!host) return resolve(false);
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: host,
      port: 44344,
      path: '/session/stop',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout,
    }, response => {
      let responseBody = '';
      response.on('data', chunk => { responseBody += chunk.toString(); });
      response.on('end', () => {
        try {
          const result = JSON.parse(responseBody);
          resolve(response.statusCode >= 200 && response.statusCode < 300 && result.ok === true);
        } catch (_) { resolve(false); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { dialog } = require('electron');

const dynamodb = require('./dynamodb');
const hardware = require('./hardware');
const setupChecker = require('./setup-checker');

const execAsync = promisify(exec);

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(stderr.trim() || `${command} exited with code ${code}`)));
  });
}

const UDP_PORT = 44345;
let _clusterState = null;
let _discoveredNodesCache = [];
let _ipcCallback = null;

function setIpcCallback(cb) {
  _ipcCallback = cb;
}

function notifyUI(channel, data) {
  if (_ipcCallback && typeof _ipcCallback === 'function') {
    try {
      _ipcCallback(channel, data);
    } catch (_) {}
  }
}

// ── 1. Discover Nodes (Dual Channel: LAN UDP + DynamoDB Cloud) ──────────────
async function discoverNodes() {
  const specs = await hardware.getHardwareSpecs();
  const live = await hardware.getLiveStats();
  const tailscale = await setupChecker.checkTailscale();

  const selfIp = live.network.ip;
  const selfMeshIp = tailscale.running ? tailscale.ip : null;

  const foundMap = new Map();

  // Always include Local Host
  foundMap.set('self-node', {
    id: 'self-node',
    hostname: `${specs.hostname || os.hostname()} (Local Host)`,
    isSelf: true,
    cpuModel: specs.cpuModel,
    cores: specs.cpuCores,
    physicalCores: specs.cpuPhysicalCores,
    ramGb: specs.ramUsableGb,
    ramType: specs.ramType,
    gpu: specs.gpuModel !== 'None' ? specs.gpuModel : null,
    gpuVramGb: specs.gpuVramGb || 0,
    ip: selfIp,
    meshIp: selfMeshIp,
    latencyMs: null,
    status: 'READY',
    source: 'local',
  });

  // 1. Gather UDP LAN Beacons for slightly longer than the 3-second broadcast interval.
  await new Promise(resolve => {
    let client = null;
    try {
      client = dgram.createSocket('udp4');
      client.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'c3-beacon' && data.hostname !== specs.hostname) {
            const nodeId = data.userId || `lan-${rinfo.address}`;
            foundMap.set(nodeId, {
              id: nodeId,
              hostname: data.hostname || 'LAN Peer',
              isSelf: false,
              cpuModel: data.cpuModel || null,
              cores: finiteOrNull(data.cores),
              physicalCores: finiteOrNull(data.physicalCores),
              ramGb: finiteOrNull(data.ramGb),
              ramType: data.ramType || 'Unknown',
              gpu: data.gpu !== 'None' ? data.gpu : null,
              gpuVramGb: finiteOrNull(data.gpuVramGb),
              ip: rinfo.address,
              localIp: data.localIp || rinfo.address,
              meshIp: data.meshIp,
              latencyMs: null,
              status: data.status || 'ACTIVE',
              source: 'lan',
            });
          }
        } catch (_) {}
      });

      client.bind(UDP_PORT, () => {
        setTimeout(() => {
          try { client.close(); } catch (_) {}
          resolve();
        }, 3200);
      });
    } catch (_) {
      resolve();
    }
  });

  // 2. Query DynamoDB Cloud Registry
  try {
    const cloudProviders = await dynamodb.getActiveProviders();
    for (const p of cloudProviders) {
      if (p.hostname !== specs.hostname && p.userId) {
        const existing = foundMap.get(p.userId);
        if (!existing) {
          foundMap.set(p.userId, {
            id: p.userId,
            hostname: p.hostname || 'Cloud Peer',
            isSelf: false,
            cpuModel: p.cpuModel || null,
            cores: finiteOrNull(p.coresOffered),
            physicalCores: finiteOrNull(p.physicalCores),
            ramGb: finiteOrNull(p.ramOfferedGb),
            ramType: p.ramType || 'Unknown',
            gpu: p.gpuModel && p.gpuModel !== 'None' ? p.gpuModel : null,
            gpuVramGb: finiteOrNull(p.gpuVramGb),
            ip: p.tailscaleIp || p.localIp,
            localIp: p.localIp || null,
            meshIp: p.tailscaleIp,
            latencyMs: null,
            status: 'ACTIVE',
            source: 'cloud',
          });
        }
      }
    }
  } catch (err) {
    console.warn('[orchestrator] Cloud discovery notice:', err.message);
  }

  // 3. Measure Real Ping Latency for All Remote Nodes
  for (const node of foundMap.values()) {
    if (!node.isSelf) {
      const targetHosts = [...new Set([node.meshIp, node.localIp, node.ip].filter(Boolean))];
      let connected = false;
      for (const targetHost of targetHosts) {
        const realLat = await probeHostLatency(targetHost, 44344, 700);
        if (realLat !== null) {
          node.latencyMs = realLat;
          node.connectionIp = targetHost;
          connected = true;
          break;
        }
      }
      if (!connected) node.status = 'UNREACHABLE';
    }
  }

  _discoveredNodesCache = Array.from(foundMap.values());
  return _discoveredNodesCache;
}

// ── 2. Select Workspace Folder ───────────────────────────────────────────────
async function pickWorkspaceFolder(browserWindow) {
  const result = await dialog.showOpenDialog(browserWindow, {
    properties: ['openDirectory', 'dontAddToRecent'],
    title: 'Select AI / Python Project Workspace Folder',
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const folderPath = result.filePaths[0];
  let fileCount = 0;
  let pyFiles = [];
  let hasRequirements = false;

  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        fileCount++;
        if (entry.name.endsWith('.py')) pyFiles.push(entry.name);
        if (entry.name.toLowerCase() === 'requirements.txt') hasRequirements = true;
      }
    }
  } catch (_) {}

  return {
    folderPath,
    folderName: path.basename(folderPath),
    fileCount,
    pyFiles,
    hasRequirements,
  };
}

// ── 3. Start K3s Supercomputer Cluster ──────────────────────────────────────
async function startCluster({ selectedNodes = [], workspacePath, userId, consumerName }) {
  const knownStatus = await getClusterStatus();
  if (knownStatus.status === 'ACTIVE') return knownStatus;
  try {
    const { stdout } = await execAsync('docker inspect --format "{{.State.Running}}" c3-k3s-master');
    if (stdout.trim() === 'true') {
      throw new Error('A C3 K3s master container is already running but is not Ready. Inspect its status before replacing it.');
    }
  } catch (err) {
    if (err.message.includes('already running')) throw err;
  }

  console.log('[orchestrator] Launching K3s cluster with workspace:', workspacePath);

  const specs = await hardware.getHardwareSpecs();
  const live = await hardware.getLiveStats();

  const clusterToken = `c3-token-${crypto.randomBytes(8).toString('hex')}`;
  const localNode = selectedNodes.find(node => node.isSelf || node.id === 'self-node');
  const localCores = Math.max(1, Number(localNode?.cores || Math.max(1, specs.cpuCores - 2)));
  const localRamGb = Math.max(1, Number(localNode?.ramGb || Math.max(1, Math.floor(specs.ramUsableGb - 4))));
  const tailscale = await setupChecker.checkTailscale();
  const masterIp = tailscale.running ? tailscale.ip : live.network.ip;
  if (!masterIp || masterIp === 'Disconnected') {
    throw new Error('No reachable host address is available. Connect Tailscale or join a network before starting K3s.');
  }
  const docker = await setupChecker.checkDocker();
  if (!docker.running) throw new Error('Docker Desktop Linux engine is not running. Start Docker Desktop, then retry.');
  const dockerRamGb = Number(docker.memoryTotal || 0) / (1024 ** 3);
  const maxLocalCores = Math.max(1, Math.min(Number(specs.cpuCores || 1) - 1, Number(docker.cpus || 1) - 1));
  const maxLocalRamGb = Math.max(1, Math.floor(Math.min(Number(specs.ramUsableGb || 1), dockerRamGb || Number(specs.ramUsableGb || 1)) - 1));
  if (localRamGb < 2 || localCores > maxLocalCores || localRamGb > maxLocalRamGb) {
    throw new Error(`Choose 1–${maxLocalCores} CPU threads and 2–${maxLocalRamGb} GB RAM within Docker's effective capacity.`);
  }

  notifyUI('cluster:status-update', { step: 'PREPARING', message: 'Stopping existing containers...' });

  // 1. Clean up existing master container
  try {
    await execAsync('docker rm -f c3-k3s-master');
  } catch (_) {}

  notifyUI('cluster:status-update', { step: 'STARTING_MASTER', message: 'Deploying K3s Master Control Plane...' });

  // 2. Launch K3s Master Server with TLS SAN for all interfaces
  if (!workspacePath || !fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
    throw new Error('Choose an existing workspace directory before starting the cluster.');
  }
  const normalizedPath = path.resolve(workspacePath).replace(/\\/g, '/');
  const corePath = path.resolve(__dirname).replace(/\\/g, '/');

  const tlsSanFlags = [
    `--tls-san=${masterIp}`,
    '--tls-san=127.0.0.1',
    '--tls-san=localhost',
  ];
  if (specs.tailscaleIp && specs.tailscaleIp !== masterIp) {
    tlsSanFlags.push(`--tls-san=${specs.tailscaleIp}`);
  }
  if (live.network.ip && live.network.ip !== masterIp) {
    tlsSanFlags.push(`--tls-san=${live.network.ip}`);
  }

  const masterArgs = [
    'run', '-d', '--privileged',
    '--cpus', String(localCores), '-m', `${localRamGb}g`,
    '--name', 'c3-k3s-master',
    '-p', '6443:6443',
    '-p', '8472:8472/udp',
    '-p', '127.0.0.1:8265:8265',
    '-e', `K3S_TOKEN=${clusterToken}`,
    '-e', 'K3S_KUBECONFIG_OUTPUT=/output/kubeconfig.yaml',
    '-v', `${normalizedPath}:/workspace`,
    '-v', `${corePath}:/c3-core:ro`,
    'rancher/k3s:v1.36.4-k3s1', 'server',
    '--bind-address=0.0.0.0',
    // Let K3s advertise the container's reachable internal address to
    // Kubernetes services. `masterIp` is the Windows host address used by
    // remote agents and must only be the node's external address.
    `--node-external-ip=${masterIp}`,
    '--flannel-backend=vxlan',
    '--flannel-external-ip',
    '--node-label', `c3.io/allocated-cores=${localCores}`,
    '--node-label', `c3.io/allocated-memory-gb=${localRamGb}`,
    ...tlsSanFlags,
    '--disable=traefik',
    '--disable=servicelb'
  ];

  console.log('[orchestrator] Launching K3s master with argument-safe Docker invocation.');
  await runProcess('docker', masterArgs);

  // 3. Poll until K3s master is ready
  notifyUI('cluster:status-update', { step: 'WAITING_READY', message: 'Verifying Kubernetes API server...' });
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const { stdout } = await execAsync('docker exec c3-k3s-master kubectl get nodes -o json');
      const nodeList = JSON.parse(stdout);
      if ((nodeList.items || []).some(node =>
        (node.status?.conditions || []).some(condition => condition.type === 'Ready' && condition.status === 'True')
      )) {
        ready = true;
        break;
      }
    } catch (_) {}
  }

  if (!ready) {
    throw new Error('K3s Master API server timed out after 30 seconds.');
  }

  // 4. Dispatch invitations to remote Provider nodes
  const remoteNodes = selectedNodes.filter(n => !n.isSelf && n.id !== 'self-node');
  const invitationResults = [];
  if (remoteNodes.length > 0) {
    notifyUI('cluster:status-update', { 
      step: 'INVITING_PROVIDERS', 
      message: `Dispatching cluster tokens to ${remoteNodes.length} provider node(s)...` 
    });

    for (const node of remoteNodes) {
      const targetIp = node.connectionIp || node.meshIp || node.ip;
      const sessionId = `sess-${crypto.randomBytes(6).toString('hex')}`;

      const invitation = {
        sessionId,
        consumerId: userId || 'local-consumer',
        providerId: node.id,
        consumerName: consumerName || specs.hostname,
        masterIp,
        clusterToken,
        cores: node.cores,
        ramGb: node.ramGb,
        gpuEnabled: !!node.gpu,
        workerNodeIp: node.connectionIp || node.meshIp || node.localIp || node.ip,
      };

      // Prefer a confirmed direct LAN/Tailscale endpoint. Use the cloud queue
      // only when the direct provider RPC did not acknowledge delivery.
      const isTailscaleTransport = tailscale.running && node.meshIp && targetIp === node.meshIp;
      let chatAvailable = false;
      if (isTailscaleTransport) {
        try {
          await dynamodb.createSessionRequest({
            sessionId,
            consumerId: invitation.consumerId,
            consumerName: invitation.consumerName,
            providerId: node.id,
            providerName: node.hostname,
            masterIp,
            cores: node.cores,
            ramGb: node.ramGb,
            gpuEnabled: invitation.gpuEnabled,
            status: 'DIRECT_SENT',
            workerStatus: 'REQUESTED',
            createdAt: Math.floor(Date.now() / 1000),
          });
          chatAvailable = true;
        } catch (err) {
          console.warn('[orchestrator] Request chat metadata could not be saved:', err.message);
        }
      }
      const directResult = isTailscaleTransport
        ? await sendProviderInvitation(targetIp, invitation)
        : { ok: false, error: 'Session credentials are sent directly only over Tailscale; using the TLS-protected cloud queue for this LAN peer.' };
      if (directResult.ok) {
        invitationResults.push({ nodeId: node.id, hostname: node.hostname, sessionId, channel: 'tailscale', chatAvailable, ...directResult });
      } else {
        try {
          await dynamodb.createSessionRequest({
          sessionId,
          consumerId: userId || 'local-consumer',
          consumerName: consumerName || specs.hostname,
          providerId: node.id,
          masterIp,
          clusterToken,
          cores: node.cores,
          ramGb: node.ramGb,
          status: 'PENDING',
          workerStatus: 'REQUESTED',
          createdAt: Math.floor(Date.now() / 1000),
          });
          invitationResults.push({ nodeId: node.id, hostname: node.hostname, sessionId, channel: 'cloud', chatAvailable: true, ok: true, message: 'Queued in DynamoDB after direct connection failed.' });
        } catch (err) {
          invitationResults.push({ nodeId: node.id, hostname: node.hostname, sessionId, channel: 'none', ok: false, error: `${directResult.error} Cloud queue failed: ${err.message}` });
        }
      }
    }

    // 5. Await verified worker joins
    notifyUI('cluster:status-update', { 
      step: 'AWAITING_WORKERS', 
      message: `Awaiting connection confirmation from ${remoteNodes.length} worker node(s)...` 
    });
  }

  let joinedCount = 0;
  if (remoteNodes.length > 0) {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const { stdout } = await execAsync('docker exec c3-k3s-master kubectl get nodes -o json');
        const parsed = JSON.parse(stdout);
        const nodeItems = parsed.items || [];
        joinedCount = nodeItems.filter(node => {
          const isControlPlane = node.metadata?.labels?.['node-role.kubernetes.io/control-plane'] !== undefined
            || node.metadata?.labels?.['node-role.kubernetes.io/master'] !== undefined;
          const isReady = (node.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True');
          return !isControlPlane && isReady;
        }).length;
        if (joinedCount >= remoteNodes.length) break;
      } catch (_) {}
    }
  }

  const clusterMode = joinedCount > 0 
    ? 'POOLED_CLUSTER' 
    : (remoteNodes.length > 0 ? 'STANDALONE_MASTER' : 'LOCAL_MASTER');

  _clusterState = {
    status: 'ACTIVE',
    mode: clusterMode,
    joinedWorkerCount: joinedCount,
    masterIp,
    clusterToken,
    workspacePath,
    selectedNodes,
    invitationResults,
    tailscaleTransport: tailscale.running,
    startTime: Date.now(),
  };

  const statusMsg = joinedCount > 0
    ? `Cluster online! ${joinedCount} remote worker node(s) verified and joined.`
    : (remoteNodes.length > 0 
        ? `Local master online. Note: 0 of ${remoteNodes.length} remote nodes joined (running standalone).` 
        : `Local master control plane active and ready for workloads.`);

  notifyUI('cluster:status-update', { step: 'ACTIVE', mode: clusterMode, message: statusMsg });
  return _clusterState;
}

// ── 4. Get Live Cluster Status ──────────────────────────────────────────────
async function getClusterStatus() {
  if (!_clusterState || _clusterState.status !== 'ACTIVE') {
    try {
      const [{ stdout: running }, { stdout: startedAt }, { stdout: nodeOutput }, { stdout: mountsOutput }] = await Promise.all([
        execAsync('docker inspect --format "{{.State.Running}}" c3-k3s-master'),
        execAsync('docker inspect --format "{{.State.StartedAt}}" c3-k3s-master'),
        execAsync('docker exec c3-k3s-master kubectl get nodes -o json'),
        execAsync('docker inspect --format "{{json .Mounts}}" c3-k3s-master'),
      ]);
      if (running.trim() === 'true') {
        const parsed = JSON.parse(nodeOutput);
        const nodes = (parsed.items || []).map(item => {
          const condition = (item.status?.conditions || []).find(entry => entry.type === 'Ready');
          const labels = item.metadata?.labels || {};
          return {
            name: item.metadata?.name,
            ready: condition?.status === 'True',
            role: labels['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane' : 'worker',
            cpu: item.status?.capacity?.cpu || null,
            memory: item.status?.capacity?.memory || null,
            gpu: item.status?.capacity?.['nvidia.com/gpu'] ? Number(item.status.capacity['nvidia.com/gpu']) : 0,
          };
        });
        const controlReady = nodes.some(node => node.ready && node.role === 'control-plane');
        if (controlReady) {
          const workers = nodes.filter(node => node.ready && node.role !== 'control-plane');
          let workspacePath = null;
          try {
            const mounts = JSON.parse(mountsOutput);
            workspacePath = mounts.find(mount => mount.Destination === '/workspace')?.Source || null;
          } catch (_) {}
          _clusterState = {
            status: 'ACTIVE',
            adopted: true,
            mode: workers.length ? 'POOLED_CLUSTER' : 'LOCAL_MASTER',
            selectedNodes: [],
            invitationResults: [],
            clusterToken: null,
            masterIp: null,
            workspacePath,
            startTime: Date.parse(startedAt.trim()) || Date.now(),
          };
          console.log('[orchestrator] Adopted the existing ready C3 K3s master.');
        }
      }
    } catch (_) {}
    if (!_clusterState || _clusterState.status !== 'ACTIVE') return { status: 'INACTIVE', nodes: [] };
  }

  let nodes = [];
  let apiResponded = false;
  try {
    const { stdout } = await execAsync('docker exec c3-k3s-master kubectl get nodes -o json');
    const parsed = JSON.parse(stdout);
    apiResponded = true;
    nodes = (parsed.items || []).map(item => {
      const conditions = item.status?.conditions || [];
      const readyCond = conditions.find(c => c.type === 'Ready');
      const capacity = item.status?.capacity || {};
      const labels = item.metadata?.labels || {};
      const role = labels['node-role.kubernetes.io/control-plane'] !== undefined
        ? 'control-plane'
        : labels['node-role.kubernetes.io/master'] !== undefined
          ? 'master'
          : 'worker';
      return {
        name: item.metadata?.name,
        ready: readyCond?.status === 'True',
        role,
        cpu: capacity.cpu || null,
        memory: capacity.memory || null,
        gpu: capacity['nvidia.com/gpu'] ? parseInt(capacity['nvidia.com/gpu'], 10) : 0,
      };
    });
  } catch (_) {}

  if (!apiResponded) {
    return {
      ..._clusterState,
      status: 'ERROR',
      error: 'The K3s API did not return a node list. Check the Docker master container and API server.',
      k8sNodes: [],
      uptimeSec: Math.floor((Date.now() - _clusterState.startTime) / 1000),
    };
  }

  const controlPlaneReady = nodes.some(node => node.ready && node.name &&
    (node.role === 'control-plane' || node.role === 'master'));
  const joinedWorkerCount = nodes.filter(node => node.ready && node.role !== 'control-plane' && node.role !== 'master').length;
  const remoteNodeCount = (_clusterState.selectedNodes || []).filter(node => !node.isSelf && node.id !== 'self-node').length;
  const mode = joinedWorkerCount > 0
    ? 'POOLED_CLUSTER'
    : (remoteNodeCount > 0 ? 'STANDALONE_MASTER' : 'LOCAL_MASTER');
  _clusterState = { ..._clusterState, mode, joinedWorkerCount };

  const uptimeSec = Math.floor((Date.now() - _clusterState.startTime) / 1000);

  return {
    ..._clusterState,
    status: controlPlaneReady ? 'ACTIVE' : 'NOT_READY',
    error: controlPlaneReady ? null : 'The K3s control-plane node is not Ready.',
    uptimeSec,
    k8sNodes: nodes,
  };
}

// ── 5. Terminate Cluster ────────────────────────────────────────────────────
async function stopCluster() {
  if (!_clusterState) return { status: 'INACTIVE' };

  // Notify remote nodes to stop
  const remoteNodes = (_clusterState.selectedNodes || []).filter(n => !n.isSelf && n.id !== 'self-node');
  for (const node of remoteNodes) {
    const session = (_clusterState.invitationResults || []).find(result => result.nodeId === node.id);
    if (!session?.sessionId) continue;
    if (session.channel === 'tailscale' && node.meshIp && node.connectionIp === node.meshIp) {
      const stopped = await sendProviderStop(node.meshIp, {
        sessionId: session.sessionId,
        clusterToken: _clusterState.clusterToken,
      });
      if (stopped) continue;
    }
    // Cloud status is the fallback when direct Tailscale shutdown cannot be
    // delivered, and the normal stop channel for invitations queued in AWS.
    if (session.channel === 'cloud' || session.channel === 'tailscale') {
      try { await dynamodb.updateSessionStatus(session.sessionId, 'STOPPED'); } catch (_) {}
    }
  }

  // Remove master container
  try {
    await execAsync('docker rm -f c3-k3s-master');
  } catch (_) {}

  _clusterState = null;
  notifyUI('cluster:status-update', { step: 'INACTIVE', message: 'Cluster stopped.' });
  return { status: 'INACTIVE' };
}

module.exports = {
  discoverNodes,
  pickWorkspaceFolder,
  startCluster,
  getClusterStatus,
  stopCluster,
  setIpcCallback,
};

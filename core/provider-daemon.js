'use strict';

/**
 * core/provider-daemon.js
 * Phase 3: Provider Mode Hardware Sharing Hub for C3
 * Manages:
 *  - 1-Click hardware sharing daemon
 *  - Local P2P LAN UDP beacon broadcaster (port 44345)
 *  - Local HTTP RPC listener (port 44344)
 *  - DynamoDB c3_providers cloud registration & heartbeats
 *  - Privileged c3-k3s-worker Docker container lifecycle
 *  - Provider uptime and configured offer rate (settlement is not implemented)
 */

const dgram = require('dgram');
const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const net = require('net');
const dynamodb = require('./dynamodb');
const hardware = require('./hardware');
const setupChecker = require('./setup-checker');

const execAsync = promisify(exec);

const UDP_PORT = 44345;
const RPC_PORT = 44344;

function isTailscalePeerAddress(address = '') {
  const ip = address.replace(/^::ffff:/i, '');
  const octets = ip.split('.').map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

let _sharing = false;
let _config = null;
let _udpSocket = null;
let _broadcastTimer = null;
let _httpServer = null;
let _heartbeatTimer = null;
let _sessionPollTimer = null;
let _startTime = null;
let _activeSession = null;
let _cloudRegistered = false;
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

function canReachK3sApi(host, timeout = 2500) {
  return new Promise(resolve => {
    if (!host) return resolve(false);
    const socket = new net.Socket();
    let done = false;
    const finish = reachable => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(6443, host);
  });
}

function getRegistryProfile() {
  return {
    hostname: _config.hostname,
    cpuModel: _config.cpuModel,
    physicalCores: _config.physicalCores,
    coresOffered: _config.cores,
    ramOfferedGb: _config.ramGb,
    ramType: _config.ramType,
    gpuModel: _config.gpuEnabled ? _config.gpuModel : 'None',
    gpuVramGb: _config.gpuEnabled ? _config.gpuVramGb : null,
    pricePerHour: _config.pricePerHour,
    tailscaleIp: _config.tailscaleIp,
    tailscaleNodeName: _config.tailscaleNodeName,
    localIp: _config.localIp,
    port: RPC_PORT,
  };
}

// ── 1. Start Sharing ────────────────────────────────────────────────────────
async function startSharing(userId, config = {}) {
  if (_sharing) return getProviderState();

  const specs = await hardware.getHardwareSpecs();
  const live = await hardware.getLiveStats();
  const tailscale = await setupChecker.checkTailscale();
  const docker = await setupChecker.checkDocker();
  if (!docker.running) throw new Error('Docker Desktop is not running. Start its Linux engine before sharing hardware.');
  const dockerRamGb = Number(docker.memoryTotal || 0) / (1024 ** 3);
  const maxCores = Math.max(1, Math.min(Number(specs.cpuCores || 1) - 1, Number(docker.cpus || 1) - 1));
  const maxRamGb = Math.max(1, Math.floor(Math.min(Number(specs.ramUsableGb || 1), dockerRamGb || Number(specs.ramUsableGb || 1)) - 1));

  const cores = Number(config.cores ?? Math.max(1, Math.min(maxCores, (specs.cpuCores || 1) - 2)));
  const ramGb = Number(config.ramGb ?? Math.max(1, Math.min(maxRamGb, Math.floor((dockerRamGb || specs.ramUsableGb || 1) - 1))));
  if (!Number.isFinite(cores) || cores < 1 || cores > maxCores) {
    throw new Error(`Choose at most ${maxCores} CPU threads, leaving capacity for the host and Docker engine.`);
  }
  if (!Number.isFinite(ramGb) || ramGb < 2 || ramGb > maxRamGb) {
    throw new Error(`Choose at most ${maxRamGb} GB RAM, based on the Docker engine limit and host hardware.`);
  }
  const gpuEnabled = config.gpuEnabled ?? (specs.gpuModel && specs.gpuModel !== 'None');
  const requestedRate = Number(config.pricePerHour);
  const pricePerHour = Number.isFinite(requestedRate) && requestedRate > 0 ? requestedRate : null;

  _config = {
    cores,
    ramGb,
    gpuEnabled,
    pricePerHour,
    userId,
    hostname: specs.hostname || os.hostname(),
    cpuModel: specs.cpuModel,
    physicalCores: specs.cpuPhysicalCores,
    ramType: specs.ramType,
    gpuModel: specs.gpuModel,
    gpuVramGb: specs.gpuVramGb,
    tailscaleIp: tailscale.running ? tailscale.ip : null,
    tailscaleNodeName: tailscale.running ? (tailscale.hostname || tailscale.dnsName || null) : null,
    localIp: live.network.ip,
  };

  _sharing = true;
  _startTime = Date.now();
  _activeSession = null;
  _cloudRegistered = false;

  // 1. Register with DynamoDB
  try {
    await dynamodb.registerProvider(userId, getRegistryProfile());
    _cloudRegistered = true;
  } catch (err) {
    _cloudRegistered = false;
    console.warn('[provider] DynamoDB registration notice:', err.message);
  }

  // 2. Start DynamoDB Heartbeat (every 15s)
  _heartbeatTimer = setInterval(async () => {
    if (!_sharing) return;
    try {
      // Tailscale addresses can change after reconnects. Refresh the advertised
      // endpoint from the local Tailscale daemon instead of keeping the startup IP.
      const [currentTailscale, currentStats] = await Promise.all([
        setupChecker.checkTailscale(),
        hardware.getLiveStats(),
      ]);
      _config.tailscaleIp = currentTailscale.running ? currentTailscale.ip : null;
      _config.tailscaleNodeName = currentTailscale.running
        ? (currentTailscale.hostname || currentTailscale.dnsName || null)
        : null;
      _config.localIp = currentStats.network?.ip || _config.localIp;
      if (_cloudRegistered) {
        await dynamodb.heartbeat(userId, getRegistryProfile());
      } else {
        await dynamodb.registerProvider(userId, getRegistryProfile());
        _cloudRegistered = true;
      }
    } catch (err) {
      _cloudRegistered = false;
      console.warn('[provider] Registry refresh failed; will retry:', err.message);
    }
  }, 15000);

  // 3. Start LAN UDP Beacon Broadcaster
  try {
    _udpSocket = dgram.createSocket('udp4');
    _udpSocket.bind(() => {
      try {
        _udpSocket.setBroadcast(true);
      } catch (_) {}
    });

    const sendBeacon = () => {
      if (!_sharing || !_udpSocket) return;
      const beaconMsg = JSON.stringify({
        type: 'c3-beacon',
        userId: _config.userId,
        hostname: _config.hostname,
        cpuModel: _config.cpuModel,
        cores: _config.cores,
        physicalCores: _config.physicalCores,
        ramGb: _config.ramGb,
        ramType: _config.ramType,
        gpu: _config.gpuEnabled ? _config.gpuModel : 'None',
        gpuVramGb: _config.gpuEnabled ? _config.gpuVramGb : null,
        pricePerHour: _config.pricePerHour,
        meshIp: _config.tailscaleIp,
        localIp: _config.localIp,
        port: RPC_PORT,
        status: _activeSession ? 'BUSY' : 'ACTIVE',
        timestamp: Date.now(),
      });
      _udpSocket.send(beaconMsg, 0, beaconMsg.length, UDP_PORT, '255.255.255.255', () => {});
    };

    sendBeacon();
    _broadcastTimer = setInterval(sendBeacon, 3000);
  } catch (err) {
    console.warn('[provider] UDP Beacon error:', err.message);
  }

  // 4. Start Local HTTP RPC Listener
  try {
    _httpServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if ((url.pathname === '/session/join' || url.pathname === '/session/stop') &&
          !isTailscalePeerAddress(req.socket.remoteAddress || '')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Session control is accepted only over the Tailscale network.' }));
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          status: _activeSession ? 'BUSY' : 'ACTIVE',
          hostname: _config.hostname,
          cores: _config.cores,
          ramGb: _config.ramGb,
          gpu: _config.gpuEnabled ? _config.gpuModel : 'None',
        }));
      }

      if (url.pathname === '/session/join' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            console.log('[provider] Received a provider session invitation.');

            const invitation = {
              sessionId: data.sessionId || `session-${Date.now()}`,
              consumerId: data.consumerId,
              providerId: data.providerId,
              consumerName: data.consumerName || 'Peer Node',
              consumerIp: data.masterIp || req.socket.remoteAddress,
              masterIp: data.masterIp,
              workerNodeIp: data.workerNodeIp,
              flannelBackend: data.flannelBackend,
              clusterToken: data.clusterToken || data.token,
              cores: data.cores || _config.cores,
              ramGb: data.ramGb || _config.ramGb,
              gpuEnabled: data.gpuEnabled ?? _config.gpuEnabled,
              rate: _config.pricePerHour,
              receivedAt: Date.now(),
            };

            // Notify UI
            notifyUI('provider:invitation-received', invitation);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, status: 'INVITATION_DELIVERED' }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }

      if (url.pathname === '/session/stop' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body);
            if (!_activeSession || data.sessionId !== _activeSession.sessionId || data.clusterToken !== _activeSession.clusterToken) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'Session authorization failed.' }));
            }
            await stopActiveSession();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, status: 'SESSION_TERMINATED' }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve, reject) => {
      const onError = error => {
        _httpServer.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        _httpServer.removeListener('error', onError);
        console.log(`[provider] RPC Listener active on port ${RPC_PORT}`);
        resolve();
      };
      _httpServer.once('error', onError);
      _httpServer.once('listening', onListening);
      _httpServer.listen(RPC_PORT, '0.0.0.0');
    });
  } catch (err) {
    _sharing = false;
    if (_broadcastTimer) clearInterval(_broadcastTimer);
    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    if (_udpSocket) {
      try { _udpSocket.close(); } catch (_) {}
      _udpSocket = null;
    }
    if (_httpServer) {
      try { _httpServer.close(); } catch (_) {}
      _httpServer = null;
    }
    try { await dynamodb.updateProviderStatus(userId, 'OFFLINE'); } catch (_) {}
    _cloudRegistered = false;
    throw new Error(`Provider RPC could not bind port ${RPC_PORT}: ${err.message}`);
  }

  // 5. Poll DynamoDB for Cloud Session Requests (every 4s)
  _sessionPollTimer = setInterval(async () => {
    if (!_sharing) return;
    try {
      if (_activeSession) {
        const session = await dynamodb.getSession(_activeSession.sessionId);
        if (session?.status === 'STOPPED' || session?.status === 'DECLINED') await stopActiveSession();
        return;
      }
      const pending = await dynamodb.getPendingRequestsForProvider(userId);
      if (pending && pending.length > 0) {
        const reqItem = pending[0];
        notifyUI('provider:invitation-received', {
          sessionId: reqItem.sessionId,
          consumerId: reqItem.consumerId,
          providerId: reqItem.providerId,
          consumerName: reqItem.consumerName || 'Cloud Peer',
          consumerIp: reqItem.masterIp,
          masterIp: reqItem.masterIp,
          workerNodeIp: reqItem.workerNodeIp,
          flannelBackend: reqItem.flannelBackend,
          clusterToken: reqItem.clusterToken,
          cores: reqItem.cores || _config.cores,
          ramGb: reqItem.ramGb || _config.ramGb,
          gpuEnabled: reqItem.gpuEnabled ?? _config.gpuEnabled,
          rate: _config.pricePerHour,
          receivedAt: Date.now(),
        });
      }
    } catch (_) {}
  }, 4000);

  return getProviderState();
}

// ── 2. Accept Session & Launch Privileged K3s Worker ─────────────────────────
async function acceptSession(sessionData) {
  if (!_sharing) throw new Error('Provider sharing is not active.');
  const { sessionId, masterIp, clusterToken, gpuEnabled } = sessionData;
  const flannelBackend = sessionData.flannelBackend === 'wireguard-native' ? 'wireguard-native' : 'vxlan';
  // Older pending invitations did not persist workerNodeIp. Recover the
  // provider's own address from the interface matching the consumer's route.
  // A Tailscale master must pair with this provider's Tailscale address;
  // otherwise use the LAN address advertised by this provider.
  const workerNodeIp = sessionData.workerNodeIp ||
    (isTailscalePeerAddress(masterIp) ? _config.tailscaleIp : _config.localIp);
  console.log('[provider] Validating provider session invitation.', {
    sessionId,
    masterIp,
    workerNodeIp,
  });

  // 1. Strict Input Sanitization & Format Validation (Prevent Command Injection)
  const ipRegex = /^[a-zA-Z0-9.-]+$/;
  const tokenRegex = /^[a-zA-Z0-9_.-]+$/;

  if (!masterIp || !ipRegex.test(masterIp)) {
    throw new Error('Security Error: Invalid master IP or hostname format.');
  }
  if (!clusterToken || !tokenRegex.test(clusterToken)) {
    throw new Error('Security Error: Invalid cluster token format.');
  }
  if (!workerNodeIp || !ipRegex.test(workerNodeIp)) {
    throw new Error('Security Error: Provider host address is invalid; rescan nodes before accepting this invitation.');
  }
  if (sessionId && !tokenRegex.test(sessionId)) {
    throw new Error('Security Error: Invalid session ID format.');
  }

  if (!await canReachK3sApi(masterIp)) {
    throw new Error(`Cannot reach the consumer K3s API at ${masterIp}:6443. Confirm both peers are online and the network/firewall allows TCP 6443.`);
  }

  // 2. Stop any existing worker container
  try {
    await execAsync('docker rm -f c3-k3s-worker');
  } catch (_) {}

  // 3. Build Safe Argument Array (No Shell Interpolation)
  const dockerArgs = [
    'run', '-d',
    '--cap-add=NET_ADMIN',
    '--privileged',
    '--name', 'c3-k3s-worker',
    '-p', flannelBackend === 'wireguard-native' ? '51820:51820/udp' : '8472:8472/udp',
  ];

  if ((gpuEnabled ?? _config?.gpuEnabled)) {
    dockerArgs.push('--gpus', 'all');
  }
  if (_config?.cores) {
    dockerArgs.push('--cpus', String(_config.cores));
  }
  if (_config?.ramGb) {
    dockerArgs.push('-m', `${_config.ramGb}g`);
  }

  dockerArgs.push(
    '-e', `K3S_URL=https://${masterIp}:6443`,
    '-e', `K3S_TOKEN=${clusterToken}`,
    '-e', `K3S_NODE_EXTERNAL_IP=${workerNodeIp}`,
    'rancher/k3s:v1.36.4-k3s1',
    'agent',
    '--node-external-ip', workerNodeIp,
    '--node-label', `c3.io/allocated-cores=${Number(_config?.cores || sessionData.cores || 1)}`,
    '--node-label', `c3.io/allocated-memory-gb=${Number(_config?.ramGb || sessionData.ramGb || 1)}`
  );

  console.log('[provider] Launching worker container with the configured resource limits.');

  await new Promise((resolve, reject) => {
    const proc = spawn('docker', dockerArgs);
    let errOutput = '';
    proc.stderr.on('data', d => { errOutput += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Docker worker launch failed (code ${code}): ${errOutput}`));
    });
    proc.on('error', reject);
  });

  const { stdout: containerState } = await execAsync('docker inspect --format "{{.State.Status}}" c3-k3s-worker');
  if (containerState.trim() !== 'running') {
    const { stdout: logs } = await execAsync('docker logs --tail 40 c3-k3s-worker').catch(() => ({ stdout: '' }));
    const safeLogs = clusterToken ? logs.replaceAll(clusterToken, '[redacted]') : logs;
    throw new Error(`K3s worker container is ${containerState.trim() || 'not running'}.${safeLogs ? ` ${safeLogs.trim()}` : ''}`);
  }

  _activeSession = {
    ...sessionData,
    startedAt: Date.now(),
    status: 'STARTING',
  };

  // 3. Update DynamoDB
  try {
    await dynamodb.updateSessionStatus(sessionId, 'ACCEPTED', {
      providerNode: _config.hostname,
      workerStatus: 'STARTING',
    });
  } catch (_) {}

  notifyUI('provider:session-started', _activeSession);
  return _activeSession;
}

// ── 3. Decline Session ──────────────────────────────────────────────────────
async function declineSession(sessionId) {
  try {
    await dynamodb.updateSessionStatus(sessionId, 'DECLINED', {
      reason: 'Rejected by provider operator.',
    });
  } catch (_) {}
  return { ok: true, sessionId };
}

// ── 4. Stop Active Session ──────────────────────────────────────────────────
async function stopActiveSession() {
  if (_activeSession) {
    try {
      await execAsync('docker rm -f c3-k3s-worker');
    } catch (_) {}
    const session = _activeSession;
    _activeSession = null;
    notifyUI('provider:session-ended', session);
  }
}

// ── 5. Stop Sharing ─────────────────────────────────────────────────────────
async function stopSharing() {
  if (!_sharing) return getProviderState();
  _sharing = false;

  // Stop containers
  try {
    await execAsync('docker rm -f c3-k3s-worker');
  } catch (_) {}

  // Clear timers
  if (_broadcastTimer) clearInterval(_broadcastTimer);
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  if (_sessionPollTimer) clearInterval(_sessionPollTimer);

  // Close sockets
  if (_udpSocket) {
    try { _udpSocket.close(); } catch (_) {}
    _udpSocket = null;
  }
  if (_httpServer) {
    try { _httpServer.close(); } catch (_) {}
    _httpServer = null;
  }

  // Update DynamoDB
  if (_config?.userId) {
    try {
      await dynamodb.updateProviderStatus(_config.userId, 'OFFLINE');
    } catch (_) {}
  }

  _activeSession = null;
  _cloudRegistered = false;
  return getProviderState();
}

// ── 6. Get Live Provider State ──────────────────────────────────────────────
function getProviderState() {
  const uptimeSec = _sharing && _startTime
    ? Math.floor((Date.now() - _startTime) / 1000)
    : 0;

  return {
    sharing: _sharing,
    config: _config,
    activeSession: _activeSession,
    uptimeSec,
    earnedCredits: null,
    settlementConfigured: false,
    cloudRegistered: _cloudRegistered,
  };
}

module.exports = {
  startSharing,
  stopSharing,
  acceptSession,
  declineSession,
  stopActiveSession,
  getProviderState,
  setIpcCallback,
};

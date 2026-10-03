'use strict';

/**
 * core/settings-manager.js
 * Phase 7: System Settings, Maintenance & Credits Ledger Manager
 * Provides:
 *  - 1-Click Docker container pruning for C3 containers (c3-k3s-master, c3-k3s-worker)
 *  - Test credit grant written to the DynamoDB user ledger
 *  - Local transaction history tracking
 *  - Live P2P port & socket latency diagnostic probe
 *  - Network & Tailscale mesh status diagnostics
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dynamodb = require('./dynamodb');
const cognito = require('./cognito');
const setupChecker = require('./setup-checker');

const execAsync = promisify(exec);

// Path for local transactions ledger persistence
let _userDataDir = null;
function getLedgerFile() {
  const baseDir = _userDataDir || process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
  const c3Dir = path.join(baseDir, 'c3');
  try {
    if (!fs.existsSync(c3Dir)) fs.mkdirSync(c3Dir, { recursive: true });
  } catch (_) {}
  return path.join(c3Dir, 'c3_ledger.json');
}

function initUserDataDir(dir) {
  _userDataDir = dir;
}

function loadTransactions() {
  try {
    const file = getLedgerFile();
    if (fs.existsSync(file)) {
      const entries = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(entries) ? entries.filter(entry => entry.syncedToCloud === true) : [];
    }
  } catch (_) {}
  return [];
}

function recordTransaction(tx) {
  try {
    const file = getLedgerFile();
    const list = loadTransactions();
    list.unshift({
      id: `tx-${Date.now().toString(36)}`,
      timestamp: Date.now(),
      status: 'CONFIRMED',
      ...tx,
    });
    // Keep last 40 transactions
    if (list.length > 40) list.length = 40;
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8');
    return list;
  } catch (err) {
    console.error('[settings] Failed to write ledger:', err.message);
    return [];
  }
}

// ── 1. Container Pruning & Status ──────────────────────────────────────────
async function getContainerStatus() {
  const result = {
    master: { running: false, containerId: null, status: 'NOT FOUND' },
    worker: { running: false, containerId: null, status: 'NOT FOUND' },
    dockerEngine: false,
  };

  try {
    const { stdout } = await execAsync('docker ps -a --filter "name=c3-k3s" --format "{{.Names}}|{{.Status}}|{{.ID}}"');
    result.dockerEngine = true;
    const lines = stdout.trim().split('\n').filter(Boolean);

    lines.forEach(line => {
      const [name, status, id] = line.split('|');
      if (name.includes('master')) {
        result.master = {
          running: status.toLowerCase().includes('up'),
          containerId: id,
          status,
        };
      }
      if (name.includes('worker')) {
        result.worker = {
          running: status.toLowerCase().includes('up'),
          containerId: id,
          status,
        };
      }
    });
  } catch (_) {
    result.dockerEngine = false;
  }

  return result;
}

async function pruneContainers() {
  const logs = [];
  for (const name of ['c3-k3s-master', 'c3-k3s-worker']) {
    try {
      const { stdout } = await execAsync(`docker inspect --format "{{.State.Running}}" ${name}`);
      if (stdout.trim() === 'true') {
        logs.push(`[Prune] Preserved running container ${name}; active clusters are never removed by this action.`);
        continue;
      }
      await execAsync(`docker rm ${name}`);
      logs.push(`[Prune] Removed stopped container ${name}.`);
    } catch (err) {
      if (/no such (object|container)/i.test(err.message || '')) {
        logs.push(`[Prune] ${name} was not present.`);
      } else {
        logs.push(`[Prune Warning] ${name}: ${err.message}`);
        return { ok: false, logs, error: err.message };
      }
    }
  }
  return { ok: true, logs, error: null };
}

// ── 2. C3 Credits Faucet & Ledger ──────────────────────────────────────────
async function claimFaucetCredits(userId, amount = 500) {
  if (!userId) throw new Error('User identity required to claim faucet credits.');

  // Enforce positive grant amount bounded to 500 max per claim
  const grantAmount = Math.min(500, Math.max(1, Number(amount) || 500));

  let updated;
  try {
    updated = await dynamodb.updateUserCredits(userId, grantAmount);
  } catch (err) {
    console.warn('[settings] DynamoDB test-credit grant failed:', err.message);
    if (err.code === 'FAUCET_LIMIT_REACHED') {
      return { ok: false, error: err.message, faucetEligible: false };
    }
  }
  if (updated?.credits === undefined) {
    return { ok: false, syncedToCloud: false, error: 'The cloud credit ledger did not confirm this grant.' };
  }

  const updatedBalance = Number(updated.credits);
  const syncedToCloud = true;
  recordTransaction({
    type: 'FAUCET_CLAIM',
    amount: `+${grantAmount}`,
    description: `DynamoDB test credit grant (+${grantAmount} C3)`,
    balanceAfter: updatedBalance,
    syncedToCloud,
  });

  return {
    ok: true,
    syncedToCloud,
    newBalance: updatedBalance,
    claimed: grantAmount,
    transactions: loadTransactions(),
  };
}

function getTransactions() {
  return loadTransactions();
}

// ── 3. P2P Socket & Port Diagnostic Probe ──────────────────────────────────
function testP2PConnectivity(host = '127.0.0.1', port = 44344) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(2500);

    socket.connect(port, host, () => {
      const latency = Date.now() - startTime;
      socket.destroy();
      resolve({
        ok: true,
        host,
        port,
        latencyMs: latency,
        message: `Socket connection to ${host}:${port} successful in ${latency}ms.`,
      });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({
        ok: false,
        host,
        port,
        latencyMs: null,
        message: `Port ${port} probe unreachable: ${err.message}`,
      });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({
        ok: false,
        host,
        port,
        latencyMs: null,
        message: `Connection to ${host}:${port} timed out after 2.5s.`,
      });
    });
  });
}

// ── 4. Network Diagnostics ──────────────────────────────────────────────────
async function getNetworkDiagnostics() {
  const tailscale = await setupChecker.checkTailscale();
  const checkPort = port => new Promise(resolve => {
    const socket = new net.Socket();
    const finish = listening => { socket.destroy(); resolve(listening); };
    socket.setTimeout(350);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
  const [rpcListening, k3sListening, dashboardListening] = await Promise.all([
    checkPort(44344), checkPort(6443), checkPort(8265),
  ]);
  const tailscaleStatus = !tailscale.installed
    ? 'NOT INSTALLED'
    : !tailscale.running
      ? `NOT CONNECTED (${tailscale.backendState || 'service unavailable'})`
      : tailscale.onlinePeerCount > 0
        ? `CONNECTED · ${tailscale.onlinePeerCount} PEER(S) ONLINE`
        : 'CONNECTED · NO PEERS ONLINE';

  return {
    tailscaleIp: tailscale.running ? tailscale.ip : null,
    tailscaleStatus,
    tailscaleRunning: tailscale.running,
    onlinePeerCount: tailscale.onlinePeerCount ?? 0,
    ports: [
      { name: 'LAN UDP Beacon Discovery', port: 44345, proto: 'UDP', role: 'LAN only; verified by receiving beacons', listening: null },
      { name: 'C3 Provider RPC Server', port: 44344, proto: 'HTTP', role: 'Provider session endpoint', listening: rpcListening },
      { name: 'K3s Kubernetes API Server', port: 6443, proto: 'TCP/TLS', role: 'Cluster control plane', listening: k3sListening },
      { name: 'Ray Dashboard', port: 8265, proto: 'HTTP', role: 'Local forwarded dashboard', listening: dashboardListening },
      { name: 'Ray GCS', port: 6379, proto: 'TCP', role: 'Kubernetes-internal service; not published on host', listening: null },
    ],
  };
}

module.exports = {
  initUserDataDir,
  getContainerStatus,
  pruneContainers,
  claimFaucetCredits,
  getTransactions,
  recordTransaction,
  testP2PConnectivity,
  getNetworkDiagnostics,
};

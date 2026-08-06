'use strict';
const { Client } = require('ssh2');
const net = require('net');
const os  = require('os');
const { exec } = require('child_process');

let currentTunnelClient = null;
let currentProxyServer  = null; // Node.js TCP proxy server

// ─── Helpers ────────────────────────────────────────────────────────────────

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return null;
}

/** Best-effort Windows Firewall rule (silently ignores failures — needs admin). */
function addFirewallRule(port, tag) {
  const name = `C3-Proxy-${tag}`;
  exec(
    `netsh advfirewall firewall delete rule name="${name}" >nul 2>&1 & ` +
    `netsh advfirewall firewall add rule name="${name}" protocol=TCP dir=in localport=${port} action=allow`,
    (err) => {
      if (err) console.warn('[C3] Firewall rule failed (no admin?):', err.message);
      else     console.log(`[C3] Firewall: opened port ${port} inbound`);
    }
  );
}

// ─── 1. Node.js TCP Proxy (PRIMARY — most reliable for LAN) ─────────────────
//
// Docker Desktop for Windows exposes published ports ONLY on 127.0.0.1
// (via the internal docker-proxy / WSL2 bridge).  From another machine on
// the same LAN that loopback address is unreachable.
//
// We fix this by creating our OWN proxy server that:
//   • listens on 0.0.0.0:randomPort  →  accessible from any LAN device
//   • forwards every connection to   127.0.0.1:dockerPort (Docker's own proxy)
//
// This completely bypasses Docker Desktop's LAN forwarding limitation.
// ─────────────────────────────────────────────────────────────────────────────
function startNodeProxy(dockerPort, sessionId) {
  return new Promise((resolve, reject) => {
    // Close any leftover proxy from a previous session
    if (currentProxyServer) {
      try { currentProxyServer.close(); } catch (_) {}
      currentProxyServer = null;
    }

    const server = net.createServer((clientSock) => {
      const targetSock = net.connect(dockerPort, '127.0.0.1');
      clientSock.pipe(targetSock);
      targetSock.pipe(clientSock);
      targetSock.on('error', () => clientSock.destroy());
      clientSock.on('error', () => targetSock.destroy());
    });

    // 0 = let OS pick a free ephemeral port; '0.0.0.0' = all interfaces
    server.listen(0, '0.0.0.0', () => {
      const proxyPort = server.address().port;
      const lanIp     = getLanIp();

      if (!lanIp) {
        server.close();
        return reject(new Error('No LAN IP found'));
      }

      currentProxyServer = server;
      console.log(`[C3 Proxy] 0.0.0.0:${proxyPort} → 127.0.0.1:${dockerPort}  LAN=${lanIp}`);

      // Try to open Windows Firewall (best-effort)
      addFirewallRule(proxyPort, sessionId ? sessionId.slice(0, 8) : proxyPort);

      resolve({ host: lanIp, port: proxyPort });
    });

    server.on('error', (err) => {
      console.error('[C3 Proxy] Failed to start proxy server:', err.message);
      reject(err);
    });
  });
}

// ─── 2. Serveo SSH reverse tunnel (FALLBACK — works across internet) ─────────
function tryServeoTunnel(localPort, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    currentTunnelClient = conn;
    let settled = false;

    const done = (val, err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    const bail = (msg) => { try { conn.end(); } catch (_) {} done(null, new Error(msg)); };
    const timer = setTimeout(() => bail('Serveo timeout'), timeoutMs);

    conn.on('ready', () => {
      clearTimeout(timer);
      conn.forwardIn('serveo.net', 0, (err, port) => {
        if (err || !port) return bail(err?.message || 'Serveo: no port allocated');
        console.log(`[C3 Tunnel] Serveo: serveo.net:${port} → localhost:${localPort}`);
        done({ host: 'serveo.net', port });
      });
    });

    conn.on('tcp connection', (info, accept) => {
      const remote = accept();
      const local  = net.connect(localPort, '127.0.0.1');
      remote.pipe(local).pipe(remote);
      local.on('error',  () => remote.destroy());
      remote.on('error', () => local.destroy());
    });

    conn.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([]));
    conn.on('error', (err) => { clearTimeout(timer); bail(err.message); });

    conn.connect({
      host: 'serveo.net', port: 22, username: 'serveo',
      readyTimeout: timeoutMs, tryKeyboard: true,
    });
  });
}

// ─── Main entry point ────────────────────────────────────────────────────────
//
//  Priority:
//   1. Node.js TCP Proxy (0.0.0.0)  — LAN, no admin, no external service
//   2. Serveo reverse SSH tunnel    — Cross-internet, Serveo must be reachable
//
async function startTunnel(dockerPort, sessionId) {
  // ── 1. Node.js proxy (primary for same-LAN setups) ──────────────────────
  try {
    const result = await startNodeProxy(dockerPort, sessionId);
    console.log(`[C3] Using Node.js proxy: ${result.host}:${result.port}`);
    return result;
  } catch (proxyErr) {
    console.warn('[C3] Node.js proxy failed:', proxyErr.message);
  }

  // ── 2. Serveo (cross-network fallback) ───────────────────────────────────
  try {
    const result = await tryServeoTunnel(dockerPort, 10000);
    console.log(`[C3] Using Serveo tunnel: ${result.host}:${result.port}`);
    return result;
  } catch (serveoErr) {
    console.warn('[C3] Serveo failed:', serveoErr.message);
  }

  throw new Error(
    'No tunnel available. Node.js proxy failed and Serveo is unreachable. ' +
    'Make sure both devices are on the same network.'
  );
}

function stopTunnel() {
  if (currentProxyServer) {
    try { currentProxyServer.close(); } catch (_) {}
    currentProxyServer = null;
  }
  if (currentTunnelClient) {
    try { currentTunnelClient.end(); } catch (_) {}
    currentTunnelClient = null;
  }
}

module.exports = { startTunnel, stopTunnel, getLanIp };

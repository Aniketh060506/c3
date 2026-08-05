'use strict';
const { Client } = require('ssh2');
const net = require('net');
const os  = require('os');

let currentTunnelClient = null;

/**
 * Get this machine's LAN IP (first non-loopback IPv4 address).
 * Works for same-network deployments without any external tunnel.
 */
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return null;
}

/**
 * Try to establish a Serveo reverse tunnel within a timeout.
 * Returns { host: 'serveo.net', port: N } on success.
 */
function tryServeoTunnel(localPort, timeoutMs = 12000) {
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

    const bail = (msg) => {
      try { conn.end(); } catch (_) {}
      done(null, new Error(msg));
    };

    const timer = setTimeout(() => bail('Serveo connect timeout'), timeoutMs);

    conn.on('ready', () => {
      clearTimeout(timer);
      // 'serveo.net' as bind address is correct per Serveo protocol
      conn.forwardIn('serveo.net', 0, (err, port) => {
        if (err || !port) return bail(err?.message || 'Serveo did not allocate a port');
        console.log(`[C3 Tunnel] Serveo: serveo.net:${port} → localhost:${localPort}`);
        done({ host: 'serveo.net', port });
      });
    });

    // Proxy incoming Serveo connections to the local SSH port
    conn.on('tcp connection', (info, accept) => {
      const remote = accept();
      const local  = net.connect(localPort, '127.0.0.1');
      remote.pipe(local).pipe(remote);
      local.on('error', () => remote.destroy());
      remote.on('error', () => local.destroy());
    });

    conn.on('error',  (err) => { clearTimeout(timer); bail(err.message); });
    conn.on('close',  () => {});

    conn.connect({
      host:         'serveo.net',
      port:         22,
      username:     'serveo',
      readyTimeout: timeoutMs,
    });
  });
}

/**
 * Main entry point.
 *
 * Priority:
 *   1. Serveo public tunnel  → works across the internet
 *   2. LAN IP fallback       → works within the same local network
 *
 * IMPORTANT: Never falls back to 127.0.0.1 — that address is meaningless
 * to any machine other than the provider itself.
 */
async function startTunnel(localPort) {
  // Try Serveo
  try {
    const result = await tryServeoTunnel(localPort, 15000);
    return result;
  } catch (serveoErr) {
    console.warn('[C3 Tunnel] Serveo failed:', serveoErr.message);
  }

  // LAN IP fallback (works when provider and user are on the same network)
  const lanIp = getLanIp();
  if (lanIp) {
    console.log(`[C3 Tunnel] Using LAN IP fallback: ${lanIp}:${localPort}`);
    return { host: lanIp, port: localPort };
  }

  // Nothing worked — throw so caller knows
  throw new Error(
    'Could not establish a tunnel: Serveo is unreachable and no LAN IP found. ' +
    'Make sure serveo.net is accessible or both devices are on the same network.'
  );
}

function stopTunnel() {
  if (currentTunnelClient) {
    try { currentTunnelClient.end(); } catch (_) {}
    currentTunnelClient = null;
  }
}

module.exports = { startTunnel, stopTunnel, getLanIp };

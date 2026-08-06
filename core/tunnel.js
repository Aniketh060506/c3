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
function tryServeoTunnel(localPort, timeoutMs = 4000) {
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

    // Handle keyboard-interactive auth (Serveo may send challenges)
    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish(prompts.map(() => ''));
    });

    conn.on('error',  (err) => { clearTimeout(timer); bail(err.message); });
    conn.on('close',  () => {});

    conn.connect({
      host:         'serveo.net',
      port:         22,
      username:     'serveo',
      readyTimeout: timeoutMs,
      tryKeyboard:  true,   // needed to handle keyboard-interactive auth from Serveo
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
/**
 * Add a Windows Firewall inbound rule for the given port so LAN machines
 * can reach the Docker-proxied container SSH port.
 * Silently ignores errors (needs admin; may already exist).
 */
function addFirewallRule(port, sessionId) {
  const { exec } = require('child_process');
  const name = `C3-Session-${sessionId.slice(0, 8)}`;
  // Delete any stale rule first, then add fresh
  exec(`netsh advfirewall firewall delete rule name="${name}" >nul 2>&1 & netsh advfirewall firewall add rule name="${name}" protocol=TCP dir=in localport=${port} action=allow`,
    (err) => {
      if (err) console.warn('[C3 Tunnel] Could not add firewall rule (needs admin or not Windows):', err.message);
      else     console.log(`[C3 Tunnel] Windows Firewall: opened port ${port} for inbound LAN connections`);
    }
  );
}

async function startTunnel(localPort, sessionId) {
  // Try Serveo with a fast 6s timeout (increased to handle slow Serveo responses)
  try {
    const result = await tryServeoTunnel(localPort, 6000);
    return result;
  } catch (serveoErr) {
    console.warn('[C3 Tunnel] Serveo failed/timed out:', serveoErr.message);
  }

  // LAN IP fallback (works instantly when provider and user are on the same network)
  const lanIp = getLanIp();
  if (lanIp) {
    console.log(`[C3 Tunnel] Using LAN IP fallback: ${lanIp}:${localPort}`);
    // Open Windows Firewall so user laptop can reach this port
    if (sessionId) addFirewallRule(localPort, sessionId);
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

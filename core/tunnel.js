'use strict';
const { spawn }  = require('child_process');
const { Client } = require('ssh2');
const net = require('net');
const os  = require('os');

let serveoProcess   = null; // system ssh.exe child process
let currentClient   = null; // ssh2 Client (fallback)
let proxyServer     = null; // Node.js TCP proxy (last resort LAN)

// ─── getLanIp ────────────────────────────────────────────────────────────────
// Returns the real Wi-Fi IP, skipping Docker/WSL2/Hyper-V virtual adapters.
function getLanIp() {
  const ifaces     = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    const n = name.toLowerCase();
    if (n.includes('docker')  || n.includes('wsl')      || n.includes('hyper-v') ||
        n.includes('vethernet') || n.includes('vmware') || n.includes('virtualbox') ||
        n.includes('loopback')) continue;

    for (const alias of addrs) {
      if (alias.family !== 'IPv4' || alias.internal) continue;
      const [a, b] = alias.address.split('.').map(Number);
      if (a === 169 && b === 254) continue;           // link-local
      if (a === 172 && b >= 16 && b <= 31) continue;  // Docker/WSL range

      const priority = (a === 192 && b === 168) ? 1   // home Wi-Fi
                     : (a === 10)               ? 2   // corporate LAN
                     :                            3;
      candidates.push({ ip: alias.address, priority });
    }
  }

  candidates.sort((x, y) => x.priority - y.priority);
  return candidates[0]?.ip ?? null;
}

// ─── APPROACH 1: System ssh.exe → Serveo ────────────────────────────────────
//
// Uses the OpenSSH binary built into Windows 10/11 to create a REVERSE tunnel.
// This is an OUTBOUND connection → Windows Firewall does NOT block it.
// Serveo allocates a public port; the user connects to serveo.net:PORT.
//
// Why not use ssh2 library?  The ssh2 library has subtle auth-handling
// differences from real OpenSSH that cause Serveo to reject the connection.
// The system binary handles Serveo's protocol perfectly.
// ─────────────────────────────────────────────────────────────────────────────
function startViaSystemSSH(localPort, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    // Windows 10/11 ships OpenSSH at C:\Windows\System32\OpenSSH\ssh.exe
    // and adds it to PATH as 'ssh'
    const args = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ConnectTimeout=12',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `0:localhost:${localPort}`, // 0 = Serveo picks the public port
      'serveo.net',
      '-N',  // Don't execute a remote command — just forward
    ];

    console.log('[C3 Tunnel] Trying system ssh → Serveo:', args.join(' '));
    let proc;
    try {
      proc = spawn('ssh', args, {
        stdio:       ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return reject(new Error(`ssh.exe not found: ${e.message}`));
    }

    serveoProcess = proc;
    let resolved  = false;

    const timer = setTimeout(() => {
      if (!resolved) { proc.kill(); reject(new Error('Serveo timeout via system ssh')); }
    }, timeoutMs);

    const checkOutput = (text) => {
      if (resolved) return;
      process.stdout.write(`[Serveo] ${text}`);
      // Serveo prints: "Forwarding TCP connections from serveo.net:PORT"
      const m = text.match(/serveo\.net:(\d+)/);
      if (m) {
        const port = parseInt(m[1]);
        if (port > 1000) {
          resolved = true;
          clearTimeout(timer);
          console.log(`[C3 Tunnel] ✅ Serveo tunnel: serveo.net:${port} → localhost:${localPort}`);
          resolve({ host: 'serveo.net', port });
        }
      }
    };

    proc.stdout.on('data', (d) => checkOutput(d.toString()));
    proc.stderr.on('data', (d) => checkOutput(d.toString()));
    proc.on('error',  (e)    => { clearTimeout(timer); if (!resolved) reject(e); });
    proc.on('close',  (code) => {
      clearTimeout(timer);
      if (!resolved) reject(new Error(`ssh.exe closed early (code ${code})`));
    });
  });
}

// ─── APPROACH 2: ssh2 library → Serveo ──────────────────────────────────────
// Pure-JS fallback in case system ssh.exe is not available.
function startViaSsh2Serveo(localPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const conn  = new Client();
    currentClient = conn;
    let settled = false;

    const done = (val, err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    };
    const bail = (msg) => { try { conn.end(); } catch (_) {} done(null, new Error(msg)); };
    const timer = setTimeout(() => bail('ssh2 Serveo timeout'), timeoutMs);

    conn.on('ready', () => {
      clearTimeout(timer);
      conn.forwardIn('serveo.net', 0, (err, port) => {
        if (err || !port) return bail(err?.message || 'Serveo gave no port');
        console.log(`[C3 Tunnel] ✅ ssh2 Serveo: serveo.net:${port}`);
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

// ─── APPROACH 3: Node.js TCP proxy on 0.0.0.0 (LAN only) ────────────────────
// Last resort. Works ONLY when both devices are on the same Wi-Fi.
// Creates a proxy server on 0.0.0.0 to bypass Docker Desktop's loopback-only binding.
function startNodeProxy(localPort) {
  return new Promise((resolve, reject) => {
    if (proxyServer) { try { proxyServer.close(); } catch (_) {} proxyServer = null; }

    const lanIp = getLanIp();
    if (!lanIp) return reject(new Error('No real LAN IP detected'));

    const server = net.createServer((client) => {
      const target = net.connect(localPort, '127.0.0.1');
      client.pipe(target); target.pipe(client);
      target.on('error', () => client.destroy());
      client.on('error', () => target.destroy());
    });

    server.listen(0, '0.0.0.0', () => {
      const port = server.address().port;
      proxyServer = server;
      console.log(`[C3 Proxy] 0.0.0.0:${port} → localhost:${localPort}   LAN IP: ${lanIp}`);
      resolve({ host: lanIp, port });
    });

    server.on('error', reject);
  });
}

// ─── Main entry point ────────────────────────────────────────────────────────
async function startTunnel(localPort) {
  // 1. System ssh.exe → Serveo (OUTBOUND — bypasses all firewalls)
  try {
    const r = await startViaSystemSSH(localPort, 20000);
    return r;
  } catch (e1) {
    console.warn('[C3] System SSH failed:', e1.message);
  }

  // 2. ssh2 library → Serveo (pure JS fallback)
  try {
    const r = await startViaSsh2Serveo(localPort, 12000);
    return r;
  } catch (e2) {
    console.warn('[C3] ssh2 Serveo failed:', e2.message);
  }

  // 3. Node.js LAN proxy (same network only)
  try {
    const r = await startNodeProxy(localPort);
    console.warn('[C3] ⚠️  Using LAN proxy — ONLY works if both devices are on the same Wi-Fi!');
    return r;
  } catch (e3) {
    console.warn('[C3] LAN proxy failed:', e3.message);
  }

  throw new Error('All tunnel methods failed. Check internet connectivity and try again.');
}

function stopTunnel() {
  if (serveoProcess) { try { serveoProcess.kill(); } catch (_) {} serveoProcess = null; }
  if (currentClient) { try { currentClient.end(); } catch (_) {} currentClient = null; }
  if (proxyServer)   { try { proxyServer.close(); } catch (_) {} proxyServer   = null; }
}

module.exports = { startTunnel, stopTunnel, getLanIp };

'use strict';
/**
 * container-tunnel.js
 *
 * Runs a Serveo reverse SSH tunnel FROM INSIDE the Docker container (Linux).
 *
 * KEY FIX: Use Tty:true on docker exec → raw output (no binary frame headers).
 * Without Tty:true, Docker multiplexes stdout/stderr with 8-byte binary headers,
 * corrupting our text search for "serveo.net:PORT".
 */

const Docker = require('dockerode');
const docker = new Docker();

const activeTunnels = new Map(); // sessionId → exec stream

/**
 * Run one SSH reverse-tunnel attempt inside the container.
 * outboundPort: the port used to REACH serveo.net (22 = standard, 443 = firewall bypass)
 */
function tryServeoPort(container, outboundPort, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Serveo timeout (outbound port ${outboundPort})`)); }
    }, timeoutMs);

    const done = (val, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };

    // ssh -v gives verbose output — helps capture the "Forwarding TCP connections" line
    const sshCmd = [
      'ssh', '-v',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ConnectTimeout=12',
      '-o', 'ExitOnForwardFailure=yes',
      '-p', String(outboundPort),
      '-R', '0:localhost:22',   // 0 = Serveo picks the public port
      'serveo.net',
      '-N',                     // no remote command — tunnel only
    ];

    console.log(`[C3 Tunnel] In-container SSH (port ${outboundPort}): ${sshCmd.join(' ')}`);

    let exec, stream;
    try {
      exec = await container.exec({
        Cmd:           sshCmd,
        AttachStdout:  true,
        AttachStderr:  true,
        Tty:           true,   // ← CRITICAL: raw output, no 8-byte binary frame headers
      });
      stream = await exec.start({ hijack: true, stdin: false });
    } catch (e) {
      return done(null, new Error(`docker exec failed: ${e.message}`));
    }

    let buf = '';

    stream.on('data', (chunk) => {
      const text = chunk.toString();
      buf += text;
      process.stdout.write(`[Serveo:${outboundPort}] ${text}`);

      if (settled) return;
      // Serveo prints: "Forwarding TCP connections from serveo.net:PORT"
      const m = buf.match(/serveo\.net:(\d+)/);
      if (m) {
        const port = parseInt(m[1]);
        if (port > 1000) {
          console.log(`\n[C3 Tunnel] ✅ Serveo → serveo.net:${port} (via outbound port ${outboundPort})`);
          done({ host: 'serveo.net', port, stream });
        }
      }
    });

    stream.on('end', () => {
      if (!settled) {
        done(null, new Error(
          `SSH exited before allocating port (outbound ${outboundPort}). ` +
          `Last output: ${buf.slice(-300)}`
        ));
      }
    });

    stream.on('error', (err) => done(null, err));
  });
}

/**
 * Start Serveo tunnel from inside the container.
 * Tries port 22 (standard), then port 443 (HTTPS — never blocked).
 */
async function startContainerTunnel(sessionId) {
  const container = docker.getContainer(`c3-${sessionId}`);

  // Quick sanity check: is ssh client installed?
  try {
    const chk = await container.exec({
      Cmd: ['which', 'ssh'], AttachStdout: true, Tty: true,
    });
    const s = await chk.start({ hijack: true, stdin: false });
    let out = '';
    s.on('data', c => { out += c.toString(); });
    await new Promise(r => s.on('end', r));
    if (!out.includes('/ssh')) {
      throw new Error('ssh binary not found in container — was c3-base:latest used?');
    }
    console.log('[C3 Tunnel] ssh client found in container:', out.trim());
  } catch (e) {
    console.warn('[C3 Tunnel] ssh check warning:', e.message);
  }

  // Attempt 1: outbound port 22
  console.log('[C3 Tunnel] Attempt 1: Serveo via outbound port 22...');
  try {
    const r = await tryServeoPort(container, 22, 20000);
    activeTunnels.set(sessionId, r.stream);
    return { host: r.host, port: r.port };
  } catch (e) {
    console.warn('[C3 Tunnel] Port 22 failed:', e.message);
  }

  // Attempt 2: outbound port 443 (HTTPS — bypasses all firewalls)
  console.log('[C3 Tunnel] Attempt 2: Serveo via outbound port 443...');
  try {
    const r = await tryServeoPort(container, 443, 20000);
    activeTunnels.set(sessionId, r.stream);
    return { host: r.host, port: r.port };
  } catch (e) {
    console.warn('[C3 Tunnel] Port 443 failed:', e.message);
  }

  throw new Error(
    'Container SSH tunnel failed on both port 22 and 443. ' +
    'Check internet connectivity inside Docker container.'
  );
}

function stopContainerTunnel(sessionId) {
  const stream = activeTunnels.get(sessionId);
  if (stream) {
    try { stream.destroy(); } catch (_) {}
    activeTunnels.delete(sessionId);
  }
}

module.exports = { startContainerTunnel, stopContainerTunnel };

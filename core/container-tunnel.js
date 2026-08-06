'use strict';
/**
 * container-tunnel.js
 *
 * Runs a Serveo reverse SSH tunnel FROM INSIDE the Docker container (Linux).
 *
 * WHY INSIDE THE CONTAINER (not Windows host)?
 *  - The container is Linux → zero Windows Firewall interference
 *  - Docker NAT always allows outbound connections from the container
 *  - No IP detection needed (no Docker/VirtualBox/WSL wrong-IP problems)
 *  - Works on campus WiFi, 4G, corporate NAT — any network
 *
 * HOW IT WORKS:
 *  1. We docker-exec a background ssh command inside the container
 *  2. The container connects outbound to serveo.net (port 22 or 443)
 *  3. Serveo allocates a public port: serveo.net:PORT → container:22
 *  4. We capture PORT from the process output
 *  5. User SSHes to serveo.net:PORT — routed through Serveo to container sshd
 */

const Docker = require('dockerode');
const docker = new Docker();

// Track active tunnel exec processes keyed by sessionId
const activeTunnels = new Map();

/**
 * Try to create a Serveo tunnel from inside the container using a given SSH port.
 * Returns { host: 'serveo.net', port: N } on success, rejects on timeout.
 */
function tryServeoPort(container, containerSshdPort, sshOutboundPort, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Serveo timeout on outbound port ${sshOutboundPort}`)); }
    }, timeoutMs);

    const done = (val, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };

    // SSH command to run INSIDE the container:
    // -o StrictHostKeyChecking=no  → skip host key prompt (batch mode)
    // -o ServerAliveInterval=15    → keep connection alive
    // -o ExitOnForwardFailure=yes  → fail fast if port forward fails
    // -R 0:localhost:22            → ask Serveo to pick a port, forward to container sshd on 22
    // -N                           → no remote command (port-forward only)
    const sshCmd = [
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ConnectTimeout=12',
      '-o', 'ExitOnForwardFailure=yes',
      '-p', String(sshOutboundPort),   // outbound port to reach Serveo's SSH server
      '-R', `0:localhost:${containerSshdPort}`,
      'serveo.net',
      '-N',
    ];

    console.log(`[C3 Tunnel] Running in container: ${sshCmd.join(' ')}`);

    let exec;
    try {
      exec = await container.exec({
        Cmd: sshCmd,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
    } catch (e) {
      return done(null, new Error(`docker exec failed: ${e.message}`));
    }

    let stream;
    try {
      stream = await exec.start({ hijack: true, stdin: false });
    } catch (e) {
      return done(null, new Error(`exec start failed: ${e.message}`));
    }

    let outputBuf = '';

    // Demux stdout/stderr from the Docker multiplexed stream
    container.modem.demuxStream(stream, 
      // stdout handler
      {
        write: (chunk) => {
          const text = chunk.toString();
          outputBuf += text;
          process.stdout.write(`[Serveo stdout] ${text}`);
          checkForPort(text);
        }
      },
      // stderr handler
      {
        write: (chunk) => {
          const text = chunk.toString();
          outputBuf += text;
          process.stdout.write(`[Serveo stderr] ${text}`);
          checkForPort(text);
        }
      }
    );

    stream.on('end', () => {
      if (!settled) done(null, new Error(`SSH process ended without allocating port. Output: ${outputBuf.slice(0, 200)}`));
    });

    stream.on('error', (err) => done(null, err));

    function checkForPort(text) {
      if (settled) return;
      // Serveo prints: "Forwarding TCP connections from serveo.net:PORT"
      const m = text.match(/serveo\.net:(\d+)/);
      if (m) {
        const port = parseInt(m[1]);
        if (port > 1000) {
          console.log(`[C3 Tunnel] ✅ Serveo allocated: serveo.net:${port}`);
          done({ host: 'serveo.net', port, stream });
        }
      }
    }
  });
}

/**
 * Main tunnel entry point.
 *
 * Tries Serveo with outbound port 22 first (standard SSH),
 * then falls back to port 443 if port 22 is blocked by the campus/corporate network.
 * The container is Linux, so Docker NAT routes these outbound connections fine.
 */
async function startContainerTunnel(sessionId, containerSshdPort = 22) {
  const container = docker.getContainer(`c3-${sessionId}`);

  // Verify container has the 'ssh' client binary installed
  // (installed as part of openssh-client in our Dockerfile)
  try {
    const check = await container.exec({ Cmd: ['which', 'ssh'], AttachStdout: true });
    const s = await check.start({ hijack: true, stdin: false });
    await new Promise(r => s.on('end', r));
  } catch (e) {
    console.warn('[C3 Tunnel] ssh client check failed (non-fatal):', e.message);
  }

  // Attempt 1: outbound port 22 (standard SSH, fast)
  console.log('[C3 Tunnel] Attempt 1: Serveo via outbound port 22 from container...');
  try {
    const result = await tryServeoPort(container, containerSshdPort, 22, 20000);
    activeTunnels.set(sessionId, result.stream);
    return { host: result.host, port: result.port };
  } catch (e1) {
    console.warn('[C3 Tunnel] Port 22 outbound failed:', e1.message);
  }

  // Attempt 2: outbound port 443 (HTTPS port — never blocked on any network)
  console.log('[C3 Tunnel] Attempt 2: Serveo via outbound port 443 from container...');
  try {
    const result = await tryServeoPort(container, containerSshdPort, 443, 20000);
    activeTunnels.set(sessionId, result.stream);
    return { host: result.host, port: result.port };
  } catch (e2) {
    console.warn('[C3 Tunnel] Port 443 outbound failed:', e2.message);
  }

  throw new Error(
    'Container could not reach serveo.net on port 22 or 443. ' +
    'Check internet connectivity inside the container.'
  );
}

/**
 * Stop the tunnel for a session (kills the exec stream).
 */
function stopContainerTunnel(sessionId) {
  const stream = activeTunnels.get(sessionId);
  if (stream) {
    try { stream.destroy(); } catch (_) {}
    activeTunnels.delete(sessionId);
    console.log(`[C3 Tunnel] Stopped tunnel for session ${sessionId}`);
  }
}

module.exports = { startContainerTunnel, stopContainerTunnel };

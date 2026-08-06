'use strict';
/**
 * container-tunnel.js
 *
 * Creates a reverse SSH tunnel FROM INSIDE the Docker container (Linux).
 * Tries multiple tunnel services as fallbacks.
 */

const Docker = require('dockerode');
const docker = new Docker();

const activeTunnels = new Map();

// ── Helper: run a command in the container and return its output ──────────────
async function execInContainer(container, cmd, timeoutMs = 10000) {
  return new Promise(async (resolve) => {
    try {
      const exec = await container.exec({
        Cmd: ['/bin/bash', '-c', cmd],
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      let out = '';
      stream.on('data', c => { out += c.toString(); });
      stream.on('end', () => resolve(out));
      stream.on('error', () => resolve(''));
      setTimeout(() => { try { stream.destroy(); } catch (_) {} resolve(out); }, timeoutMs);
    } catch (e) {
      resolve('ERROR: ' + e.message);
    }
  });
}

// ── Pre-flight: check internet connectivity from inside the container ─────────
async function checkContainerInternet(container) {
  console.log('[C3 Tunnel] Checking internet from inside container...');

  // Test 1: DNS resolution
  const dnsTest = await execInContainer(container,
    'getent hosts google.com && echo DNS_OK || echo DNS_FAIL', 5000);
  console.log('[C3 Tunnel] DNS test:', dnsTest.trim());

  // Test 2: TCP connectivity to serveo.net:22
  const tcpTest22 = await execInContainer(container,
    'timeout 5 bash -c "echo > /dev/tcp/serveo.net/22" 2>&1 && echo TCP22_OK || echo TCP22_FAIL', 8000);
  console.log('[C3 Tunnel] TCP to serveo.net:22:', tcpTest22.trim());

  // Test 3: TCP connectivity to serveo.net:443
  const tcpTest443 = await execInContainer(container,
    'timeout 5 bash -c "echo > /dev/tcp/serveo.net/443" 2>&1 && echo TCP443_OK || echo TCP443_FAIL', 8000);
  console.log('[C3 Tunnel] TCP to serveo.net:443:', tcpTest443.trim());

  const port22ok  = tcpTest22.includes('TCP22_OK');
  const port443ok = tcpTest443.includes('TCP443_OK');
  const dnsOk     = dnsTest.includes('DNS_OK');

  return { dnsOk, port22ok, port443ok };
}

// ── Core: try one SSH reverse-tunnel command in the container ─────────────────
function tryTunnel(container, sshCmd, portPattern, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`Tunnel timeout after ${timeoutMs}ms. Cmd: ${sshCmd.join(' ')}`)); }
    }, timeoutMs);

    const done = (val, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(val);
    };

    console.log('[C3 Tunnel] Running:', sshCmd.join(' '));

    let exec, stream;
    try {
      exec = await container.exec({
        Cmd: sshCmd,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,   // raw bytes — no Docker 8-byte binary frame headers
      });
      stream = await exec.start({ hijack: true, stdin: false });
    } catch (e) {
      return done(null, new Error('docker exec failed: ' + e.message));
    }

    let buf = '';

    stream.on('data', (chunk) => {
      const text = chunk.toString();
      buf += text;
      // Log every line for debugging
      process.stdout.write('[Tunnel output] ' + text);

      if (settled) return;
      const m = buf.match(portPattern);
      if (m) {
        const port = parseInt(m[1]);
        if (port > 1000) {
          console.log('\n[C3 Tunnel] ✅ Port allocated:', m[0]);
          done({ stream, matchedText: m[0], port });
        }
      }
    });

    stream.on('end', () => {
      if (!settled) done(null, new Error('SSH exited without allocating port. Output: ' + buf.slice(-400)));
    });
    stream.on('error', err => done(null, err));
  });
}

// ── Tunnel strategies ─────────────────────────────────────────────────────────
async function startContainerTunnel(sessionId) {
  const container = docker.getContainer(`c3-${sessionId}`);

  // Verify ssh is installed
  const sshPath = await execInContainer(container, 'which ssh', 5000);
  console.log('[C3 Tunnel] ssh binary:', sshPath.trim());
  if (!sshPath.includes('ssh')) {
    throw new Error('ssh client not found in container — c3-base image may not have openssh-client');
  }

  // Pre-flight internet check
  const { dnsOk, port22ok, port443ok } = await checkContainerInternet(container);

  if (!dnsOk) {
    throw new Error('Container has NO internet access (DNS failed). Check Docker Desktop network settings.');
  }

  // ── Strategy 1: Serveo on port 22 ──────────────────────────────────────────
  if (port22ok) {
    console.log('[C3 Tunnel] Strategy 1: Serveo via port 22...');
    try {
      const r = await tryTunnel(container, [
        'ssh',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ServerAliveInterval=20',
        '-o', 'ConnectTimeout=15',
        '-o', 'ExitOnForwardFailure=yes',
        '-R', '0:localhost:22',
        'serveo.net', '-N',
      ], /serveo\.net:(\d+)/, 35000);
      activeTunnels.set(sessionId, r.stream);
      const port = r.port;
      return { host: 'serveo.net', port };
    } catch (e) {
      console.warn('[C3 Tunnel] Strategy 1 failed:', e.message);
    }
  } else {
    console.warn('[C3 Tunnel] Skipping port 22 — TCP test failed');
  }

  // ── Strategy 2: Serveo on port 443 ─────────────────────────────────────────
  if (port443ok) {
    console.log('[C3 Tunnel] Strategy 2: Serveo via port 443...');
    try {
      const r = await tryTunnel(container, [
        'ssh',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ServerAliveInterval=20',
        '-o', 'ConnectTimeout=15',
        '-o', 'ExitOnForwardFailure=yes',
        '-p', '443',
        '-R', '0:localhost:22',
        'serveo.net', '-N',
      ], /serveo\.net:(\d+)/, 35000);
      activeTunnels.set(sessionId, r.stream);
      const port = r.port;
      return { host: 'serveo.net', port };
    } catch (e) {
      console.warn('[C3 Tunnel] Strategy 2 failed:', e.message);
    }
  } else {
    console.warn('[C3 Tunnel] Skipping port 443 — TCP test failed');
  }

  // ── Strategy 3: localhost.run on port 22 ────────────────────────────────────
  console.log('[C3 Tunnel] Strategy 3: localhost.run...');
  try {
    const r = await tryTunnel(container, [
      'ssh',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ConnectTimeout=15',
      '-R', '0:localhost:22',
      'nokey@localhost.run', '-N',
    ], /(\d+)\.localhost\.run:(\d+)|localhost\.run:(\d+)/, 35000);
    activeTunnels.set(sessionId, r.stream);
    // localhost.run format varies — extract host:port from matched text
    const txt = r.matchedText;
    const portMatch = txt.match(/:(\d+)/);
    const port = portMatch ? parseInt(portMatch[1]) : r.port;
    return { host: 'localhost.run', port };
  } catch (e) {
    console.warn('[C3 Tunnel] Strategy 3 failed:', e.message);
  }

  throw new Error(
    `All tunnel strategies failed.\n` +
    `  DNS: ${dnsOk ? '✅' : '❌'}  Port 22: ${port22ok ? '✅' : '❌'}  Port 443: ${port443ok ? '✅' : '❌'}\n` +
    `Check Electron console for detailed output from each attempt.`
  );
}

function stopContainerTunnel(sessionId) {
  const s = activeTunnels.get(sessionId);
  if (s) { try { s.destroy(); } catch (_) {} activeTunnels.delete(sessionId); }
}

module.exports = { startContainerTunnel, stopContainerTunnel };

'use strict';
const { Client } = require('ssh2');

let sshConn       = null;
let sshStream     = null;
let sftpSession   = null;
let telemetryInterval = null;

/**
 * Try one SSH connection attempt with the given username.
 * Returns a resolved Promise on success, rejects on error/timeout.
 */
function tryOnce(host, port, username, privateKeyPem, onData, onClose, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      if (ok) resolve(conn);
      else { try { conn.end(); } catch (_) {} reject(err); }
    };

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 220, rows: 50 }, (err, stream) => {
        if (err) return done(false, err);
        sshStream = stream;
        stream
          .on('data',  (d) => { if (onData)  onData(d.toString()); })
          .on('close', ()  => { if (onClose) onClose(); try { conn.end(); } catch (_) {} });
        done(true);
      });
    });

    conn.on('error', (err) => {
      console.error(`[C3 SSH] ${username}@${host}:${port} error:`, err.message);
      done(false, err);
    });

    conn.connect({
      host,
      port:         parseInt(port),
      username,
      privateKey:   privateKeyPem,
      readyTimeout: timeoutMs,
      // Acceptable algorithms — match what ubuntu openssh supports
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
        serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256'],
      },
    });
  });
}

/**
 * Connect with retry + username fallback.
 * Tries c3user, then root, each up to MAX_ATTEMPTS times with increasing wait.
 */
async function connect(host, port, privateKeyPem, onData, onClose) {
  const USERS        = ['root', 'c3user'];
  const MAX_ATTEMPTS = 5;
  const TIMEOUT_MS   = 20000; // 20 seconds per attempt

  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    for (const user of USERS) {
      try {
        console.log(`[C3 SSH] Attempt ${attempt}/${MAX_ATTEMPTS} as ${user}@${host}:${port}`);
        const conn = await tryOnce(host, port, user, privateKeyPem, onData, onClose, TIMEOUT_MS);
        sshConn = conn;
        console.log(`[C3 SSH] Connected as ${user}@${host}:${port}`);
        return true;
      } catch (err) {
        lastErr = err;
        console.warn(`[C3 SSH] Failed (${user}): ${err.message}`);
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      const wait = attempt * 2000; // 2s, 4s, 6s, 8s backoff
      console.log(`[C3 SSH] Retrying in ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  throw lastErr || new Error('SSH connection failed after all retries');
}

function sendInput(text) {
  if (sshStream) sshStream.write(text);
}

function resizeTerminal(cols, rows) {
  if (sshStream) sshStream.setWindow(rows, cols);
}

function startTelemetry(onMetrics) {
  if (telemetryInterval) clearInterval(telemetryInterval);

  telemetryInterval = setInterval(() => {
    if (!sshConn) return;
    sshConn.exec("top -bn1 | grep 'Cpu(s)' && free -m", (err, stream) => {
      if (err) return;
      let output = '';
      stream.on('data', (d) => { output += d.toString(); })
            .on('close', () => {
        try {
          const lines      = output.trim().split('\n');
          let cpuPct       = 0, ramUsedMB = 0, ramTotalMB = 0;
          if (lines[0]?.includes('Cpu(s)')) {
            const m = lines[0].match(/(\d+\.\d+)\s+us/);
            if (m) cpuPct = parseFloat(m[1]);
          }
          const memLine = lines.find(l => l.startsWith('Mem:'));
          if (memLine) {
            const p = memLine.split(/\s+/);
            ramTotalMB = parseInt(p[1], 10);
            ramUsedMB  = parseInt(p[2], 10);
          }
          if (onMetrics) onMetrics({ cpuPct, ramUsedMB, ramTotalMB });
        } catch (e) { console.error('Telemetry parse error', e); }
      });
    });
  }, 3000);
}

function stopTelemetry() {
  if (telemetryInterval) { clearInterval(telemetryInterval); telemetryInterval = null; }
}

async function openSftp() {
  return new Promise((resolve, reject) => {
    if (!sshConn) return reject(new Error('SSH not connected'));
    sshConn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftpSession = sftp;
      resolve();
    });
  });
}

async function listFiles(remotePath) {
  return new Promise((resolve, reject) => {
    if (!sftpSession) return reject(new Error('SFTP not initialized'));
    sftpSession.readdir(remotePath, (err, list) => err ? reject(err) : resolve(list));
  });
}

async function uploadFile(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    if (!sftpSession) return reject(new Error('SFTP not initialized'));
    sftpSession.fastPut(localPath, remotePath, (err) => err ? reject(err) : resolve());
  });
}

async function downloadFile(remotePath, localPath) {
  return new Promise((resolve, reject) => {
    if (!sftpSession) return reject(new Error('SFTP not initialized'));
    sftpSession.fastGet(remotePath, localPath, (err) => err ? reject(err) : resolve());
  });
}

function disconnect() {
  stopTelemetry();
  if (sshConn) { try { sshConn.end(); } catch (_) {} sshConn = null; }
  sshStream   = null;
  sftpSession = null;
}

module.exports = {
  connect, sendInput, resizeTerminal,
  startTelemetry, stopTelemetry,
  openSftp, listFiles, uploadFile, downloadFile,
  disconnect,
};

'use strict';
const Docker = require('dockerode');
const docker = new Docker();

async function isDockerRunning() {
  try { await docker.ping(); return true; }
  catch { return false; }
}

// Real public images — no Docker Hub login needed
const IMAGE_MAP = {
  'base':        'ubuntu:22.04',
  'ai':          'pytorch/pytorch:2.3.0-cuda11.8-cudnn8-runtime',
  'datascience': 'jupyter/datascience-notebook:latest',
};

/**
 * Build the container startup command.
 * We write the public key via an env var (C3_PUBKEY) to completely avoid
 * shell-injection / quote-escaping issues with echo '...'.
 */
function buildStartupScript() {
  // Injected via ENV to avoid shell escaping issues
  return ['/bin/bash', '-c', [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y -qq openssh-server',
    'mkdir -p /var/run/sshd /run/sshd',
    'ssh-keygen -A', // Generate host SSH keys
    // Create c3user if missing
    'id -u c3user >/dev/null 2>&1 || useradd -m -s /bin/bash c3user',
    // Set up root SSH authorized_keys
    'mkdir -p /root/.ssh && chmod 700 /root/.ssh',
    'echo "$C3_PUBKEY" > /root/.ssh/authorized_keys',
    'chmod 600 /root/.ssh/authorized_keys',
    // Set up c3user SSH authorized_keys
    'mkdir -p /home/c3user/.ssh && chmod 700 /home/c3user/.ssh',
    'echo "$C3_PUBKEY" > /home/c3user/.ssh/authorized_keys',
    'chmod 600 /home/c3user/.ssh/authorized_keys',
    'chown -R c3user:c3user /home/c3user/.ssh',
    // Configure sshd_config
    'echo "PermitRootLogin yes"                  >> /etc/ssh/sshd_config',
    'echo "PubkeyAuthentication yes"             >> /etc/ssh/sshd_config',
    'echo "PasswordAuthentication no"            >> /etc/ssh/sshd_config',
    'echo "AuthorizedKeysFile .ssh/authorized_keys" >> /etc/ssh/sshd_config',
    'echo "StrictModes no"                       >> /etc/ssh/sshd_config',
    // Auto-restart loop: if sshd restarts or drops connection, container stays ALIVE forever
    'while true; do /usr/sbin/sshd -D -e; sleep 1; done',
  ].join(' && ')];
}

async function ensureImage(image) {
  const images = await docker.listImages({ filters: { reference: [image] } });
  if (images.length === 0) {
    console.log(`[C3 Docker] Pulling ${image} ...`);
    const stream = await docker.pull(image);
    await new Promise((resolve, reject) =>
      docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res))
    );
    console.log(`[C3 Docker] Pull complete: ${image}`);
  }
}

/**
 * Wait until sshd is actually listening on the host port.
 * Polls cleanly without abruptly killing the SSH handshake.
 */
async function waitForSshd(container, hostPort, maxWaitMs = 120_000) {
  const net = require('net');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 1500));
    
    // Check if container is alive
    try {
      const info = await container.inspect();
      if (!info.State.Running) {
        throw new Error(`Container exited with code ${info.State.ExitCode}`);
      }
    } catch (e) {
      if (e.message.includes('exited')) throw e;
    }

    const alive = await new Promise(resolve => {
      const s = net.connect({ host: '127.0.0.1', port: parseInt(hostPort) }, () => {
        s.end(); // Clean end instead of brutal destroy
        resolve(true);
      });
      s.on('error', () => resolve(false));
      s.setTimeout(1500, () => { s.end(); resolve(false); });
    });
    
    if (alive) {
      console.log(`[C3 Docker] sshd ready on port ${hostPort} after ${Date.now() - start}ms`);
      return;
    }
    console.log(`[C3 Docker] Waiting for sshd on :${hostPort}…`);
  }
  throw new Error(`sshd did not start within ${maxWaitMs / 1000}s`);
}

async function startSession(sessionId, environment, cpuCores, ramGb, publicKey, cudaRequested) {
  const image = IMAGE_MAP[environment] || IMAGE_MAP['base'];
  await ensureImage(image);

  // Dynamic host port: 3000-3999 range based on sessionId hash to avoid conflicts
  const portOffset = parseInt(sessionId.replace(/-/g, '').slice(0, 4), 16) % 1000;
  const hostPort   = String(3000 + portOffset);

  // Force-remove any existing container with same name (prevents 409 Conflict)
  try {
    const existing = docker.getContainer(`c3-${sessionId}`);
    await existing.stop({ t: 1 }).catch(() => {});
    await existing.remove({ force: true }).catch(() => {});
  } catch (_) {}

  const containerConfig = {
    Image: image,
    name:  `c3-${sessionId}`,
    Cmd:   buildStartupScript(),
    // Inject public key via ENV — safe, no escaping issues
    Env: [`C3_PUBKEY=${publicKey || ''}`],
    ExposedPorts: { '22/tcp': {} },
    HostConfig: {
      CpuQuota:  cpuCores * 100_000,
      CpuPeriod: 100_000,
      Memory:    ramGb * 1024 * 1024 * 1024,
      PortBindings: { '22/tcp': [{ HostPort: hostPort }] },
    },
  };

  if (cudaRequested) {
    containerConfig.HostConfig.DeviceRequests = [{ Count: -1, Capabilities: [['gpu']] }];
  }

  const container = await docker.createContainer(containerConfig);
  await container.start();

  // Actively wait for sshd to accept connections (not a blind sleep)
  await waitForSshd(container, hostPort);

  return { container, hostPort };
}

async function stopSession(sessionId) {
  try {
    const container = docker.getContainer(`c3-${sessionId}`);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
    console.log(`[C3 Docker] Session ${sessionId} stopped.`);
  } catch (err) {
    console.error(`[C3 Docker] stopSession error:`, err.message);
  }
}

async function getContainerStats(sessionId) {
  try {
    const container = docker.getContainer(`c3-${sessionId}`);
    const stats = await container.stats({ stream: false });
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpus     = stats.cpu_stats.online_cpus || 1;
    const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
    return { cpuPercent, memoryUsageBytes: stats.memory_stats.usage || 0 };
  } catch {
    return { cpuPercent: 0, memoryUsageBytes: 0 };
  }
}

module.exports = { isDockerRunning, startSession, stopSession, getContainerStats };

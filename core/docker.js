'use strict';
const Docker = require('dockerode');
const docker = new Docker();

async function isDockerRunning() {
  try { await docker.ping(); return true; }
  catch { return false; }
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
 * Wait until sshd inside the container is actually accepting connections.
 * Uses docker exec + bash /dev/tcp trick — no host port mapping needed.
 */
async function waitForSshd(container, maxWaitMs = 180_000) {
  const start = Date.now();
  let attempt = 0;

  console.log('[C3 Docker] Waiting for sshd inside container (apt-get may take 60-90s)...');

  while (Date.now() - start < maxWaitMs) {
    attempt++;
    await new Promise(r => setTimeout(r, 3000));

    // Make sure container is still alive
    try {
      const info = await container.inspect();
      if (!info.State.Running) {
        throw new Error(`Container exited prematurely (code ${info.State.ExitCode})`);
      }
    } catch (e) {
      if (e.message.includes('exited')) throw e;
    }

    // Test TCP port 22 inside container via bash /dev/tcp
    // IMPORTANT: Tty:true → raw output, no 8-byte binary Docker frame headers
    const ready = await new Promise(async resolve => {
      try {
        const exec = await container.exec({
          Cmd: ['/bin/bash', '-c',
            'echo "" > /dev/tcp/localhost/22 2>/dev/null && echo SSHD_READY || echo SSHD_NOT_READY'],
          AttachStdout: true,
          AttachStderr: true,
          Tty:          true,   // raw stream — no binary frame headers
        });
        const stream = await exec.start({ hijack: true, stdin: false });
        let out = '';
        stream.on('data', chunk => { out += chunk.toString(); });
        stream.on('end', () => resolve(out.includes('SSHD_READY')));
        stream.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 4000);
      } catch { resolve(false); }
    });

    if (ready) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[C3 Docker] ✅ sshd ready inside container after ${elapsed}s (${attempt} probes)`);
      return;
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[C3 Docker] ⏳ Probe #${attempt}: sshd not ready yet (${elapsed}s — apt-get still running)`);
  }

  throw new Error(`sshd not ready after ${maxWaitMs / 1000}s`);
}

async function startSession(sessionId, environment, cpuCores, ramGb, publicKey, cudaRequested) {
  // Use pre-built c3-base:latest image — openssh-server + openssh-client already installed.
  // Container starts instantly (no apt-get delay). Entrypoint writes public key + starts sshd.
  const image = 'c3-base:latest';
  await ensureImage(image);

  // Force-remove any existing container with same name
  try {
    const existing = docker.getContainer(`c3-${sessionId}`);
    await existing.stop({ t: 1 }).catch(() => {});
    await existing.remove({ force: true }).catch(() => {});
  } catch (_) {}

  const containerConfig = {
    Image: image,
    name:  `c3-${sessionId}`,
    // Public key injected via ENV — entrypoint writes it to authorized_keys
    Env: [`C3_PUBKEY=${publicKey || ''}`],
    // No host port binding — tunnel runs from inside the container via Serveo
    HostConfig: {
      CpuQuota:  cpuCores * 100_000,
      CpuPeriod: 100_000,
      Memory:    ramGb * 1024 * 1024 * 1024,
    },
  };

  if (cudaRequested) {
    containerConfig.HostConfig.DeviceRequests = [{ Count: -1, Capabilities: [['gpu']] }];
  }

  const container = await docker.createContainer(containerConfig);
  await container.start();
  console.log(`[C3 Docker] Container c3-${sessionId} started (using c3-base:latest — instant!)`);

  // Wait until sshd is up inside the container
  await waitForSshd(container);

  return { container };
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

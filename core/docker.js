'use strict';
const Docker = require('dockerode');
const docker = new Docker();

async function isDockerRunning() {
  try { await docker.ping(); return true; }
  catch { return false; }
}

// Real public images — no Docker Hub login needed
const IMAGE_MAP = {
  'base':        'c3-base:latest',          // our custom pre-built image (openssh-server + client)
  'ai':          'pytorch/pytorch:2.3.0-cuda11.8-cudnn8-runtime',
  'datascience': 'jupyter/datascience-notebook:latest',
};

async function ensureImage(image) {
  // For our custom c3-base image, check if it exists locally (built from Dockerfile)
  if (image === 'c3-base:latest') {
    const images = await docker.listImages({ filters: { reference: ['c3-base'] } });
    if (images.length === 0) {
      throw new Error(
        'c3-base Docker image not found. Run: docker build -t c3-base ./docker/base'
      );
    }
    return;
  }

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
 * Wait until sshd inside the container is accepting SSH connections.
 * Uses docker exec to run a quick TCP check rather than exposing a host port.
 *
 * We run: nc -z localhost 22 (netcat) inside the container to verify sshd is up.
 */
async function waitForSshd(container, maxWaitMs = 120_000) {
  const start   = Date.now();
  let attempt   = 0;

  console.log('[C3 Docker] Waiting for sshd inside container...');

  while (Date.now() - start < maxWaitMs) {
    attempt++;
    await new Promise(r => setTimeout(r, 2000));

    // Make sure container is still alive
    try {
      const info = await container.inspect();
      if (!info.State.Running) {
        throw new Error(`Container exited prematurely (code ${info.State.ExitCode})`);
      }
    } catch (e) {
      if (e.message.includes('exited')) throw e;
    }

    // Check sshd via exec: bash -c 'cat /dev/tcp/localhost/22' or nc
    const ready = await new Promise(async resolve => {
      try {
        const exec = await container.exec({
          Cmd: ['/bin/bash', '-c', 'echo "" > /dev/tcp/localhost/22 2>/dev/null && echo OK'],
          AttachStdout: true,
          AttachStderr: false,
        });
        const stream = await exec.start({ hijack: true, stdin: false });
        let out = '';
        stream.on('data', chunk => { out += chunk.toString(); });
        stream.on('end', () => resolve(out.includes('OK')));
        stream.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 3000);
      } catch { resolve(false); }
    });

    if (ready) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[C3 Docker] ✅ sshd ready inside container after ${elapsed}s (${attempt} probes)`);
      return;
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[C3 Docker] ⏳ Probe #${attempt}: sshd not ready yet (${elapsed}s elapsed)`);
  }

  throw new Error(`sshd not ready after ${maxWaitMs / 1000}s`);
}

async function startSession(sessionId, environment, cpuCores, ramGb, publicKey, cudaRequested) {
  const image = IMAGE_MAP[environment] || IMAGE_MAP['base'];
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
    // Inject public key via ENV — safe, no shell escaping issues
    Env: [`C3_PUBKEY=${publicKey || ''}`],
    ExposedPorts: { '22/tcp': {} },
    HostConfig: {
      CpuQuota:  cpuCores * 100_000,
      CpuPeriod: 100_000,
      Memory:    ramGb * 1024 * 1024 * 1024,
      // NO host port binding needed!
      // The tunnel runs from inside the container via Serveo.
      // sshd on port 22 is only accessed via the container-internal Serveo tunnel.
    },
  };

  if (cudaRequested) {
    containerConfig.HostConfig.DeviceRequests = [{ Count: -1, Capabilities: [['gpu']] }];
  }

  const container = await docker.createContainer(containerConfig);
  await container.start();
  console.log(`[C3 Docker] Container c3-${sessionId} started`);

  // Wait for sshd to be ready inside the container
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

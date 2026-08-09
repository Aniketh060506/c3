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

async function startSession(sessionId, environment, cpuCores, ramGb, cudaRequested) {
  const image = 'ubuntu:22.04';
  await ensureImage(image);

  try {
    const existing = docker.getContainer(`c3-${sessionId}`);
    await existing.stop({ t: 1 }).catch(() => {});
    await existing.remove({ force: true }).catch(() => {});
  } catch (_) {}

  const containerConfig = {
    Image: image,
    name:  `c3-${sessionId}`,
    Cmd: ['tail', '-f', '/dev/null'],
    HostConfig: {
      CpuQuota:  cpuCores * 100000,
      CpuPeriod: 100000,
      Memory:    ramGb * 1024 * 1024 * 1024,
    },
  };

  if (cudaRequested) {
    containerConfig.HostConfig.DeviceRequests = [{ Count: -1, Capabilities: [['gpu']] }];
  }

  const container = await docker.createContainer(containerConfig);
  await container.start();
  console.log(`[C3 Docker] Container c3-${sessionId} started (ubuntu:22.04)`);

  return { container };
}

async function execShell(sessionId) {
  const container = docker.getContainer(`c3-${sessionId}`);
  const exec = await container.exec({
    Cmd: ['/bin/bash', '--login'],
    Env: [
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
      'LANG=C.UTF-8',
      'LC_ALL=C.UTF-8',
      'COLUMNS=140',
      'LINES=40',
      'PS1=\\u@\\h:\\w\\$ ',
      'PROMPT_COMMAND='
    ],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  return { stream, exec };
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

function getContainerRef(name) {
  return docker.getContainer(name);
}

module.exports = { isDockerRunning, startSession, stopSession, getContainerStats, execShell, getContainerRef };

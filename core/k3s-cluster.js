'use strict';

/**
 * core/k3s-cluster.js
 * K3s cluster manager for C3.
 * Uses Dockerode to spin up rancher/k3s containers as either:
 *   - Master node (consumer laptop) — runs K3s server with NFS workspace mount
 *   - Worker node (provider laptop) — runs K3s agent and joins master via Tailscale IP
 */

const Docker = require('dockerode');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const K3S_IMAGE = 'c3-k3s:latest';
const FALLBACK_K3S_IMAGE = 'rancher/k3s:v1.30.0-k3s1';
const MASTER_CONTAINER_NAME = 'c3-k3s-master';
const WORKER_CONTAINER_NAME = 'c3-k3s-worker';
const K3S_API_PORT = 6443;

let _docker = null;

function getDocker() {
  if (!_docker) {
    _docker = new Docker(
      process.platform === 'win32'
        ? { socketPath: '//./pipe/docker_engine' }
        : { socketPath: '/var/run/docker.sock' }
    );
  }
  return _docker;
}

// ── Helpers ────────────────────────────────────────────────────────────────
/**
 * Pulls a Docker image if it's not already present locally.
 * @param {string} image
 */
async function ensureImage(image = K3S_IMAGE) {
  const docker = getDocker();
  try {
    await docker.getImage(image).inspect();
    return image;
  } catch {
    try {
      await docker.getImage(FALLBACK_K3S_IMAGE).inspect();
      return FALLBACK_K3S_IMAGE;
    } catch {
      console.log(`[k3s] Pulling image ${FALLBACK_K3S_IMAGE}...`);
      await new Promise((resolve, reject) => {
        docker.pull(FALLBACK_K3S_IMAGE, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (pullErr) => {
            if (pullErr) reject(pullErr);
            else resolve();
          });
        });
      });
      console.log(`[k3s] Image pulled: ${FALLBACK_K3S_IMAGE}`);
      return FALLBACK_K3S_IMAGE;
    }
  }
}

/**
 * Removes a container by name immediately with SIGKILL if it exists.
 * Does not wait for a 5-second graceful shutdown timeout.
 * @param {string} name
 */
async function removeContainerIfExists(name) {
  const docker = getDocker();
  try {
    const container = docker.getContainer(name);
    await container.remove({ force: true, v: true });
    console.log(`[k3s] Force-removed container: ${name}`);
  } catch (err) {
    // Container doesn't exist or already removed — fine
  }
}

/**
 * Waits until the K3s API server is reachable inside the container.
 * Polls at high frequency (1s) to make cluster readiness instantaneous.
 * @param {object} container - Dockerode container object.
 * @param {number} timeoutMs
 */
async function waitForK3sReady(container, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const exec = await container.exec({
        Cmd: ['kubectl', 'get', 'nodes', '--request-timeout=3s'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const output = await new Promise((resolve) => {
        let buf = '';
        stream.on('data', (chunk) => (buf += chunk.toString()));
        stream.on('end', () => resolve(buf));
        stream.on('error', () => resolve(''));
        setTimeout(() => resolve(buf), 4000);
      });
      if (output.includes('Ready') || output.includes('master')) {
        console.log('[k3s] Cluster is ready.');
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('K3s master did not become ready within timeout.');
}

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Starts a K3s master (server) node in Docker.
 * Mounts localWorkspacePath into /workspace inside the container.
 * Binds K3s API on meshIp:6443.
 *
 * @param {{meshIp: string, clusterToken: string, localWorkspacePath: string}} opts
 * @returns {Promise<{containerId: string}>}
 */
async function startMasterNode({ meshIp, clusterToken, localWorkspacePath }) {
  await ensureImage(K3S_IMAGE);
  await removeContainerIfExists(MASTER_CONTAINER_NAME);

  const docker = getDocker();

  const container = await docker.createContainer({
    name: MASTER_CONTAINER_NAME,
    Image: K3S_IMAGE,
    Cmd: [
      'server',
      '--disable=traefik',
      '--disable=servicelb',
      '--token=' + clusterToken,
      '--bind-address=0.0.0.0',
      '--advertise-address=' + meshIp,
      '--tls-san=' + meshIp,
      '--tls-san=127.0.0.1',
      '--tls-san=localhost',
      '--node-ip=' + meshIp,
    ],
    Env: ['K3S_TOKEN=' + clusterToken],
    HostConfig: {
      Privileged: true,
      Binds: [
        '/lib/modules:/lib/modules:ro',
        localWorkspacePath + ':/workspace:rw',
      ],
      PortBindings: {
        [`${K3S_API_PORT}/tcp`]: [{ HostPort: String(K3S_API_PORT) }],
      },
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });

  await container.start();
  console.log('[k3s] Master container started:', container.id);

  // Wait for the cluster to be healthy
  await waitForK3sReady(container);

  return { containerId: container.id };
}

/**
 * Starts a K3s agent (worker) node in Docker.
 * Connects to the master via Tailscale mesh IP.
 *
 * @param {{masterMeshIp: string, clusterToken: string, gpuEnabled?: boolean}} opts
 * @returns {Promise<{containerId: string}>}
 */
async function startWorkerNode({ masterMeshIp, clusterToken, gpuEnabled = false }) {
  await ensureImage(K3S_IMAGE);
  await removeContainerIfExists(WORKER_CONTAINER_NAME);

  const docker = getDocker();

  const deviceRequests = gpuEnabled
    ? [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }]
    : [];

  const container = await docker.createContainer({
    name: WORKER_CONTAINER_NAME,
    Image: K3S_IMAGE,
    Cmd: ['agent', '--server=https://' + masterMeshIp + ':' + K3S_API_PORT],
    Env: [
      'K3S_URL=https://' + masterMeshIp + ':' + K3S_API_PORT,
      'K3S_TOKEN=' + clusterToken,
    ],
    HostConfig: {
      Privileged: true,
      NetworkMode: 'host',
      Binds: ['/lib/modules:/lib/modules:ro'],
      RestartPolicy: { Name: 'unless-stopped' },
      ...(gpuEnabled ? { DeviceRequests: deviceRequests } : {}),
    },
  });

  await container.start();
  console.log('[k3s] Worker container started:', container.id);
  return { containerId: container.id };
}

let _nodesCache = null;
let _nodesCacheTime = 0;
let _nodesPendingPromise = null;

/**
 * Stops and removes both K3s master and worker containers if running.
 */
async function stopCluster() {
  _nodesCache = null;
  _nodesCacheTime = 0;
  _nodesPendingPromise = null;
  await Promise.allSettled([
    removeContainerIfExists(MASTER_CONTAINER_NAME),
    removeContainerIfExists(WORKER_CONTAINER_NAME),
  ]);
  console.log('[k3s] All C3 cluster containers stopped.');
}

/**
 * Returns node information from the cluster via `kubectl get nodes -o json`
 * executed inside the master container.
 * Uses a 1.5s in-memory cache and Promise deduplication to avoid redundant Docker exec calls.
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<object[]>} Array of Kubernetes node objects.
 */
async function getClusterNodes(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _nodesCache && (now - _nodesCacheTime < 1500)) {
    return _nodesCache;
  }
  if (_nodesPendingPromise) {
    return _nodesPendingPromise;
  }

  _nodesPendingPromise = (async () => {
    const docker = getDocker();
    try {
      const container = docker.getContainer(MASTER_CONTAINER_NAME);
      const exec = await container.exec({
        Cmd: ['kubectl', 'get', 'nodes', '-o', 'json', '--request-timeout=3s'],
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });
      const raw = await new Promise((resolve, reject) => {
        let buf = '';
        docker.modem.demuxStream(
          stream,
          { write: chunk => (buf += chunk.toString('utf8')) },
          { write: () => {} }
        );
        stream.on('end', () => resolve(buf));
        stream.on('error', reject);
        setTimeout(() => resolve(buf), 6000);
      });

      const parsed = JSON.parse(raw);
      _nodesCache = parsed.items || [];
      _nodesCacheTime = Date.now();
      return _nodesCache;
    } catch (err) {
      return _nodesCache || [];
    } finally {
      _nodesPendingPromise = null;
    }
  })();

  return _nodesPendingPromise;
}

module.exports = {
  startMasterNode,
  startWorkerNode,
  stopCluster,
  getClusterNodes,
};

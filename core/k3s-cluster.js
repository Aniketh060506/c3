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

const os = require('os');
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
      try {
        await docker.getImage(FALLBACK_K3S_IMAGE).tag({ repo: 'c3-k3s', tag: 'latest' });
      } catch (_) {}
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
      try {
        await docker.getImage(FALLBACK_K3S_IMAGE).tag({ repo: 'c3-k3s', tag: 'latest' });
      } catch (_) {}
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
  const resolvedImage = await ensureImage(K3S_IMAGE);
  await removeContainerIfExists(MASTER_CONTAINER_NAME);

  const docker = getDocker();

  const container = await docker.createContainer({
    name: MASTER_CONTAINER_NAME,
    Image: resolvedImage,
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
      '--node-name=c3-control-plane',
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

  // Read authoritative node token generated by K3s master
  let realToken = clusterToken;
  try {
    const tokenExec = await container.exec({
      Cmd: ['cat', '/var/lib/rancher/k3s/server/node-token'],
      AttachStdout: true,
      AttachStderr: false,
    });
    const stream = await tokenExec.start({ hijack: true, stdin: false });
    const output = await new Promise((resolve) => {
      let buf = '';
      stream.on('data', (chunk) => (buf += chunk.toString()));
      stream.on('end', () => resolve(buf.trim()));
      stream.on('error', () => resolve(''));
      setTimeout(() => resolve(buf.trim()), 3000);
    });
    if (output && output.length > 5) {
      realToken = output;
      console.log('[k3s] Authoritative cluster token retrieved');
    }
  } catch (_) {}

  return { containerId: container.id, clusterToken: realToken };
}

/**
 * Starts a K3s agent (worker) node in Docker.
 * Connects to the master via Tailscale mesh IP.
 *
 * @param {{masterMeshIp: string, clusterToken: string, gpuEnabled?: boolean, nodeName?: string, localWorkspacePath?: string}} opts
 * @returns {Promise<{containerId: string}>}
 */
async function startWorkerNode({ masterMeshIp, clusterToken, gpuEnabled = false, localWorkspacePath, nodeName }) {
  const resolvedImage = await ensureImage(K3S_IMAGE);
  await removeContainerIfExists(WORKER_CONTAINER_NAME);

  const docker = getDocker();

  const deviceRequests = gpuEnabled
    ? [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }]
    : [];

  // Use a dynamic node name so multiple worker laptops can join without name collisions!
  const targetNodeName = nodeName || `c3-worker-${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  const fs = require('fs');
  const path = require('path');
  let wsHostPath = localWorkspacePath;
  if (!wsHostPath || !fs.existsSync(wsHostPath)) {
    wsHostPath = path.join(os.homedir(), 'c3_workspace');
    if (!fs.existsSync(wsHostPath)) {
      try { fs.mkdirSync(wsHostPath, { recursive: true }); } catch (_) {}
    }
  }

  // Copy train script into provider workspace if available so worker has files locally
  try {
    const srcScript = path.join(__dirname, '..', 'train_distributed_model.py');
    const destScript = path.join(wsHostPath, 'train_distributed_model.py');
    if (fs.existsSync(srcScript) && !fs.existsSync(destScript)) {
      fs.copyFileSync(srcScript, destScript);
    }
  } catch (_) {}

  const binds = [
    '/lib/modules:/lib/modules:ro',
    `${wsHostPath}:/workspace:rw`,
  ];

  // Ensure old node password entry is cleared from master before starting
  try {
    const masterContainer = docker.getContainer(MASTER_CONTAINER_NAME);
    const nodeName2 = targetNodeName;
    const clearExec = await masterContainer.exec({
      Cmd: ['/bin/sh', '-c',
        `kubectl delete node ${nodeName2} 2>/dev/null; ` +
        `grep -v '${nodeName2}' /var/lib/rancher/k3s/server/cred/passwd > /tmp/p 2>/dev/null && mv /tmp/p /var/lib/rancher/k3s/server/cred/passwd 2>/dev/null; ` +
        `echo cleared`
      ],
      AttachStdout: false,
      AttachStderr: false,
    });
    await clearExec.start({ hijack: true, stdin: false });
  } catch (_) {}

  const container = await docker.createContainer({
    name: WORKER_CONTAINER_NAME,
    Image: resolvedImage,
    Cmd: [
      'agent',
      '--server=https://' + masterMeshIp + ':' + K3S_API_PORT,
      '--node-name=' + targetNodeName,
    ],
    Env: [
      'K3S_URL=https://' + masterMeshIp + ':' + K3S_API_PORT,
      'K3S_TOKEN=' + clusterToken,
    ],
    HostConfig: {
      Privileged: true,
      NetworkMode: 'host',
      Binds: binds,
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

async function exportHostKubeconfig() {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const docker = getDocker();
    const container = docker.getContainer(MASTER_CONTAINER_NAME);
    const exec = await container.exec({
      Cmd: ['cat', '/etc/rancher/k3s/k3s.yaml'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const raw = await new Promise((resolve, reject) => {
      let buf = '';
      stream.on('data', chunk => (buf += chunk.toString('utf8')));
      stream.on('end', () => resolve(buf));
      stream.on('error', reject);
      setTimeout(() => resolve(buf), 5000);
    });
    if (!raw.includes('clusters:')) return false;

    const cleaned = raw.replace(/https:\/\/(0\.0\.0\.0|127\.0\.0\.1):6443/g, 'https://127.0.0.1:6443');
    const kubeDir = path.join(os.homedir(), '.kube');
    if (!fs.existsSync(kubeDir)) {
      fs.mkdirSync(kubeDir, { recursive: true });
    }
    const c3Path = path.join(kubeDir, 'c3-config.yaml');
    fs.writeFileSync(c3Path, cleaned, 'utf8');
    return true;
  } catch (e) {
    console.warn('[k3s] exportHostKubeconfig note:', e.message);
    return false;
  }
}

async function deployDefaultPods() {
  const docker = getDocker();
  try {
    const container = docker.getContainer(MASTER_CONTAINER_NAME);
    const manifests = `
apiVersion: v1
kind: Pod
metadata:
  name: c3-worker-runner
  namespace: default
spec:
  nodeName: c3-control-plane
  restartPolicy: Always
  tolerations:
  - operator: "Exists"
  containers:
  - name: runner
    image: alpine:latest
    command: ["/bin/sh", "-c", "sleep infinity"]
    volumeMounts:
    - name: workspace-storage
      mountPath: /workspace
  volumes:
  - name: workspace-storage
    hostPath:
      path: /workspace
---
apiVersion: v1
kind: Pod
metadata:
  name: redis
  namespace: default
  labels:
    app: redis
spec:
  restartPolicy: Always
  tolerations:
  - operator: "Exists"
  containers:
  - name: redis
    image: redis:alpine
    ports:
    - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: default
spec:
  selector:
    app: redis
  ports:
  - port: 6379
    targetPort: 6379
`;
    const b64 = Buffer.from(manifests).toString('base64');
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', `echo "${b64}" | base64 -d > /tmp/c3-pods.yaml && kubectl apply -f /tmp/c3-pods.yaml`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise((resolve) => {
      stream.on('end', resolve);
      stream.on('error', resolve);
      setTimeout(resolve, 8000);
    });
    console.log('[k3s] Default workload pods (c3-worker-runner & redis) applied — waiting for Running...');

    // ── Poll until c3-worker-runner is Running (up to 5 minutes) ─────────
    // alpine:latest is ~5MB so should pull fast via K3s containerd
    const deadline = Date.now() + 300_000;
    let podRunning = false;
    let lastPhase = '';
    while (Date.now() < deadline) {
      try {
        const phaseExec = await container.exec({
          Cmd: ['kubectl', 'get', 'pod', 'c3-worker-runner',
            '-o', 'jsonpath={.status.phase}', '--request-timeout=5s'],
          AttachStdout: true,
          AttachStderr: true,
        });
        const phaseStream = await phaseExec.start({ hijack: true, stdin: false });
        const phase = await new Promise((resolve) => {
          let buf = '';
          phaseStream.on('data', chunk => (buf += chunk.toString()));
          phaseStream.on('end', () => resolve(buf.trim()));
          phaseStream.on('error', () => resolve(''));
          setTimeout(() => resolve(buf.trim()), 6000);
        });
        if (phase === 'Running') {
          console.log('[k3s] c3-worker-runner pod is Running.');
          podRunning = true;
          break;
        }
        // Only log when phase changes to avoid spam
        if (phase !== lastPhase) {
          console.log(`[k3s] c3-worker-runner phase: ${phase || 'pending'} — waiting for image pull...`);
          lastPhase = phase;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!podRunning) {
      console.warn('[k3s] c3-worker-runner did not reach Running within 5 minutes — continuing anyway.');
    }

    // ── Sync /workspace files from master into pod via kubectl cp ─────────
    // Pod already mounts the same hostPath (/workspace) as master, so files
    // are identical. kubectl cp is a belt-and-suspenders copy that also
    // ensures late-arriving files (synced after pod start) are visible.
    try {
      const cpExec = await container.exec({
        Cmd: ['/bin/sh', '-c',
          'count=$(ls /workspace 2>/dev/null | wc -l | tr -d " "); ' +
          'echo "[k3s] /workspace has $count files on master"; ' +
          'if [ "$count" -gt "0" ]; then ' +
          '  kubectl cp /workspace/. c3-worker-runner:/workspace/ 2>/dev/null && echo "[k3s] kubectl cp done"; ' +
          'fi'
        ],
        AttachStdout: true,
        AttachStderr: true,
      });
      const cpStream = await cpExec.start({ hijack: true, stdin: false });
      const cpOut = await new Promise(resolve => {
        let buf = '';
        cpStream.on('data', chunk => (buf += chunk.toString()));
        cpStream.on('end', () => resolve(buf.trim()));
        cpStream.on('error', () => resolve(''));
        setTimeout(() => resolve(buf.trim()), 30_000); // 30s max for large workspace
      });
      console.log('[k3s] Workspace sync:', cpOut || 'done');
    } catch (cpErr) {
      console.warn('[k3s] kubectl cp workspace note:', cpErr.message);
    }
  } catch (err) {
    console.warn('[k3s] deployDefaultPods note:', err.message);
  }
}

module.exports = {
  startMasterNode,
  startWorkerNode,
  stopCluster,
  getClusterNodes,
  exportHostKubeconfig,
  deployDefaultPods,
};

'use strict';

/**
 * core/k3s-cluster.js
 * K3s cluster manager for C3.
 * Uses Dockerode to spin up rancher/k3s containers as either:
 *   - Master node (consumer laptop) — runs K3s server with Tailscale sidecar
 *   - Worker node (provider laptop) — runs K3s agent with Tailscale sidecar
 *
 * Section E: Tailscale sidecar per K3s container for cross-machine networking.
 * Section E4: Solo mode (no Tailscale key) uses bridge mode, no sidecar.
 */

const Docker = require('dockerode');
const { exec } = require('child_process');
const { promisify } = require('util');

const os = require('os');
const execAsync = promisify(exec);

const K3S_IMAGE = 'c3-k3s:latest';
const FALLBACK_K3S_IMAGE = 'rancher/k3s:v1.30.0-k3s1';
const TS_IMAGE = 'tailscale/tailscale:stable';
const MASTER_CONTAINER_NAME = 'c3-k3s-master';
const WORKER_CONTAINER_NAME = 'c3-k3s-worker';
const MASTER_TS_CONTAINER_NAME = 'c3-ts-master';
const WORKER_TS_CONTAINER_NAME = 'c3-ts-worker';
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
 * Section E11: Ensure Tailscale sidecar image is present.
 * Follows the same pattern as ensureImage.
 */
async function ensureTailscaleImage() {
  const docker = getDocker();
  try {
    await docker.getImage(TS_IMAGE).inspect();
    return;
  } catch {
    console.log(`[k3s] Pulling Tailscale image ${TS_IMAGE}...`);
    await new Promise((resolve, reject) => {
      docker.pull(TS_IMAGE, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (pullErr) => {
          if (pullErr) reject(pullErr);
          else resolve();
        });
      });
    });
    console.log(`[k3s] Tailscale image pulled: ${TS_IMAGE}`);
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
 * Section E5: Waits until the K3s node named `nodeName` shows exactly "True" in
 * the Ready condition. Polls every 2s.
 * @param {object} masterContainer - Dockerode container object.
 * @param {string} nodeName
 * @param {number} timeoutMs
 */
async function waitForNodeReady(masterContainer, nodeName, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const execObj = await masterContainer.exec({
        Cmd: ['kubectl', 'get', 'node', nodeName,
          '-o', `jsonpath={.status.conditions[?(@.type=="Ready")].status}`,
          '--request-timeout=3s'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await execObj.start({ hijack: true, stdin: false });
      const output = await new Promise((resolve) => {
        let buf = '';
        stream.on('data', (chunk) => (buf += chunk.toString()));
        stream.on('end', () => resolve(buf.trim()));
        stream.on('error', () => resolve(''));
        setTimeout(() => resolve(buf.trim()), 4000);
      });
      const ready = output.replace(/['"]/g, '').trim();
      if (ready === 'True') {
        console.log(`[k3s] Node ${nodeName} is Ready.`);
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Section E5: Waits until the K3s API server reports c3-control-plane Ready.
 * Uses the exact condition check instead of string-matching output that could
 * falsely match "NotReady".
 * @param {object} container - Dockerode container object.
 * @param {number} timeoutMs
 */
async function waitForK3sReady(container, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ready = await waitForNodeReady(container, 'c3-control-plane', 5000);
      if (ready) {
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

/**
 * Section E1: Starts a Tailscale sidecar container.
 * @param {{ name: string, hostname: string, authKey: string }} opts
 * @returns {Promise<string>} The 100.x Tailscale IP.
 */
async function startTailscaleSidecar({ name, hostname, authKey }) {
  await ensureTailscaleImage();
  const docker = getDocker();
  await removeContainerIfExists(name);

  // Sanitize hostname (Tailscale hostnames must be lowercase alphanumeric+dash)
  const safeHostname = hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 63);
  const volName = `${name}-state`;

  const container = await docker.createContainer({
    name,
    Image: TS_IMAGE,
    Env: [
      `TS_AUTHKEY=${authKey}`,
      `TS_HOSTNAME=${safeHostname}`,
      `TS_STATE_DIR=/var/lib/tailscale`,
      `TS_USERSPACE=false`,
      `TS_EXTRA_ARGS=--accept-routes`,
    ],
    HostConfig: {
      Privileged: true,
      CapAdd: ['NET_ADMIN', 'NET_RAW'],
      Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
      Binds: [`${volName}:/var/lib/tailscale`],
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });

  await container.start();
  console.log(`[k3s] Tailscale sidecar "${name}" started.`);

  // Poll for 100.x IP (up to 60s)
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const execObj = await container.exec({
        Cmd: ['tailscale', 'ip', '-4'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await execObj.start({ hijack: true, stdin: false });
      const output = await new Promise((resolve) => {
        let buf = '';
        stream.on('data', chunk => (buf += chunk.toString()));
        stream.on('end', () => resolve(buf.trim()));
        stream.on('error', () => resolve(''));
        setTimeout(() => resolve(buf.trim()), 3000);
      });
      const ip = output.split('\n').find(l => l.trim().startsWith('100.'));
      if (ip) {
        console.log(`[k3s] Tailscale sidecar "${name}" got IP: ${ip.trim()}`);
        return ip.trim();
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Tailscale sidecar "${name}" did not get a 100.x IP within 60 seconds.`);
}

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Section E2: Starts a K3s master (server) node in Docker.
 * If tailscaleAuthKey is provided, starts a Tailscale sidecar first and uses
 * container network mode. Otherwise (E4 solo mode), uses bridge mode.
 *
 * @param {{meshIp: string, clusterToken: string, localWorkspacePath: string, tailscaleAuthKey?: string}} opts
 * @returns {Promise<{containerId: string, clusterToken: string, masterIp: string}>}
 */
async function startMasterNode({ meshIp, clusterToken, localWorkspacePath, tailscaleAuthKey }) {
  const resolvedImage = await ensureImage(K3S_IMAGE);
  await removeContainerIfExists(MASTER_CONTAINER_NAME);

  const docker = getDocker();
  const fs = require('fs');
  const path = require('path');

  let wsHostPath = localWorkspacePath;
  if (!wsHostPath || !fs.existsSync(wsHostPath)) {
    wsHostPath = path.join(os.homedir(), 'c3_workspace');
    if (!fs.existsSync(wsHostPath)) {
      try { fs.mkdirSync(wsHostPath, { recursive: true }); } catch (_) {}
    }
  }

  const safeHostname = `c3-master-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40)}`;

  let masterTsIp = null;
  let usesSidecar = false;

  if (tailscaleAuthKey && tailscaleAuthKey.startsWith('tskey-')) {
    // Section E2: start sidecar, use container network mode
    console.log('[k3s] Starting Tailscale sidecar for master...');
    masterTsIp = await startTailscaleSidecar({
      name: MASTER_TS_CONTAINER_NAME,
      hostname: safeHostname,
      authKey: tailscaleAuthKey,
    });
    usesSidecar = true;
  } else {
    // Section E4: solo mode — use consumer's mesh IP or fall back to container IP
    masterTsIp = meshIp;
  }

  const k3sCmd = ['server',
    '--disable=traefik',
    '--disable=servicelb',
    '--token=' + clusterToken,
    '--bind-address=0.0.0.0',
    '--node-name=c3-control-plane',
  ];

  if (usesSidecar) {
    // Section E2: Tailscale sidecar provides the IP inside the container network
    k3sCmd.push(
      '--node-ip=' + masterTsIp,
      '--advertise-address=' + masterTsIp,
      '--tls-san=' + masterTsIp,
      '--tls-san=127.0.0.1',
      '--flannel-iface=tailscale0'
    );
  } else {
    // Section E4: solo mode — let k3s pick the container IP; only add TLS SANs
    k3sCmd.push(
      '--tls-san=' + masterTsIp,
      '--tls-san=127.0.0.1',
      '--tls-san=localhost'
    );
  }

  const hostConfig = {
    Privileged: true,
    Binds: [
      '/lib/modules:/lib/modules:ro',
      `${wsHostPath}:/workspace:rw`,
    ],
    RestartPolicy: { Name: 'unless-stopped' },
  };

  if (usesSidecar) {
    // Section E2: share network namespace with the sidecar
    // No PortBindings allowed with container network mode
    hostConfig.NetworkMode = `container:${MASTER_TS_CONTAINER_NAME}`;
  } else {
    // Section E4: bridge mode, publish K3s API port
    hostConfig.PortBindings = {
      [`${K3S_API_PORT}/tcp`]: [{ HostPort: String(K3S_API_PORT) }],
    };
  }

  const container = await docker.createContainer({
    name: MASTER_CONTAINER_NAME,
    Image: resolvedImage,
    Cmd: k3sCmd,
    Env: ['K3S_TOKEN=' + clusterToken],
    HostConfig: hostConfig,
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

  return { containerId: container.id, clusterToken: realToken, masterIp: masterTsIp };
}

/**
 * Section E3: Starts a K3s agent (worker) node in Docker.
 * If tailscaleAuthKey is provided, starts a Tailscale sidecar and uses container
 * network mode. Otherwise the node still joins but networking may be limited.
 *
 * @param {{masterMeshIp: string, clusterToken: string, gpuEnabled?: boolean, nodeName?: string, localWorkspacePath?: string, tailscaleAuthKey?: string}} opts
 * @returns {Promise<{containerId: string}>}
 */
async function startWorkerNode({ masterMeshIp, clusterToken, gpuEnabled = false, localWorkspacePath, nodeName, tailscaleAuthKey }) {
  const resolvedImage = await ensureImage(K3S_IMAGE);
  await removeContainerIfExists(WORKER_CONTAINER_NAME);

  const docker = getDocker();
  const fs = require('fs');
  const path = require('path');

  const deviceRequests = gpuEnabled
    ? [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }]
    : [];

  // Use a dynamic node name so multiple worker laptops can join without name collisions!
  const targetNodeName = nodeName || `c3-worker-${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const safeHostname = `c3-worker-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40)}`;

  let wsHostPath = localWorkspacePath;
  if (!wsHostPath || !fs.existsSync(wsHostPath)) {
    wsHostPath = path.join(os.homedir(), 'c3_workspace');
    if (!fs.existsSync(wsHostPath)) {
      try { fs.mkdirSync(wsHostPath, { recursive: true }); } catch (_) {}
    }
  }

  const binds = [
    '/lib/modules:/lib/modules:ro',
    `${wsHostPath}:/workspace:rw`,
  ];

  let workerTsIp = null;
  let usesSidecar = false;

  if (tailscaleAuthKey && tailscaleAuthKey.startsWith('tskey-')) {
    // Section E3: start worker sidecar
    console.log('[k3s] Starting Tailscale sidecar for worker...');
    workerTsIp = await startTailscaleSidecar({
      name: WORKER_TS_CONTAINER_NAME,
      hostname: safeHostname,
      authKey: tailscaleAuthKey,
    });
    usesSidecar = true;
    console.log(`[k3s] Worker Tailscale IP: ${workerTsIp}`);
  }

  const agentCmd = [
    'agent',
    '--server=https://' + masterMeshIp + ':' + K3S_API_PORT,
    '--node-name=' + targetNodeName,
  ];

  if (usesSidecar && workerTsIp) {
    agentCmd.push(
      '--node-ip=' + workerTsIp,
      '--flannel-iface=tailscale0'
    );
  }

  const hostConfig = {
    Privileged: true,
    Binds: binds,
    RestartPolicy: { Name: 'unless-stopped' },
    ...(gpuEnabled ? { DeviceRequests: deviceRequests } : {}),
  };

  if (usesSidecar) {
    // Section E3: share network namespace with the sidecar, no 'host' network
    hostConfig.NetworkMode = `container:${WORKER_TS_CONTAINER_NAME}`;
  }
  // Note: no NetworkMode 'host' — removed per Section E3

  const container = await docker.createContainer({
    name: WORKER_CONTAINER_NAME,
    Image: resolvedImage,
    Cmd: agentCmd,
    Env: [
      'K3S_URL=https://' + masterMeshIp + ':' + K3S_API_PORT,
      'K3S_TOKEN=' + clusterToken,
    ],
    HostConfig: hostConfig,
  });

  await container.start();
  console.log('[k3s] Worker container started:', container.id);
  return { containerId: container.id, workerTsIp };
}

let _nodesCache = null;
let _nodesCacheTime = 0;
let _nodesPendingPromise = null;

/**
 * Section E10: Stops and removes all C3 cluster containers, including Tailscale sidecars.
 * Runs `tailscale logout` inside each sidecar before removing them.
 */
async function stopCluster() {
  _nodesCache = null;
  _nodesCacheTime = 0;
  _nodesPendingPromise = null;

  // Section E10: logout from Tailscale inside sidecars before removing
  const docker = getDocker();
  for (const tsName of [MASTER_TS_CONTAINER_NAME, WORKER_TS_CONTAINER_NAME]) {
    try {
      const tsContainer = docker.getContainer(tsName);
      await tsContainer.inspect(); // check if exists
      const logoutExec = await tsContainer.exec({
        Cmd: ['tailscale', 'logout'],
        AttachStdout: false,
        AttachStderr: false,
      });
      await logoutExec.start({ hijack: true, stdin: false });
      await new Promise(r => setTimeout(r, 1000)); // brief wait for logout
    } catch (_) {}
  }

  await Promise.allSettled([
    removeContainerIfExists(MASTER_CONTAINER_NAME),
    removeContainerIfExists(WORKER_CONTAINER_NAME),
    removeContainerIfExists(MASTER_TS_CONTAINER_NAME),
    removeContainerIfExists(WORKER_TS_CONTAINER_NAME),
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

/**
 * Section E8: Deploys a c3-runner DaemonSet (one runner per node) plus Redis.
 * Waits until the DaemonSet's numberReady equals desiredNumberScheduled.
 * The hostPath /workspace mount replaces kubectl cp.
 */
async function deployDefaultPods() {
  const docker = getDocker();
  try {
    const container = docker.getContainer(MASTER_CONTAINER_NAME);
    const manifests = `
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: c3-runner
  namespace: default
  labels:
    app: c3-runner
spec:
  selector:
    matchLabels:
      app: c3-runner
  template:
    metadata:
      labels:
        app: c3-runner
    spec:
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
    console.log('[k3s] c3-runner DaemonSet and redis applied — waiting for pods...');

    // Section E8: wait until DaemonSet numberReady == desiredNumberScheduled (5 min timeout)
    const deadline = Date.now() + 300_000;
    let dsReady = false;
    let lastStatus = '';
    while (Date.now() < deadline) {
      try {
        const dsExec = await container.exec({
          Cmd: ['kubectl', 'get', 'daemonset', 'c3-runner',
            '-o', 'jsonpath={.status.numberReady}/{.status.desiredNumberScheduled}',
            '--request-timeout=5s'],
          AttachStdout: true,
          AttachStderr: true,
        });
        const dsStream = await dsExec.start({ hijack: true, stdin: false });
        const dsOut = await new Promise((resolve) => {
          let buf = '';
          dsStream.on('data', chunk => (buf += chunk.toString()));
          dsStream.on('end', () => resolve(buf.trim()));
          dsStream.on('error', () => resolve(''));
          setTimeout(() => resolve(buf.trim()), 6000);
        });
        const [ready, desired] = dsOut.replace(/'/g, '').split('/').map(s => parseInt(s, 10));
        if (!isNaN(ready) && !isNaN(desired) && desired > 0 && ready >= desired) {
          console.log(`[k3s] c3-runner DaemonSet ready: ${ready}/${desired}`);
          dsReady = true;
          break;
        }
        if (dsOut !== lastStatus) {
          console.log(`[k3s] c3-runner DaemonSet status: ${dsOut || 'pending'} — waiting...`);
          lastStatus = dsOut;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 5000));
    }
    if (!dsReady) {
      console.warn('[k3s] c3-runner DaemonSet did not reach full readiness within 5 minutes — continuing anyway.');
    }
  } catch (err) {
    console.warn('[k3s] deployDefaultPods note:', err.message);
  }
}

/**
 * Section E11: Checks if the Tailscale image is present.
 * @returns {Promise<{pulled: boolean}>}
 */
async function checkTailscaleImage() {
  try {
    const docker = getDocker();
    await docker.getImage(TS_IMAGE).inspect();
    return { pulled: true };
  } catch {
    return { pulled: false };
  }
}

/**
 * Section E11: Pulls the Tailscale image with progress callbacks.
 * @param {function} onProgress
 */
async function pullTailscaleImage(onProgress) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('docker', ['pull', TS_IMAGE]);
    proc.stdout.on('data', d => onProgress && onProgress(d.toString().trim()));
    proc.stderr.on('data', d => onProgress && onProgress(d.toString().trim()));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('docker pull tailscale exited with code ' + code));
    });
    proc.on('error', reject);
  });
}

module.exports = {
  startMasterNode,
  startWorkerNode,
  stopCluster,
  getClusterNodes,
  exportHostKubeconfig,
  deployDefaultPods,
  waitForNodeReady,
  checkTailscaleImage,
  pullTailscaleImage,
  ensureTailscaleImage,
  TS_IMAGE,
};

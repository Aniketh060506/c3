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
 *
 * Bug fixes applied:
 *  1. Shared execCapture() helper — all exec reads use demuxStream + once-guard.
 *  2. Tailscale CLI inside sidecar containers uses --socket=/tmp/tailscaled.sock.
 *  3. startTailscaleSidecar validates IP with regex; richer timeout error.
 *  4. node-token pattern check; kubeconfig apiVersion guard; sidecar server URL fix.
 */

const Docker = require('dockerode');
const os = require('os');

const K3S_IMAGE = 'c3-k3s:latest';
const FALLBACK_K3S_IMAGE = 'rancher/k3s:v1.30.0-k3s1';
const TS_IMAGE = 'tailscale/tailscale:stable';
const MASTER_CONTAINER_NAME = 'c3-k3s-master';
const WORKER_CONTAINER_NAME = 'c3-k3s-worker';
const MASTER_TS_CONTAINER_NAME = 'c3-ts-master';
const WORKER_TS_CONTAINER_NAME = 'c3-ts-worker';
const K3S_API_PORT = 6443;

// Fix 2: socket path used by the Tailscale CLI inside official tailscale/tailscale containers
const TS_SOCKET = '/tmp/tailscaled.sock';

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

// ── Fix 1: Shared exec-capture helper ─────────────────────────────────────
/**
 * Run a command inside a container and capture stdout + stderr via demuxStream.
 * The `done` callback is guarded so it resolves exactly once even if both
 * 'end' and setTimeout fire.
 *
 * @param {object} container  - Dockerode container object
 * @param {string[]} cmd      - Command array
 * @param {number} timeoutMs  - Max wait (default 10 s)
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null}>}
 */
async function execCapture(container, cmd, timeoutMs = 10000) {
  const docker = getDocker();
  const ex = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await ex.start({ hijack: true, stdin: false });
  return new Promise((resolve) => {
    let out = '', err = '';
    let settled = false;

    docker.modem.demuxStream(
      stream,
      { write: (c) => { out += c.toString('utf8'); } },
      { write: (c) => { err += c.toString('utf8'); } }
    );

    const done = async () => {
      if (settled) return;
      settled = true;
      let exitCode = null;
      try { exitCode = (await ex.inspect()).ExitCode; } catch (_) {}
      resolve({ stdout: out.trim(), stderr: err.trim(), exitCode });
    };

    stream.on('end', done);
    stream.on('error', done);
    setTimeout(done, timeoutMs);
  });
}

// ── Image helpers ──────────────────────────────────────────────────────────
async function ensureImage(image = K3S_IMAGE) {
  const docker = getDocker();
  try {
    await docker.getImage(image).inspect();
    return image;
  } catch {
    try {
      await docker.getImage(FALLBACK_K3S_IMAGE).inspect();
      try { await docker.getImage(FALLBACK_K3S_IMAGE).tag({ repo: 'c3-k3s', tag: 'latest' }); } catch (_) {}
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
      try { await docker.getImage(FALLBACK_K3S_IMAGE).tag({ repo: 'c3-k3s', tag: 'latest' }); } catch (_) {}
      return FALLBACK_K3S_IMAGE;
    }
  }
}

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

async function removeContainerIfExists(name) {
  const docker = getDocker();
  try {
    const container = docker.getContainer(name);
    await container.remove({ force: true, v: true });
    console.log(`[k3s] Force-removed container: ${name}`);
  } catch (_) {}
}

// ── Fix 1 applied: waitForNodeReady uses execCapture ──────────────────────
/**
 * Polls until the named K3s node shows exactly "True" in its Ready condition.
 * @param {object} masterContainer
 * @param {string} nodeName
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForNodeReady(masterContainer, nodeName, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execCapture(
        masterContainer,
        ['kubectl', 'get', 'node', nodeName,
          '-o', `jsonpath={.status.conditions[?(@.type=="Ready")].status}`,
          '--request-timeout=3s'],
        5000
      );
      if (stdout.replace(/['"]/g, '').trim() === 'True') {
        console.log(`[k3s] Node ${nodeName} is Ready.`);
        return true;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Waits until c3-control-plane shows Ready. No artificial outer timeout —
 * waitForNodeReady handles it.
 */
async function waitForK3sReady(container, timeoutMs = 300000) {
  const ready = await waitForNodeReady(container, 'c3-control-plane', timeoutMs);
  if (!ready) throw new Error('K3s master did not become ready within timeout.');
  console.log('[k3s] Cluster is ready.');
}

// ── Fix 2+3: Tailscale sidecar startup ────────────────────────────────────
/**
 * Starts a Tailscale sidecar container and returns its 100.x IP.
 * Fix 2: CLI args include --socket=/tmp/tailscaled.sock.
 * Fix 3: IP validated with regex; timeout error includes stderr + last 15 log lines.
 */
async function startTailscaleSidecar({ name, hostname, authKey }) {
  await ensureTailscaleImage();
  const docker = getDocker();
  await removeContainerIfExists(name);

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
      // Fix 2: pin the socket path so the CLI knows where to find tailscaled
      `TS_SOCKET=${TS_SOCKET}`,
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

  // Fix 2+3: use correct socket path; validate IP with regex
  const TS_IP_RE = /^100\.\d+\.\d+\.\d+$/;
  const deadline = Date.now() + 60000;
  let lastStderr = '';

  while (Date.now() < deadline) {
    try {
      // Fix 2: --socket arg
      const { stdout, stderr } = await execCapture(
        container,
        ['tailscale', `--socket=${TS_SOCKET}`, 'ip', '-4'],
        4000
      );
      if (stderr) lastStderr = stderr;
      // Fix 3: validate each line with regex
      const ip = stdout.split('\n').map(l => l.trim()).find(l => TS_IP_RE.test(l));
      if (ip) {
        console.log(`[k3s] Tailscale sidecar "${name}" got IP: ${ip}`);
        return ip;
      }
    } catch (e) {
      lastStderr = e.message || lastStderr;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Fix 3: include stderr and last 15 log lines in the error message
  let logTail = '';
  try {
    const logBuf = await new Promise((resolve, reject) => {
      container.logs({ stdout: true, stderr: true, tail: 15 }, (err, stream) => {
        if (err) return reject(err);
        let buf = '';
        stream.on('data', (d) => { buf += d.toString('utf8'); });
        stream.on('end', () => resolve(buf.trim()));
        stream.on('error', reject);
        setTimeout(() => resolve(buf.trim()), 3000);
      });
    });
    logTail = logBuf;
  } catch (_) {}

  throw new Error(
    `Tailscale sidecar "${name}" did not get a 100.x IP within 60 seconds.\n` +
    `Last stderr: ${lastStderr || '(empty)'}\n` +
    `Container logs (last 15):\n${logTail || '(none)'}`
  );
}

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Starts the K3s master (server) node.
 * Fix 4: node-token validated; kubeconfig export uses masterTsIp in sidecar mode.
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
    console.log('[k3s] Starting Tailscale sidecar for master...');
    masterTsIp = await startTailscaleSidecar({
      name: MASTER_TS_CONTAINER_NAME,
      hostname: safeHostname,
      authKey: tailscaleAuthKey,
    });
    usesSidecar = true;
  } else {
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
    k3sCmd.push(
      '--node-ip=' + masterTsIp,
      '--advertise-address=' + masterTsIp,
      '--tls-san=' + masterTsIp,
      '--tls-san=127.0.0.1',
      '--flannel-iface=tailscale0'
    );
  } else {
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
    hostConfig.NetworkMode = `container:${MASTER_TS_CONTAINER_NAME}`;
  } else {
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

  await waitForK3sReady(container);

  // Fix 1+4: use execCapture; validate token format
  let realToken = clusterToken;
  try {
    const { stdout: tokenOut } = await execCapture(
      container,
      ['cat', '/var/lib/rancher/k3s/server/node-token'],
      5000
    );
    // Fix 4: token must match K10... format or equal the passed token
    const K3S_TOKEN_RE = /^K10[0-9a-f]+::server:/;
    if (tokenOut && (K3S_TOKEN_RE.test(tokenOut) || tokenOut === clusterToken)) {
      realToken = tokenOut;
      console.log('[k3s] Authoritative cluster token retrieved.');
    } else if (tokenOut) {
      console.warn('[k3s] Unexpected node-token format — falling back to generated token.');
    }
  } catch (_) {}

  return { containerId: container.id, clusterToken: realToken, masterIp: masterTsIp, usesSidecar };
}

/**
 * Starts the K3s agent (worker) node.
 * Fix 2: worker sidecar uses correct socket path.
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
    hostConfig.NetworkMode = `container:${WORKER_TS_CONTAINER_NAME}`;
  }

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
 * Stops all C3 cluster containers including Tailscale sidecars.
 * Fix 2: tailscale logout uses correct socket arg.
 */
async function stopCluster() {
  _nodesCache = null;
  _nodesCacheTime = 0;
  _nodesPendingPromise = null;

  const docker = getDocker();
  for (const tsName of [MASTER_TS_CONTAINER_NAME, WORKER_TS_CONTAINER_NAME]) {
    try {
      const tsContainer = docker.getContainer(tsName);
      await tsContainer.inspect();
      // Fix 2: --socket arg for tailscale logout inside the official image
      await execCapture(tsContainer, ['tailscale', `--socket=${TS_SOCKET}`, 'logout'], 4000);
      await new Promise((r) => setTimeout(r, 500));
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
 * Returns Kubernetes node objects from kubectl get nodes.
 * Fix 1: demuxStream already used here — kept, just routed via execCapture pattern.
 */
async function getClusterNodes(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _nodesCache && (now - _nodesCacheTime < 1500)) {
    return _nodesCache;
  }
  if (_nodesPendingPromise) return _nodesPendingPromise;

  _nodesPendingPromise = (async () => {
    const docker = getDocker();
    try {
      const container = docker.getContainer(MASTER_CONTAINER_NAME);
      const { stdout } = await execCapture(
        container,
        ['kubectl', 'get', 'nodes', '-o', 'json', '--request-timeout=3s'],
        8000
      );
      const parsed = JSON.parse(stdout);
      _nodesCache = parsed.items || [];
      _nodesCacheTime = Date.now();
      return _nodesCache;
    } catch (_) {
      return _nodesCache || [];
    } finally {
      _nodesPendingPromise = null;
    }
  })();

  return _nodesPendingPromise;
}

/**
 * Reads k3s.yaml from the master container and writes it to ~/.kube/c3-config.yaml.
 * Fix 1: uses execCapture (demuxStream, no raw stream.on('data') bug).
 * Fix 4: validates content starts with "apiVersion:".
 *        In sidecar mode, rewrites server address to https://<masterTsIp>:6443.
 */
async function exportHostKubeconfig(masterTsIp) {
  try {
    const fs = require('fs');
    const path = require('path');
    const docker = getDocker();
    const container = docker.getContainer(MASTER_CONTAINER_NAME);

    const { stdout: raw } = await execCapture(
      container,
      ['cat', '/etc/rancher/k3s/k3s.yaml'],
      6000
    );

    // Fix 4: must start with "apiVersion:"
    if (!raw.startsWith('apiVersion:')) {
      console.warn('[k3s] exportHostKubeconfig: content does not look like a valid kubeconfig — skipping write.');
      return false;
    }

    // Fix 4: in sidecar mode use the actual Tailscale IP so `kubectl` works cross-machine
    const serverAddr = masterTsIp && /^100\./.test(masterTsIp)
      ? `https://${masterTsIp}:6443`
      : 'https://127.0.0.1:6443';

    const cleaned = raw.replace(
      /https:\/\/(0\.0\.0\.0|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+):6443/g,
      serverAddr
    );

    const kubeDir = path.join(os.homedir(), '.kube');
    if (!fs.existsSync(kubeDir)) fs.mkdirSync(kubeDir, { recursive: true });
    const c3Path = path.join(kubeDir, 'c3-config.yaml');
    fs.writeFileSync(c3Path, cleaned, 'utf8');
    console.log(`[k3s] kubeconfig written to ${c3Path} (server: ${serverAddr})`);
    return true;
  } catch (e) {
    console.warn('[k3s] exportHostKubeconfig note:', e.message);
    return false;
  }
}

/**
 * Deploys c3-runner DaemonSet + Redis.
 * Fix 1: DaemonSet readiness poll uses execCapture.
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
    // Apply manifests — ignore output, only care about completion
    await execCapture(
      container,
      ['/bin/sh', '-c', `echo "${b64}" | base64 -d > /tmp/c3-pods.yaml && kubectl apply -f /tmp/c3-pods.yaml`],
      10000
    );
    console.log('[k3s] c3-runner DaemonSet and redis applied — waiting for pods...');

    // Fix 1: use execCapture for DaemonSet poll
    const deadline = Date.now() + 300_000;
    let dsReady = false;
    let lastStatus = '';
    while (Date.now() < deadline) {
      try {
        const { stdout: dsOut } = await execCapture(
          container,
          ['kubectl', 'get', 'daemonset', 'c3-runner',
            '-o', 'jsonpath={.status.numberReady}/{.status.desiredNumberScheduled}',
            '--request-timeout=5s'],
          7000
        );
        const [ready, desired] = dsOut.replace(/'/g, '').split('/').map((s) => parseInt(s, 10));
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
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!dsReady) {
      console.warn('[k3s] c3-runner DaemonSet did not reach full readiness within 5 minutes — continuing anyway.');
    }
  } catch (err) {
    console.warn('[k3s] deployDefaultPods note:', err.message);
  }
}

async function checkTailscaleImage() {
  try {
    const docker = getDocker();
    await docker.getImage(TS_IMAGE).inspect();
    return { pulled: true };
  } catch {
    return { pulled: false };
  }
}

async function pullTailscaleImage(onProgress) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('docker', ['pull', TS_IMAGE]);
    proc.stdout.on('data', (d) => onProgress && onProgress(d.toString().trim()));
    proc.stderr.on('data', (d) => onProgress && onProgress(d.toString().trim()));
    proc.on('close', (code) => {
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

'use strict';

/**
 * Runs an actual Ray cluster as Kubernetes pods on the active K3s cluster and
 * submits a distributed synthetic CPU workload through Ray Jobs.
 */

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execFileAsync = promisify(execFile);
const RAY_NAMESPACE = 'c3-ray';
const RAY_IMAGE = 'rayproject/ray:2.58.0-py312';
const RAY_HEAD = 'c3-ray-head';

let _activeJob = null;
let _activeProc = null;
let _dashboardForward = null;
let _rayClusterReady = false;
let _rayNodes = [];
let _rayPodsReady = 0;
let _ipcCallback = null;
const MAX_PROJECT_BYTES = 200 * 1024 * 1024;
const EXCLUDED_PROJECT_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', 'C3-results']);

function setIpcCallback(cb) {
  _ipcCallback = cb;
}

function notifyUI(channel, data) {
  try { _ipcCallback?.(channel, data); } catch (_) {}
}

const AI_TEMPLATES = [{
  id: 'ray_synthetic_classification',
  name: 'Distributed Synthetic Classification',
  category: 'Compute benchmark',
  description: 'Runs real NumPy forward/backward passes on synthetic batches, distributed over available Ray CPU workers.',
  defaultEpochs: 3,
  batchSize: 32,
  lr: 0.001,
  framework: 'Ray + NumPy (CPU)',
}];

function getTemplates() {
  return AI_TEMPLATES;
}

async function dockerKubectl(args, options = {}) {
  const result = await execFileAsync('docker', ['exec', 'c3-k3s-master', 'kubectl', ...args], {
    timeout: options.timeout || 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function waitForRayHead(timeoutMs = 90000) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  try {
    await dockerKubectl([
      'wait', '--for=condition=Ready', `pod/${RAY_HEAD}`, '-n', RAY_NAMESPACE,
      `--timeout=${seconds}s`,
    ], { timeout: timeoutMs + 5000 });
  } catch (error) {
    const status = await dockerKubectl(['get', 'pods', '-n', RAY_NAMESPACE, '-o', 'wide']).catch(() => 'Ray pod status unavailable');
    throw new Error(`Ray head container is not ready for file transfer. ${status}. ${error.message}`);
  }
}

async function copyIntoRayHead(source, destination) {
  await waitForRayHead();
  const target = `${RAY_NAMESPACE}/${RAY_HEAD}:${destination}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await dockerKubectl(['cp', '-c', 'ray', source, target], { timeout: 120000 });
      return;
    } catch (error) {
      lastError = error;
      const message = error.message || '';
      if (!/container not found|unable to upgrade connection|container is not running|timed out|timeout/i.test(message) || attempt === 2) break;
      await waitForRayHead();
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  const status = await dockerKubectl(['get', 'pods', '-n', RAY_NAMESPACE, '-o', 'wide']).catch(() => 'Ray pod status unavailable');
  throw new Error(`Could not copy files into the Ray head container after waiting for it to be Ready. ${status}. ${lastError?.message || 'Unknown copy error'}`);
}

async function dockerExec(args, options = {}) {
  const result = await execFileAsync('docker', args, {
    timeout: options.timeout || 30000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout.trim();
}

function validateProject(workspacePath, entrypoint) {
  if (!workspacePath || !fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
    throw new Error('Launch a C3 cluster with a selected project folder first.');
  }
  const relativeEntry = String(entrypoint || '').replace(/\\/g, '/');
  if (!relativeEntry || path.posix.isAbsolute(relativeEntry) || relativeEntry.split('/').some(part => part === '..' || !part)) {
    throw new Error('Enter a Python entry point relative to the selected project folder, for example main.py.');
  }
  if (!relativeEntry.toLowerCase().endsWith('.py')) throw new Error('The project entry point must be a .py file.');
  const root = fs.realpathSync(workspacePath);
  const entry = path.resolve(root, ...relativeEntry.split('/'));
  const realEntry = fs.realpathSync(entry);
  const relative = path.relative(root, entry);
  const realRelative = path.relative(root, realEntry);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(entry) || !fs.statSync(entry).isFile()
    || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`Entry point not found inside the selected project folder: ${relativeEntry}`);
  }

  let bytes = 0;
  const walk = current => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory() && EXCLUDED_PROJECT_DIRS.has(item.name)) continue;
      const target = path.join(current, item.name);
      if (item.isDirectory()) walk(target);
      else if (item.isFile()) bytes += fs.statSync(target).size;
      if (bytes > MAX_PROJECT_BYTES) throw new Error('Project package exceeds the 200 MiB limit. Remove build outputs, virtual environments, or large data files and retry.');
    }
  };
  walk(root);
  return { entrypoint: relativeEntry, bytes };
}

async function stageProject(workspacePath, entrypoint, jobId) {
  const project = validateProject(workspacePath, entrypoint);
  const archive = `/tmp/c3-project-${jobId}.tar.gz`;
  const staging = `/tmp/c3-job/${jobId}`;
  await dockerExec(['exec', 'c3-k3s-master', 'sh', '-lc',
    `tar -czf ${archive} --exclude=.git --exclude='*/.git' --exclude=node_modules --exclude='*/node_modules' --exclude=.venv --exclude='*/.venv' --exclude=venv --exclude='*/venv' --exclude=__pycache__ --exclude='*/__pycache__' --exclude=.pytest_cache --exclude='*/.pytest_cache' --exclude=C3-results --exclude='*/C3-results' -C /workspace .`,
  ], { timeout: 120000 });
  try {
    const sizeText = await dockerExec(['exec', 'c3-k3s-master', 'stat', '-c', '%s', archive]);
    const archiveBytes = Number(sizeText);
    if (!Number.isFinite(archiveBytes) || archiveBytes > MAX_PROJECT_BYTES) {
      throw new Error('The compressed project bundle exceeds the 200 MiB transfer limit. Remove large data/build files and retry.');
    }
    await waitForRayHead();
    await dockerKubectl(['exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--', 'mkdir', '-p', staging], { timeout: 30000 });
    await copyIntoRayHead('/c3-core/project_runner.py', `${staging}/c3_project_runner.py`);
    await copyIntoRayHead(archive, `${staging}/project.tar.gz`);
    await dockerKubectl(['exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--', 'sh', '-lc',
      `mkdir -p ${staging}/project && tar -xzf ${staging}/project.tar.gz -C ${staging}/project && rm ${staging}/project.tar.gz`,
    ]);
    return { ...project, staging, archiveBytes };
  } finally {
    await dockerExec(['exec', 'c3-k3s-master', 'rm', '-f', archive]).catch(() => {});
  }
}

async function downloadProjectResults(workspacePath, jobId) {
  const resultsDirectory = path.join(workspacePath, 'C3-results', jobId);
  const containerDestination = `/workspace/C3-results/${jobId}`;
  await dockerExec(['exec', 'c3-k3s-master', 'mkdir', '-p', containerDestination]);
  await waitForRayHead();
  await dockerKubectl(['cp', '-c', 'ray', `${RAY_NAMESPACE}/${RAY_HEAD}:/tmp/c3-job/${jobId}/results`, containerDestination], { timeout: 180000 });
  await dockerKubectl(['exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--', 'rm', '-rf', `/tmp/c3-job/${jobId}`]).catch(() => {});
  return resultsDirectory;
}

function applyObject(object) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', '-i', 'c3-k3s-master', 'kubectl', 'apply', '-f', '-']);
    let stderr = '';
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `kubectl apply exited ${code}`)));
    proc.stdin.end(JSON.stringify(object));
  });
}

async function readKubernetesNodes() {
  const raw = await dockerKubectl(['get', 'nodes', '-o', 'json']);
  const parsed = JSON.parse(raw);
  return (parsed.items || []).filter(node =>
    (node.status?.conditions || []).some(c => c.type === 'Ready' && c.status === 'True')
  );
}

function rayPod(name, nodeName, role, command, allocation = { cores: 1, ramGb: 2 }) {
  const cores = Math.max(1, Number(allocation.cores) || 1);
  // Leave one quarter of the provider's limit for K3s and operating-system work.
  const rayMemoryGb = Math.max(1, Math.floor((Number(allocation.ramGb) || 2) * 0.75));
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: RAY_NAMESPACE,
      labels: { 'c3.io/name': 'ray', 'c3.io/role': role },
    },
    spec: {
      nodeName,
      restartPolicy: 'Always',
      containers: [{
        name: 'ray',
        image: RAY_IMAGE,
        imagePullPolicy: 'IfNotPresent',
        command: ['/bin/bash', '-lc', command],
        ports: role === 'head'
          ? [{ name: 'gcs', containerPort: 6379 }, { name: 'dashboard', containerPort: 8265 }]
          : [],
        resources: {
          requests: { cpu: String(cores), memory: `${rayMemoryGb}Gi` },
          limits: { cpu: String(cores), memory: `${rayMemoryGb}Gi` },
        },
        volumeMounts: [{ name: 'ray-shm', mountPath: '/dev/shm' }],
        // The supervisor command uses --block; Kubernetes should verify the
        // Ray head's actual GCS listener rather than a CLI that may not know
        // which address a worker should query.
        ...(role === 'head' ? {
          readinessProbe: {
            tcpSocket: { port: 6379 },
            initialDelaySeconds: 5,
            periodSeconds: 5,
            failureThreshold: 24,
          },
        } : {}),
      }],
      volumes: [{
        name: 'ray-shm',
        emptyDir: {
          medium: 'Memory',
          sizeLimit: `${Math.max(128, Math.floor(rayMemoryGb * 0.3 * 1024))}Mi`,
        },
      }],
    },
  };
}

async function ensureRayCluster() {
  const nodes = await readKubernetesNodes();
  if (!nodes.length) throw new Error('No Ready Kubernetes nodes are available for Ray.');

  const headNode = nodes.find(n => n.metadata?.labels?.['node-role.kubernetes.io/control-plane'] !== undefined)
    || nodes.find(n => n.metadata?.labels?.['node-role.kubernetes.io/master'] !== undefined)
    || nodes[0];
  const workerNodes = nodes.filter(n => n.metadata?.name !== headNode.metadata?.name);
  const allocationForNode = node => ({
    cores: Number(node.metadata?.labels?.['c3.io/allocated-cores']) || 1,
    ramGb: Number(node.metadata?.labels?.['c3.io/allocated-memory-gb']) || 2,
  });
  const headAllocation = allocationForNode(headNode);

  await applyObject({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: RAY_NAMESPACE } });
  await applyObject({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: RAY_HEAD, namespace: RAY_NAMESPACE, labels: { 'c3.io/name': 'ray' } },
    spec: {
      selector: { 'c3.io/role': 'head' },
      ports: [
        { name: 'gcs', port: 6379, targetPort: 6379 },
        { name: 'dashboard', port: 8265, targetPort: 8265 },
      ],
    },
  });

  await dockerKubectl(['delete', 'pods', '-n', RAY_NAMESPACE, '-l', 'c3.io/name=ray', '--ignore-not-found=true', '--wait=true']).catch(() => {});

  const headPod = rayPod(
    RAY_HEAD,
    headNode.metadata.name,
    'head',
    `ray start --head --port=6379 --dashboard-host=0.0.0.0 --dashboard-port=8265 --num-cpus=${headAllocation.cores} --block`,
    headAllocation
  );
  await applyObject(headPod);

  const workerPods = workerNodes.map((node, index) => rayPod(
    `c3-ray-worker-${index + 1}`,
    node.metadata.name,
    'worker',
    `until ray start --address=c3-ray-head.c3-ray.svc.cluster.local:6379 --num-cpus=${allocationForNode(node).cores} --block; do sleep 2; done`,
    allocationForNode(node)
  ));
  for (const pod of workerPods) await applyObject(pod);

  const expectedPods = 1 + workerPods.length;
  let readyPods = [];
  for (let attempt = 0; attempt < 90; attempt++) {
    const raw = await dockerKubectl(['get', 'pods', '-n', RAY_NAMESPACE, '-l', 'c3.io/name=ray', '-o', 'json']).catch(() => null);
    if (raw) {
      const items = JSON.parse(raw).items || [];
      readyPods = items.filter(p => p.status?.phase === 'Running' && (p.status?.containerStatuses || []).some(c => c.ready));
      if (readyPods.length >= expectedPods) break;
      const failed = items.find(p => ['Failed', 'Unknown'].includes(p.status?.phase));
      if (failed) throw new Error(`Ray pod ${failed.metadata.name} entered ${failed.status.phase}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (readyPods.length < expectedPods) {
    const states = await dockerKubectl(['get', 'pods', '-n', RAY_NAMESPACE, '-o', 'wide']).catch(() => 'Pod status unavailable');
    throw new Error(`Ray did not become ready on all ${expectedPods} assigned node(s). ${states}`);
  }

  let rayNodesJson = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    rayNodesJson = await dockerKubectl([
    'exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--', 'python', '-c',
    'import ray,json; ray.init(address="auto"); print("C3RAY:"+json.dumps([n for n in ray.nodes() if n.get("Alive")]))',
    ], { timeout: 20000 }).catch(() => '');
    const marker = rayNodesJson.lastIndexOf('C3RAY:');
    if (marker >= 0) {
      _rayNodes = JSON.parse(rayNodesJson.slice(marker + 6));
      if (_rayNodes.length >= expectedPods) break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const marker = rayNodesJson.lastIndexOf('C3RAY:');
  if (marker < 0) throw new Error(`Ray head pod is running but Ray did not return its live node list. ${rayNodesJson}`);
  _rayNodes = JSON.parse(rayNodesJson.slice(marker + 6));
  if (_rayNodes.length < expectedPods) {
    throw new Error(`Ray reports ${_rayNodes.length} live node(s), but ${expectedPods} Kubernetes nodes were assigned. Check worker connectivity and resource availability.`);
  }

  _rayClusterReady = true;
  ensureDashboardForward();
  let dashboardReady = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    dashboardReady = await probeRayDashboard();
    if (dashboardReady) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!dashboardReady) {
    _rayClusterReady = false;
    throw new Error('Ray nodes are alive, but the local Ray Jobs dashboard endpoint is not reachable on 127.0.0.1:8265.');
  }
  return { nodes: _rayNodes, kubernetesNodeCount: nodes.length, rayNodeCount: _rayNodes.length };
}

async function startRayCluster() {
  await ensureRayCluster();
  const status = await getRayClusterStatus();
  if (status.status !== 'ONLINE') {
    throw new Error(`Ray pods started, but the live cluster check failed: ${status.error || 'waiting for every node and dashboard'}`);
  }
  return status;
}

function ensureDashboardForward() {
  if (_dashboardForward && _dashboardForward.exitCode === null) return;
  _dashboardForward = spawn('docker', [
    'exec', 'c3-k3s-master', 'kubectl', 'port-forward', '--address=0.0.0.0',
    '-n', RAY_NAMESPACE, `service/${RAY_HEAD}`, '8265:8265',
  ], { stdio: 'ignore' });
  _dashboardForward.on('error', () => { _dashboardForward = null; });
  _dashboardForward.on('close', () => { _dashboardForward = null; });
}

function parseJsonFromLine(line) {
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(line.slice(start, end + 1)); } catch (_) { return null; }
}

function probeRayDashboard(timeout = 750) {
  return new Promise(resolve => {
    const request = require('http').get('http://127.0.0.1:8265/api/version', response => {
      let body = '';
      response.on('data', chunk => { body += chunk.toString(); });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(response.statusCode === 200 && Boolean(data.ray_version));
        } catch (_) { resolve(false); }
      });
    });
    request.setTimeout(timeout, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function startAiJob(options = {}) {
  if (['RUNNING', 'DOWNLOADING_RESULTS'].includes(_activeJob?.status)) throw new Error('A distributed compute job is already running.');
  const clusterStatus = await getRayClusterStatus();
  if (clusterStatus.status !== 'ONLINE') await ensureRayCluster();

  const projectMode = options.mode === 'project';
  const template = AI_TEMPLATES[0];
  const totalEpochs = Math.max(1, Math.min(100, Number(options.epochs) || template.defaultEpochs));
  const batchSize = Math.max(1, Math.min(4096, Number(options.batchSize) || template.batchSize));
  const lr = Number(options.lr) > 0 ? Number(options.lr) : template.lr;
  const jobId = `c3-${Date.now().toString(36)}`;
  const projectStage = projectMode
    ? await stageProject(options.workspacePath, options.entrypoint, jobId)
    : null;
  const scriptArgs = String(options.scriptArgs || '').slice(0, 4096);
  _activeJob = {
    jobId,
    mode: projectMode ? 'project' : 'benchmark',
    templateId: template.id,
    templateName: projectMode ? `Project · ${projectStage.entrypoint}` : template.name,
    framework: projectMode ? 'Python · Ray on each live node' : template.framework,
    status: 'RUNNING',
    startTime: Date.now(),
    totalEpochs,
    currentEpoch: 0,
    totalSteps: totalEpochs * 10,
    currentStep: 0,
    loss: null,
    initialLoss: null,
    accuracy: null,
    throughputSamplesSec: null,
    estimatedGflops: null,
    batchSize,
    learningRate: lr,
    dataKind: projectMode ? 'Workspace bundle' : 'synthetic',
    backend: projectMode ? 'Ray · node-affinity tasks' : 'Ray + NumPy CPU',
    entrypoint: projectMode ? projectStage.entrypoint : null,
    projectBytes: projectMode ? projectStage.bytes : null,
    resultsPath: null,
    artifacts: [],
    projectSuccess: null,
    workspacePath: projectMode ? options.workspacePath : null,
    nodes: [],
    lossHistory: [],
    logs: [projectMode
      ? `Bundled ${(projectStage.bytes / (1024 * 1024)).toFixed(1)} MiB of project files; submitting ${projectStage.entrypoint} to every live Ray node...`
      : `Submitting ${template.name} to the live Ray cluster...`],
  };
  notifyUI('ray:job-started', _activeJob);

  let args;
  if (projectMode) {
    args = [
      'exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--',
      'ray', 'job', 'submit', '--address=http://127.0.0.1:8265', `--submission-id=${jobId}`, `--working-dir=${projectStage.staging}`, '--',
      'python', 'c3_project_runner.py', '--entrypoint', projectStage.entrypoint,
      '--script-args', scriptArgs, '--job-id', jobId, '--results-dir', `/tmp/c3-job/${jobId}/results`,
    ];
  } else {
    await waitForRayHead();
    await dockerKubectl(['exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--', 'mkdir', '-p', '/tmp/c3-job'], { timeout: 30000 });
    await copyIntoRayHead('/c3-core/ai_trainer.py', '/tmp/c3-job/ai_trainer.py');
    args = [
      'exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--',
      'ray', 'job', 'submit', '--address=http://127.0.0.1:8265', `--submission-id=${jobId}`, '--working-dir=/tmp/c3-job', '--',
      'python', 'ai_trainer.py', '--epochs', String(totalEpochs), '--batch-size', String(batchSize), '--lr', String(lr),
    ];
  }
  _activeProc = spawn('docker', ['exec', 'c3-k3s-master', 'kubectl', ...args]);
  let outputBuffer = '';

  const consumeOutput = chunk => {
    outputBuffer += chunk.toString();
    const lines = outputBuffer.split(/\r?\n/);
    outputBuffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const data = parseJsonFromLine(line);
      if (!data || !data.type) {
        _activeJob?.logs.push(line);
        if (_activeJob) notifyUI('ray:job-progress', _activeJob);
        continue;
      }
      if (data.type === 'log') {
        _activeJob.logs.push(data.message);
      } else if (data.type === 'progress') {
        if (_activeJob.initialLoss === null) _activeJob.initialLoss = data.loss;
        _activeJob.currentEpoch = data.epoch;
        _activeJob.currentStep = data.step;
        _activeJob.totalSteps = data.totalSteps;
        _activeJob.loss = data.loss;
        _activeJob.accuracy = data.accuracy;
        _activeJob.throughputSamplesSec = data.throughput;
        _activeJob.estimatedGflops = data.estimatedGflops;
        _activeJob.nodes = data.nodes || [];
        _activeJob.dataKind = data.dataKind;
        _activeJob.backend = data.backend;
        _activeJob.lossHistory.push(data.loss);
        if (_activeJob.lossHistory.length > 30) _activeJob.lossHistory.shift();
      } else if (data.type === 'completed') {
        _activeJob.status = 'COMPLETED';
        _activeJob.completedAt = Date.now();
        _activeJob.nodes = data.nodes || [];
        _activeJob.logs.push(data.message);
        notifyUI('ray:job-completed', _activeJob);
        continue;
      } else if (data.type === 'project_result') {
        _activeJob.projectSuccess = Boolean(data.ok);
        _activeJob.nodes = data.nodes || [];
        _activeJob.artifacts = data.artifacts || [];
        _activeJob.status = 'DOWNLOADING_RESULTS';
        _activeJob.logs.push(data.message || 'Collecting per-node results...');
        if (data.error) _activeJob.logs.push(data.error);
      }
      if (_activeJob.logs.length > 60) _activeJob.logs.shift();
      notifyUI('ray:job-progress', _activeJob);
    }
  };

  _activeProc.stdout.on('data', consumeOutput);
  _activeProc.stderr.on('data', chunk => {
    const message = chunk.toString().trim();
    if (message && _activeJob) {
      _activeJob.logs.push(message);
      notifyUI('ray:job-progress', _activeJob);
    }
  });
  _activeProc.on('error', err => {
    if (_activeJob) {
      _activeJob.status = 'FAILED';
      _activeJob.logs.push(`Ray job submission failed: ${err.message}`);
      notifyUI('ray:job-stopped', _activeJob);
    }
  });
  _activeProc.on('close', async code => {
    const finishedJob = _activeJob;
    if (finishedJob?.mode === 'project' && finishedJob.status === 'DOWNLOADING_RESULTS') {
      try {
        finishedJob.resultsPath = await downloadProjectResults(finishedJob.workspacePath, finishedJob.jobId);
        finishedJob.status = finishedJob.projectSuccess && code === 0 ? 'COMPLETED' : 'FAILED';
        finishedJob.logs.push(finishedJob.status === 'COMPLETED'
          ? `Results downloaded into ${finishedJob.resultsPath}.`
          : `Partial results downloaded into ${finishedJob.resultsPath}; one or more node tasks failed.`);
      } catch (error) {
        finishedJob.status = 'FAILED';
        finishedJob.logs.push(`Could not copy results back to the workspace: ${error.message}`);
      }
      finishedJob.completedAt = Date.now();
      notifyUI(finishedJob.status === 'COMPLETED' ? 'ray:job-completed' : 'ray:job-stopped', finishedJob);
    }
    if (_activeJob?.status === 'RUNNING') {
      _activeJob.status = 'FAILED';
      _activeJob.completedAt = Date.now();
      _activeJob.logs.push(`Ray job submission exited with code ${code} without a completion record.`);
      notifyUI('ray:job-stopped', _activeJob);
    }
    _activeProc = null;
  });
  return _activeJob;
}

async function stopAiJob() {
  if (_activeJob?.status === 'RUNNING' && _activeJob.jobId && _rayClusterReady) {
    try {
      await dockerKubectl([
        'exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--', 'ray', 'job', 'stop',
        '--address=http://127.0.0.1:8265', _activeJob.jobId,
      ], { timeout: 10000 });
    } catch (_) {}
  }
  if (_activeProc) {
    _activeProc.kill();
    _activeProc = null;
  }
  if (_activeJob) {
    _activeJob.status = 'STOPPED';
    _activeJob.logs.push('Ray job submission process stopped by the user.');
    notifyUI('ray:job-stopped', _activeJob);
  }
  const previous = _activeJob;
  _activeJob = null;
  return previous;
}

function getActiveJob() {
  return _activeJob;
}

async function getRayClusterStatus() {
  let rayNodes = [];
  let nodes = [];
  _rayPodsReady = 0;
  let ready = false;
  let rayPodCount = 0;
  let dashboardReachable = false;
  let headReady = false;
  let statusReadError = null;
  try {
    nodes = await readKubernetesNodes();
    const raw = await dockerKubectl(['get', 'pods', '-n', RAY_NAMESPACE, '-l', 'c3.io/name=ray', '-o', 'json']);
    const pods = JSON.parse(raw).items || [];
    rayPodCount = pods.length;
    headReady = pods.some(p => p.metadata?.name === RAY_HEAD && p.status?.phase === 'Running' && (p.status?.containerStatuses || []).some(c => c.ready));
    if (headReady) {
      const output = await dockerKubectl([
        'exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--', 'python', '-c',
        'import ray,json; ray.init(address="auto"); print("C3RAY:"+json.dumps([n for n in ray.nodes() if n.get("Alive")]))',
      ], { timeout: 10000 });
      const marker = output.lastIndexOf('C3RAY:');
      if (marker >= 0) rayNodes = JSON.parse(output.slice(marker + 6));
      const readyPods = pods.filter(p => p.status?.phase === 'Running' && (p.status?.containerStatuses || []).some(c => c.ready));
      const expectedPods = nodes.length;
      _rayPodsReady = readyPods.length;
      ensureDashboardForward();
      // Port-forward startup is asynchronous. Give kubectl a short window to
      // bind the host port before reporting an otherwise healthy Ray cluster
      // as unconfigured on the first status refresh.
      for (let attempt = 0; attempt < 10 && !dashboardReachable; attempt++) {
        dashboardReachable = await probeRayDashboard();
        if (!dashboardReachable) await new Promise(resolve => setTimeout(resolve, 300));
      }
      ready = expectedPods > 0 && readyPods.length >= expectedPods && rayNodes.length >= expectedPods && dashboardReachable;
    }
  } catch (error) {
    ready = false;
    statusReadError = error.message || 'Kubernetes could not read Ray status.';
  }
  _rayClusterReady = ready;
  _rayNodes = rayNodes;

  let coresAvailable = null;
  try {
    if (ready) {
      const output = await dockerKubectl([
        'exec', '-n', RAY_NAMESPACE, RAY_HEAD, '--', 'python', '-c',
        'import ray,json; ray.init(address="auto"); print("C3RES:"+json.dumps(ray.cluster_resources()))',
      ], { timeout: 10000 });
      const marker = output.lastIndexOf('C3RES:');
      if (marker >= 0) coresAvailable = Number(JSON.parse(output.slice(marker + 6)).CPU ?? 0);
    }
  } catch (_) {}

  return {
    status: ready ? 'ONLINE' : 'NOT_CONFIGURED',
    error: ready ? null : !nodes.length ? 'No Ready K3s nodes are available. Start the cluster first.'
      : statusReadError || !headReady ? `Ray head is not Ready (${_rayPodsReady}/${rayPodCount} Ray pods ready). Check Nodes & Pods and the Ray pod events.`
        : _rayPodsReady < nodes.length ? `Only ${_rayPodsReady} of ${nodes.length} Ray pods are Ready; the remaining K3s nodes have no ready Ray worker yet.`
          : rayNodes.length < nodes.length ? `Ray currently reports ${rayNodes.length} live node(s) for ${nodes.length} Ready K3s node(s). Check the Ray worker pod logs and resource limits.`
            : !dashboardReachable ? 'Ray nodes are live, but the Ray Jobs dashboard is not reachable on localhost:8265.'
              : 'Ray cluster readiness could not be verified.',
    dashboardUrl: ready ? 'http://localhost:8265' : null,
    dashboardPort: ready ? 8265 : null,
    port: ready ? 6379 : null,
    rayNodeCount: rayNodes.length,
    kubernetesReadyNodeCount: (await readKubernetesNodes().catch(() => [])).length,
    rayPodsReady: _rayPodsReady,
    rayPodCount,
    rayNodes: rayNodes.map(node => node.NodeManagerAddress || node.NodeManagerHostname).filter(Boolean),
    coresAvailable,
    gpusAvailable: null,
    gpuName: null,
    plasmaMemoryGb: null,
    activeTasks: null,
    jobRunning: _activeJob?.status === 'RUNNING',
  };
}

async function stopRayCluster() {
  await stopAiJob();
  if (_dashboardForward) {
    try { _dashboardForward.kill(); } catch (_) {}
    _dashboardForward = null;
  }
  try { await dockerKubectl(['delete', 'namespace', RAY_NAMESPACE, '--ignore-not-found=true', '--wait=false']); } catch (_) {}
  _rayClusterReady = false;
  _rayNodes = [];
  _rayPodsReady = 0;
  return { status: 'STOPPED' };
}

module.exports = {
  getTemplates,
  startRayCluster,
  startAiJob,
  stopAiJob,
  getActiveJob,
  getRayClusterStatus,
  stopRayCluster,
  setIpcCallback,
};

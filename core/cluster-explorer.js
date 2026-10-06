'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const execFileAsync = promisify(execFile);

async function kubectl(args, timeout = 20000) {
  const { stdout } = await execFileAsync('docker', ['exec', 'c3-k3s-master', 'kubectl', ...args], {
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function getInventory() {
  let masterContainers;
  try {
    masterContainers = await execFileAsync('docker', [
      'ps', '--filter', 'name=^/c3-k3s-master$', '--format', '{{.Names}}',
    ], { windowsHide: true, timeout: 10000 });
  } catch (error) {
    throw new Error(`Docker is unavailable, so the live cluster inventory cannot be read: ${error.message}`);
  }
  if (!masterContainers.stdout.trim()) {
    return { ok: true, status: 'INACTIVE', nodes: [], pods: [], staleNodeNames: [], fetchedAt: new Date().toISOString() };
  }

  const [nodesText, podsText] = await Promise.all([
    kubectl(['get', 'nodes', '-o', 'json']),
    kubectl(['get', 'pods', '-A', '-o', 'json']),
  ]);
  const nodeDoc = JSON.parse(nodesText);
  const podDoc = JSON.parse(podsText);
  const allNodes = (nodeDoc.items || []).map(item => {
    const labels = item.metadata?.labels || {};
    const ready = (item.status?.conditions || []).find(c => c.type === 'Ready')?.status === 'True';
    return {
      name: item.metadata.name,
      ready,
      role: labels['node-role.kubernetes.io/control-plane'] !== undefined ? 'Control plane'
        : labels['node-role.kubernetes.io/master'] !== undefined ? 'Master' : 'Worker',
      version: item.status?.nodeInfo?.kubeletVersion || '—',
      cpu: item.status?.capacity?.cpu || '—',
      memory: item.status?.capacity?.memory || '—',
      podCount: 0,
    };
  });
  const pods = (podDoc.items || []).map(item => {
    const statuses = item.status?.containerStatuses || [];
    const containers = (item.spec?.containers || []).map(container => ({
      name: container.name,
      image: container.image,
      ready: statuses.find(status => status.name === container.name)?.ready || false,
      restarts: statuses.find(status => status.name === container.name)?.restartCount || 0,
    }));
    return {
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      node: item.spec?.nodeName || 'Unassigned',
      phase: item.status?.phase || 'Unknown',
      ready: `${statuses.filter(status => status.ready).length}/${containers.length}`,
      restarts: statuses.reduce((total, status) => total + (status.restartCount || 0), 0),
      containers,
    };
  });
  // K3s keeps a Node object after a provider container disappears. Only Ready
  // workers are live compute; retain a not-ready control plane for diagnostics,
  // but keep dead worker rows and their orphaned pods out of the live view.
  const staleNodeNames = allNodes
    .filter(node => node.role === 'Worker' && !node.ready)
    .map(node => node.name);
  const nodes = allNodes.filter(node => node.role !== 'Worker' || node.ready);
  const liveNodeNames = new Set(nodes.map(node => node.name));
  const livePods = pods.filter(pod => pod.node === 'Unassigned' || liveNodeNames.has(pod.node));
  const counts = new Map();
  for (const pod of livePods) counts.set(pod.node, (counts.get(pod.node) || 0) + 1);
  for (const node of nodes) node.podCount = counts.get(node.name) || 0;
  return { ok: true, status: 'ACTIVE', nodes, pods: livePods, staleNodeNames, fetchedAt: new Date().toISOString() };
}

async function getPodProcesses({ namespace, pod, container } = {}) {
  if (![namespace, pod, container].every(value => typeof value === 'string' && value.length > 0 && value.length < 256)) {
    throw new Error('Choose a valid pod and container first.');
  }
  const inventory = await getInventory();
  const selectedPod = inventory.pods.find(item => item.namespace === namespace && item.name === pod);
  if (!selectedPod) throw new Error('That pod is no longer in the cluster. Refresh the list and select it again.');
  if (!selectedPod.containers.some(item => item.name === container)) throw new Error('That container is not part of the selected pod.');
  const target = `${namespace}/${pod}/${container}`;
  try {
    const output = await kubectl(['exec', '-n', namespace, pod, '-c', container, '--', 'ps', '-eo', 'pid,ppid,comm,args']);
    return { ok: true, target, output: output.trim() || '(No process output)' };
  } catch (error) {
    try {
      const fallback = await kubectl(['exec', '-n', namespace, pod, '-c', container, '--', 'ps']);
      return { ok: true, target, output: fallback.trim() || '(No process output)', note: 'Detailed ps is unavailable in this image; showing its basic process list.' };
    } catch (_) {
      try {
        const debugName = `c3-proc-${crypto.randomBytes(4).toString('hex')}`;
        const output = await kubectl([
          'debug', '-i', '-n', namespace, pod,
          '--image=busybox:1.36.1', '--target', container, '-c', debugName, '--', 'ps', '-ef',
        ], 90000);
        return {
          ok: true,
          target,
          output: output.trim() || '(No process output)',
          note: 'The application image has no ps binary. Process data came from a temporary BusyBox debug container targeting this container; that helper is separate from the application filesystem.',
        };
      } catch (debugError) {
        throw new Error(`This container image has no usable ps command, and Kubernetes could not start a temporary debug container: ${debugError.message || error.message}`);
      }
    }
  }
}

module.exports = { getInventory, getPodProcesses };

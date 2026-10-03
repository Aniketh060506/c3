'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
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
  const [nodesText, podsText] = await Promise.all([
    kubectl(['get', 'nodes', '-o', 'json']),
    kubectl(['get', 'pods', '-A', '-o', 'json']),
  ]);
  const nodeDoc = JSON.parse(nodesText);
  const podDoc = JSON.parse(podsText);
  const nodes = (nodeDoc.items || []).map(item => {
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
  const counts = new Map();
  for (const pod of pods) counts.set(pod.node, (counts.get(pod.node) || 0) + 1);
  for (const node of nodes) node.podCount = counts.get(node.name) || 0;
  return { ok: true, nodes, pods, fetchedAt: new Date().toISOString() };
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
    const fallback = await kubectl(['exec', '-n', namespace, pod, '-c', container, '--', 'ps']);
    return { ok: true, target, output: fallback.trim() || '(No process output)', note: 'Detailed ps is unavailable in this image; showing its basic process list.' };
  }
}

module.exports = { getInventory, getPodProcesses };

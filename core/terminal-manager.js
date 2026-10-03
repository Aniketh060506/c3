'use strict';

/**
 * Real interactive terminal sessions for the C3 cluster, Kubernetes pods,
 * Kubernetes nodes, and the local Windows shell. ConPTY is provided by
 * node-pty, so xterm receives a genuine TTY (resize, signals, job control).
 */

const pty = require('@lydell/node-pty');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const clusterExplorer = require('./cluster-explorer');
const execFileAsync = promisify(execFile);

let _proc = null;
let _dataCallback = null;
let _stopping = false;

function setCallback(cb) { _dataCallback = cb; }
function emit(text) { try { _dataCallback?.(text); } catch (_) {} }

async function initTerminal(targetSpec = null, dimensions = {}) {
  kill();
  _stopping = false;
  const cols = clampDimension(dimensions.cols, 100);
  const rows = clampDimension(dimensions.rows, 30);
  let kind = 'local';
  let target = 'PowerShell';
  let command = 'powershell.exe';
  let args = ['-NoLogo', '-NoProfile'];
  let env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };

  const dockerRunning = await execFileAsync('docker', ['inspect', '--format={{.State.Running}}', 'c3-k3s-master'], {
    windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024,
  }).then(({ stdout }) => stdout.trim() === 'true').catch(() => false);

  if (targetSpec?.kind === 'pod') {
    if (!dockerRunning) throw new Error('K3s is not running. Start the cluster, then reopen this pod shell.');
    const inventory = await clusterExplorer.getInventory();
    const pod = inventory.pods.find(item => item.namespace === targetSpec.namespace && item.name === targetSpec.pod);
    if (!pod || pod.phase !== 'Running' || !pod.containers.some(item => item.name === targetSpec.container)) {
      throw new Error('The selected running pod/container is no longer available. Refresh Nodes & Pods and try again.');
    }
    kind = 'pod';
    target = `${targetSpec.namespace}/${targetSpec.pod}:${targetSpec.container}`;
    let podShell = null;
    for (const candidate of ['/bin/bash', '/bin/sh', '/bin/ash', 'bash', 'sh', 'ash']) {
      try {
        await execFileAsync('docker', [
          'exec', 'c3-k3s-master', 'kubectl', 'exec', '-n', targetSpec.namespace,
          targetSpec.pod, '-c', targetSpec.container, '--', candidate, '-c', 'exit',
        ], { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 });
        podShell = candidate;
        break;
      } catch (_) {}
    }
    if (podShell) {
      args = ['exec', '-it', 'c3-k3s-master', 'kubectl', 'exec', '-it', '-n', targetSpec.namespace,
        targetSpec.pod, '-c', targetSpec.container, '--', podShell, '-i'];
      target += ' · container shell';
    } else {
      // Distroless images intentionally have no shell. Add a standard Bash
      // troubleshooting helper only for this session; never mutate the app image.
      const debugContainer = `c3-shell-${crypto.randomBytes(4).toString('hex')}`;
      args = ['exec', '-it', 'c3-k3s-master', 'kubectl', 'debug', '-it', '-n', targetSpec.namespace,
        targetSpec.pod, '--image=ubuntu:24.04', '--target', targetSpec.container,
        '-c', debugContainer, '--', 'bash', '-il'];
      kind = 'pod-debug';
      target += ' · temporary Ubuntu/Bash debug shell';
    }
    command = 'docker';
  } else if (targetSpec?.kind === 'node') {
    if (!dockerRunning) throw new Error('K3s is not running. Start the cluster, then reopen this node shell.');
    const inventory = await clusterExplorer.getInventory();
    if (!inventory.nodes.some(node => node.name === targetSpec.node && node.ready)) {
      throw new Error('That Kubernetes node is not Ready or no longer exists. Refresh Nodes & Pods and try again.');
    }
    kind = 'node-debug';
    target = `node/${targetSpec.node} · privileged Ubuntu debug shell`;
    command = 'docker';
    args = ['exec', '-it', 'c3-k3s-master', 'kubectl', 'debug', `node/${targetSpec.node}`,
      '-it', '--image=ubuntu:24.04', '--profile=sysadmin', '--', 'bash', '-il'];
  } else if (dockerRunning) {
    kind = 'cluster';
    target = 'c3-k3s-master · cluster shell';
    command = 'docker';
    args = ['exec', '-it', 'c3-k3s-master', 'sh', '-i'];
  }

  return new Promise((resolve, reject) => {
    let resolved = false;
    try {
      const proc = pty.spawn(command, args, {
        name: 'xterm-256color', cols, rows, cwd: process.cwd(), env,
        useConpty: process.platform === 'win32', useConptyDll: true,
      });
      _proc = proc;
      proc.onData(data => emit(data));
      proc.onExit(({ exitCode, signal }) => {
        const isCurrentSession = _proc === proc;
        if (isCurrentSession) _proc = null;
        if (!_stopping && isCurrentSession) emit(`\r\n\x1b[38;5;244m[Shell exited with code ${exitCode}${signal ? `, signal ${signal}` : ''}]\x1b[0m\r\n`);
      });
      proc.on('error', error => {
        const isCurrentSession = _proc === proc;
        if (isCurrentSession) _proc = null;
        if (!isCurrentSession) return;
        if (!resolved) { resolved = true; reject(error); }
        else emit(`\r\n\x1b[31m[Terminal error: ${error.message}]\x1b[0m\r\n`);
      });
      const banner = kind === 'pod-debug'
        ? '\r\n\x1b[38;5;214mThis pod image has no shell. Bash runs in a temporary Ubuntu debug container, not in the app filesystem. The helper targets the app process namespace; use /proc/<PID>/root where the runtime exposes it. Delete/recreate the pod to remove its ephemeral-container record.\x1b[0m\r\n\r\n'
        : kind === 'node-debug'
          ? '\r\n\x1b[38;5;214mThis is an on-demand privileged node debug container. Inspect the node filesystem at /host (for example: ls /host). It is separate from your app containers.\x1b[0m\r\n\r\n'
          : kind === 'pod'
            ? '\r\n\x1b[38;5;244mInteractive shell inside the selected application container.\x1b[0m\r\n\r\n'
            : kind === 'cluster'
              ? '\r\n\x1b[38;5;244mInteractive K3s control-plane shell. Use kubectl to inspect cluster nodes and pods.\x1b[0m\r\n\r\n'
              : '\r\n\x1b[38;5;244mLocal Windows PowerShell. Docker/K3s is unavailable.\x1b[0m\r\n\r\n';
      // Data is emitted first by the PTY; this explanatory note is appended
      // after the spawned process has had a tick to display its prompt.
      setTimeout(() => { if (_proc === proc) emit(banner); }, 100);
      resolved = true;
      resolve({ ok: true, target, kind });
    } catch (error) {
      reject(error);
    }
  });
}

function clampDimension(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 2 && numeric <= 500 ? numeric : fallback;
}

function write(data) {
  if (typeof data === 'string' && data.length && _proc) _proc.write(data);
}

function resize(cols, rows) {
  if (!_proc) return;
  try { _proc.resize(clampDimension(cols, 100), clampDimension(rows, 30)); } catch (_) {}
}

function kill() {
  _stopping = true;
  if (_proc) {
    const proc = _proc;
    _proc = null;
    try { proc.kill(); } catch (_) {}
  }
}

module.exports = { initTerminal, write, resize, kill, setCallback };

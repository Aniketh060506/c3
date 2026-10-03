'use strict';

/**
 * Line-oriented cluster shell bridged to xterm.js.
 * Input is buffered locally so xterm Enter/Backspace work even though the
 * child shell is connected through pipes rather than a native PTY.
 */

const { spawn, execFile } = require('child_process');
const clusterExplorer = require('./cluster-explorer');

let _proc = null;
let _dataCallback = null;
let _lineBuffer = '';
let _pendingLines = [];
let _stopping = false;

function setCallback(cb) {
  _dataCallback = cb;
}

function emit(text) {
  try { _dataCallback?.(text); } catch (_) {}
}

async function initTerminal(targetSpec = null) {
  kill();
  _lineBuffer = '';
  _pendingLines = [];
  _stopping = false;

  let podTarget = null;
  if (targetSpec?.kind === 'pod') {
    const inventory = await clusterExplorer.getInventory();
    podTarget = inventory.pods.find(item => item.namespace === targetSpec.namespace && item.name === targetSpec.pod);
    if (!podTarget || !podTarget.containers.some(item => item.name === targetSpec.container)) {
      throw new Error('The selected pod/container is no longer available. Refresh Nodes & Pods and try again.');
    }
  }

  return new Promise((resolve, reject) => {
    execFile('docker', ['inspect', '--format={{.State.Running}}', 'c3-k3s-master'], (err, stdout) => {
      if (_stopping) return resolve({ ok: false, target: 'stopped', kind: 'cluster' });
      const inCluster = !err && stdout.trim() === 'true';
      const target = podTarget ? `${targetSpec.namespace}/${targetSpec.pod}:${targetSpec.container}` : inCluster ? 'c3-k3s-master' : 'PowerShell';
      const command = inCluster ? 'docker' : 'powershell.exe';
      const args = podTarget
        ? ['exec', '-i', 'c3-k3s-master', 'kubectl', 'exec', '-i', '-n', targetSpec.namespace, targetSpec.pod, '-c', targetSpec.container, '--', 'sh', '-i']
        : inCluster
          ? ['exec', '-i', 'c3-k3s-master', 'sh', '-i']
          : ['-NoLogo', '-NoProfile'];
      const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      _proc = proc;

      proc.stdout.on('data', data => emit(data.toString()));
      proc.stderr.on('data', data => emit(data.toString()));
      proc.once('error', error => {
        if (_proc === proc) _proc = null;
        emit(`\r\n[Terminal could not start: ${error.message}]\r\n`);
        reject(error);
      });
      proc.once('spawn', () => {
        if (_proc !== proc) return resolve({ ok: false, target, kind: podTarget ? 'pod' : 'cluster' });
        emit(`\x1b[38;5;141m\r\n=== C3 ${podTarget ? 'Pod Shell' : 'Cluster Shell'} · ${target} ===\x1b[0m\r\n`);
        emit(podTarget
          ? '\x1b[38;5;244mCommands run inside the selected container. This line shell has no TTY/job control; interactive editors are unavailable.\x1b[0m\r\n\r\n'
          : inCluster
            ? '\x1b[38;5;244mCluster shell · pipe based (no TTY/job control). Use Nodes & Pods to inspect a pod or open its shell.\x1b[0m\r\n\r\n'
          : '\x1b[38;5;244mDocker/K3s is unavailable; this is the local PowerShell shell.\x1b[0m\r\n\r\n');
        for (const line of _pendingLines.splice(0)) proc.stdin.write(`${line}\n`);
        resolve({ ok: true, target, kind: podTarget ? 'pod' : 'cluster' });
      });
      proc.on('close', code => {
        if (_proc === proc) _proc = null;
        if (!_stopping) emit(`\r\n[Shell exited with code ${code}]\r\n`);
      });
    });
  });
}

function submitLine() {
  const line = _lineBuffer;
  _lineBuffer = '';
  emit('\r\n');
  if (_proc?.stdin && !_proc.killed) _proc.stdin.write(`${line}\n`);
  else _pendingLines.push(line);
}

function write(data) {
  if (typeof data !== 'string' || !data.length) return;
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index];
    if (character === '\r' || character === '\n') {
      // xterm sends CR for Enter; normalize it to LF for the piped shell.
      if (character === '\n' && data[index - 1] === '\r') continue;
      submitLine();
    } else if (character === '\x7f' || character === '\b') {
      if (_lineBuffer.length) {
        _lineBuffer = _lineBuffer.slice(0, -1);
        emit('\b \b');
      }
    } else if (character === '\x03') {
      // Ctrl+C clears the current unsubmitted line. Restart the shell to stop
      // a running command; child processes do not receive terminal signals.
      _lineBuffer = '';
      emit('^C\r\n');
    } else if (character >= ' ') {
      _lineBuffer += character;
      emit(character);
    }
  }
}

function kill() {
  _stopping = true;
  _pendingLines = [];
  _lineBuffer = '';
  if (_proc) {
    const proc = _proc;
    _proc = null;
    try { proc.kill(); } catch (_) {}
  }
}

module.exports = { initTerminal, write, kill, setCallback };

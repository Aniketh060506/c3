'use strict';

/**
 * core/setup-checker.js
 * Real system prerequisites & 1-click dependency installer engine.
 * Inspects & manages Docker Desktop, Tailscale, K3s, and Ray images.
 * ZERO MOCK DATA.
 */

const { exec, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { shell, app } = require('electron');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const DOCKER_DESKTOP_PATH = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';

const TAILSCALE_PATHS = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Tailscale', 'tailscale.exe'),
];

const K3S_IMAGE = 'rancher/k3s:v1.36.4-k3s1';
const RAY_IMAGE = 'rayproject/ray:2.58.0-py312';

function findTailscalePath() {
  for (const p of TAILSCALE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── 1. Docker Checks & Controls ──
async function checkDocker() {
  try {
    const { stdout } = await execAsync('docker info --format "{{.ServerVersion}}|{{.NCPU}}|{{.MemTotal}}"');
    const [version, cpu, mem] = stdout.trim().split('|');
    return {
      installed: true,
      running: true,
      version: version || 'Active',
      cpus: parseInt(cpu, 10) || 0,
      memoryTotal: mem ? parseInt(mem, 10) : 0,
    };
  } catch (err) {
    const installed = fs.existsSync(DOCKER_DESKTOP_PATH);
    return {
      installed,
      running: false,
      version: null,
      error: installed ? 'Daemon stopped' : 'Not installed',
    };
  }
}

async function startDocker() {
  if (process.platform === 'win32') {
    if (fs.existsSync(DOCKER_DESKTOP_PATH)) {
      exec(`start "" "${DOCKER_DESKTOP_PATH}"`);
      return { ok: true, message: 'Launching Docker Desktop...' };
    }
  }
  exec('start docker || open -a Docker || docker');
  return { ok: true, message: 'Launching Docker...' };
}

// ── 2. Tailscale Checks & Controls ──
async function checkTailscale() {
  const tsPath = findTailscalePath();
  if (!tsPath) {
    return { installed: false, version: null, ip: null, running: false };
  }

  try {
    const { stdout } = await execFileAsync(tsPath, ['version'], { timeout: 5000 });
    const version = stdout.trim().split('\n')[0].replace('tailscale', '').trim();
    const { stdout: statusOutput } = await execFileAsync(tsPath, ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const status = JSON.parse(statusOutput);
    const self = status.Self || {};
    const ip = (self.TailscaleIPs || []).find(address => address.startsWith('100.')) || null;
    const peers = Object.values(status.Peer || {});
    const onlinePeers = peers.filter(peer => peer.Online === true);
    const activePeers = peers.filter(peer => peer.Active === true);
    const running = status.BackendState === 'Running' && self.Online === true && Boolean(ip);

    return {
      installed: true,
      version: version || 'Installed',
      ip,
      running,
      backendState: status.BackendState || 'Unknown',
      onlinePeerCount: onlinePeers.length,
      activePeerCount: activePeers.length,
    };
  } catch (_) {
    return { installed: true, version: 'Installed', ip: null, running: false };
  }
}

async function connectTailscale(authKey = '') {
  const tsPath = findTailscalePath();
  if (!tsPath) throw new Error('Tailscale is not installed.');

  try {
    const args = ['up', '--accept-routes'];
    if (authKey) args.push(`--authkey=${authKey}`);
    await execFileAsync(tsPath, args, { timeout: 60000 });
    const status = await checkTailscale();
    if (!status.running) return { ok: false, error: `Tailscale up returned, but backend state is ${status.backendState}.` };
    return { ok: true, ...status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function installTailscale(onProgress) {
  if (process.platform !== 'win32') {
    shell.openExternal('https://tailscale.com/download');
    return { ok: true };
  }

  const url = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe';
  const dest = path.join(app.getPath('temp'), 'tailscale-setup.exe');

  onProgress && onProgress('Downloading official Tailscale installer...');
  await execAsync(`curl.exe -L "${url}" -o "${dest}"`);

  onProgress && onProgress('Launching Tailscale setup...');
  await shell.openPath(dest);
  return { ok: true, message: 'Installer launched! Complete installation in setup window.' };
}

// ── 3. Image Pre-pull Checks & Controls ──
async function checkImages() {
  let k3sCached = false;
  let rayCached = false;

  try {
    const { stdout } = await execAsync('docker images --format "{{.Repository}}:{{.Tag}}"');
    const images = stdout.trim().split('\n');
    k3sCached = images.includes(K3S_IMAGE);
    rayCached = images.includes(RAY_IMAGE);
  } catch (_) {}

  return { k3sCached, rayCached };
}

async function pullComputeImage(imageName, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['pull', imageName]);
    proc.stdout.on('data', d => onProgress && onProgress(d.toString().trim()));
    proc.stderr.on('data', d => onProgress && onProgress(d.toString().trim()));
    proc.on('close', code => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`Docker pull exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

// ── Combined Diagnostics ──
async function runAllChecks() {
  const [docker, tailscale, images] = await Promise.all([
    checkDocker(),
    checkTailscale(),
    checkImages(),
  ]);

  return {
    docker,
    tailscale,
    images,
    timestamp: Date.now(),
  };
}

module.exports = {
  checkDocker,
  startDocker,
  checkTailscale,
  connectTailscale,
  installTailscale,
  checkImages,
  pullComputeImage,
  runAllChecks,
  K3S_IMAGE,
  RAY_IMAGE,
};

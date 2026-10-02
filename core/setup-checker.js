'use strict';
/**
 * core/setup-checker.js
 * Checks system prerequisites for C3 (Docker, Tailscale, K3s image).
 * Used by the first-run setup wizard and the Provider tab status banner.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const execAsync = promisify(exec);
const k3sCluster = require('./k3s-cluster');

/**
 * Checks if Docker Desktop is installed and the daemon is running.
 * @returns {Promise<{installed: boolean, running: boolean, version: string|null}>}
 */
async function checkDocker() {
  try {
    const { stdout } = await execAsync('docker info --format "{{.ServerVersion}}"');
    return { installed: true, running: true, version: stdout.trim() || null };
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    // Daemon not running but binary exists
    if (msg.includes('cannot connect') || msg.includes('error during connect') || msg.includes('pipe')) {
      return { installed: true, running: false, version: null };
    }
    // Binary not found
    return { installed: false, running: false, version: null };
  }
}

/**
 * Checks if Tailscale is installed.
 * @returns {Promise<{installed: boolean, version: string|null}>}
 */
async function checkTailscale() {
  const paths = [
    'tailscale',
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  ];
  for (const p of paths) {
    try {
      if (p !== 'tailscale' && !fs.existsSync(p)) continue;
      const { stdout } = await execAsync(`"${p}" version`);
      const v = stdout.trim().split('\n')[0].replace('tailscale', '').trim();
      let ip = null;
      try {
        const { stdout: ipOut } = await execAsync(`"${p}" ip -4`);
        ip = ipOut.trim().split('\n')[0].trim() || null;
      } catch {}
      return { installed: true, version: v || '1.102.4', ip };
    } catch {}
  }
  return { installed: false, version: null, ip: null };
}

/**
 * Checks if the K3s Docker image is already pulled locally.
 * @returns {Promise<{pulled: boolean}>}
 */
async function checkK3sImage() {
  try {
    const { stdout } = await execAsync('docker images c3-k3s:latest --format "{{.ID}}"');
    if (stdout.trim().length > 0) return { pulled: true };
    const { stdout: upstream } = await execAsync('docker images rancher/k3s:v1.30.0-k3s1 --format "{{.ID}}"');
    return { pulled: upstream.trim().length > 0 };
  } catch {
    return { pulled: false };
  }
}

/**
 * Pulls the K3s Docker image.
 * @param {function} onProgress - Callback called with progress string messages.
 * @returns {Promise<void>}
 */
async function pullK3sImage(onProgress) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('docker', ['pull', 'rancher/k3s:v1.30.0-k3s1']);
    proc.stdout.on('data', d => onProgress && onProgress(d.toString().trim()));
    proc.stderr.on('data', d => onProgress && onProgress(d.toString().trim()));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('docker pull exited with code ' + code));
    });
    proc.on('error', reject);
  });
}

/**
 * Downloads Tailscale MSI for Windows and installs it silently.
 * Requires elevation — will prompt UAC on Windows.
 * @param {function} onProgress
 * @returns {Promise<void>}
 */
async function installTailscale(onProgress) {
  if (process.platform !== 'win32') {
    throw new Error('Auto-install only supported on Windows. Install manually from https://tailscale.com/download');
  }
  const url = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe';
  const dest = path.join(app.getPath('temp'), 'tailscale-setup.exe');

  onProgress && onProgress('Downloading official Tailscale installer (following redirects)...');
  await execAsync(`curl.exe -L "${url}" -o "${dest}"`);

  onProgress && onProgress('Opening Tailscale installer...');
  const { shell } = require('electron');
  await shell.openPath(dest);
  onProgress && onProgress('Tailscale installer opened! Please complete the installation in the setup window.');
}

/**
 * Runs all prerequisite checks and returns a combined status object.
 * @returns {Promise<{docker: object, tailscale: object, k3sImage: object}>}
 */
async function runAllChecks() {
  const [docker, tailscale, k3sImage, tailscaleImage] = await Promise.all([
    checkDocker(),
    checkTailscale(),
    checkK3sImage().catch(() => ({ pulled: false })),
    k3sCluster.checkTailscaleImage().catch(() => ({ pulled: false })),
  ]);
  return { docker, tailscale, k3sImage, tailscaleImage };
}

module.exports = {
  checkDocker,
  checkTailscale,
  checkK3sImage,
  pullK3sImage,
  installTailscale,
  runAllChecks,
  // Section E11: Tailscale image
  checkTailscaleImage: k3sCluster.checkTailscaleImage,
  pullTailscaleImage: k3sCluster.pullTailscaleImage,
};

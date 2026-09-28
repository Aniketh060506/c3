'use strict';

/**
 * core/tailscale.js
 * Tailscale automation helpers for C3.
 * Manages Tailscale mesh network operations: install check, mesh IP retrieval,
 * join/leave mesh, and status query. Uses child_process for CLI interaction.
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

// ── Common install paths ───────────────────────────────────────────────────
const WINDOWS_TAILSCALE_PATHS = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Tailscale', 'tailscale.exe'),
  path.join(process.env.APPDATA || '', 'Tailscale', 'tailscale.exe'),
];

const UNIX_TAILSCALE_PATHS = [
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

// ── Binary discovery ───────────────────────────────────────────────────────
/**
 * Finds the Tailscale binary path by searching PATH and common install locations.
 * @returns {Promise<string|null>} Resolved binary path or null if not found.
 */
async function findTailscaleBinary() {
  // Try `which` / `where` first (PATH-based discovery)
  try {
    const cmd = process.platform === 'win32' ? 'where tailscale' : 'which tailscale';
    const { stdout } = await execAsync(cmd);
    const resolved = stdout.trim().split('\n')[0].trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {
    // Not in PATH, fall through
  }

  // Check known install paths
  const candidates =
    process.platform === 'win32' ? WINDOWS_TAILSCALE_PATHS : UNIX_TAILSCALE_PATHS;

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

// ── Module-level binary cache ──────────────────────────────────────────────
let _binaryPath = null;

async function getBinary() {
  if (_binaryPath) return _binaryPath;
  _binaryPath = await findTailscaleBinary();
  return _binaryPath;
}

/**
 * Runs a tailscale CLI command and returns stdout.
 * @param {string} args - Arguments after `tailscale`.
 * @returns {Promise<string>} stdout
 */
async function runTailscale(args) {
  const binary = await getBinary();
  if (!binary) {
    throw new Error(
      'Tailscale is not installed. Please install Tailscale from https://tailscale.com/download'
    );
  }
  const quotedBinary = `"${binary}"`;
  const { stdout } = await execAsync(`${quotedBinary} ${args}`);
  return stdout.trim();
}

// ── Public API ─────────────────────────────────────────────────────────────
/**
 * Checks whether Tailscale is installed on this machine.
 * @returns {Promise<boolean>}
 */
async function isTailscaleInstalled() {
  const binary = await getBinary();
  return binary !== null;
}

/**
 * Returns this machine's Tailscale mesh (100.x.x.x) IP address.
 * @returns {Promise<string>} The Tailscale IP.
 */
async function getMeshIp() {
  const output = await runTailscale('ip -4');
  const match = output.match(/(\d+\.\d+\.\d+\.\d+)/);
  if (!match) throw new Error('Could not parse Tailscale IP from output: ' + output);
  return match[1];
}

/**
 * Joins the Tailscale mesh network using an auth key.
 * @param {string} authKey - Tailscale auth key (pre-auth key from admin console).
 * @param {string} hostname - Desired hostname for this node in the mesh.
 * @returns {Promise<void>}
 */
async function joinMesh(authKey, hostname) {
  const sanitizedHostname = hostname.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 63);
  await runTailscale(
    `up --authkey="${authKey}" --hostname="${sanitizedHostname}" --accept-routes`
  );
}

/**
 * Leaves the Tailscale mesh network (logs this node out).
 * @returns {Promise<void>}
 */
async function leaveMesh() {
  await runTailscale('logout');
}

/**
 * Automatically discovers the best IP address for cluster communication.
 * 1. Checks for an active Tailscale 100.x.x.x mesh IP.
 * 2. If not connected, automatically grabs the local Wi-Fi / Ethernet LAN IP (e.g. 192.168.x.x or 10.x.x.x).
 * 3. Falls back to 127.0.0.1 for local execution.
 * Zero user configuration required!
 */
async function getConnectableIp() {
  try {
    const meshIp = await getMeshIp();
    if (meshIp) return { ip: meshIp, type: 'tailscale' };
  } catch {}

  // Auto-detect local Wi-Fi or Ethernet IPv4 address
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        // Prioritize Wi-Fi and physical Ethernet
        const isPriority = /wi-fi|wlan|ethernet/i.test(name) && !/vEthernet|vmware|virtualbox/i.test(name);
        if (isPriority) {
          return { ip: net.address, type: 'lan', interface: name };
        }
        candidates.push({ ip: net.address, type: 'lan', interface: name });
      }
    }
  }

  if (candidates.length > 0) return candidates[0];
  return { ip: '127.0.0.1', type: 'local', interface: 'loopback' };
}

async function getStatus() {
  const output = await runTailscale('status --json');
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Failed to parse Tailscale status JSON: ' + output);
  }
}

module.exports = {
  isTailscaleInstalled,
  getMeshIp,
  getConnectableIp,
  joinMesh,
  leaveMesh,
  getStatus,
};

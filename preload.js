'use strict';

/**
 * preload.js — Electron contextBridge preload script for C3
 *
 * Exposes a secure `window.c3` API to the renderer process via contextBridge.
 * All IPC is handled here — the renderer never has direct access to Node APIs.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('c3', {
  // ── Auth ──────────────────────────────────────────────────────────────
  /**
   * Sign in with email and password.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{userId: string, email: string}>}
   */
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  openHostedLogin: () => ipcRenderer.invoke('auth:open-hosted-login'),
  openAwsLogin: () => ipcRenderer.invoke('auth:open-aws-login'),

  /**
   * Register a new account.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{ok: boolean}>}
   */
  signUp: (email, password) => ipcRenderer.invoke('auth:signup', { email, password }),

  /**
   * Confirm email with the 6-digit code.
   * @param {string} email
   * @param {string} code
   * @returns {Promise<{ok: boolean}>}
   */
  confirmSignUp: (email, code) => ipcRenderer.invoke('auth:confirm', { email, code }),

  /**
   * Sign the current user out.
   * @returns {Promise<{ok: boolean}>}
   */
  signOut: () => ipcRenderer.invoke('auth:signout'),

  /**
   * Get the current authenticated user's profile.
   * @returns {Promise<{userId: string, email: string, displayName: string, credits: number}|null>}
   */
  getUser: () => ipcRenderer.invoke('auth:getuser'),

  /**
   * Set local machine display name.
   * @param {string} displayName
   * @returns {Promise<{ok: boolean, user: object}>}
   */
  setName: (displayName) => ipcRenderer.invoke('auth:set-name', { displayName }),

  /**
   * Connect to a remote peer directly by IP (e.g. Tailscale or LAN IP).
   * @param {string} ip
   * @returns {Promise<{ok: boolean, peer: object|null}>}
   */
  addPeerIp: (ip) => ipcRenderer.invoke('cluster:add-peer-ip', { ip }),

  // ── Hardware ──────────────────────────────────────────────────────────
  /**
   * Get static hardware specs (CPU, RAM, GPU, OS).
   * @returns {Promise<{cpuModel: string, cpuCores: number, ramGb: number, gpu: string, os: string}>}
   */
  getHardwareSpecs: () => ipcRenderer.invoke('hw:specs'),

  /**
   * Get live CPU/RAM utilisation stats.
   * @returns {Promise<{cpuPercent: number, memPercent: number, memUsedGb: number, memTotalGb: number}>}
   */
  getLiveStats: () => ipcRenderer.invoke('hw:livestats'),

  // ── Provider ──────────────────────────────────────────────────────────
  /**
   * Register this machine as a compute provider.
   * @param {{displayName: string, cpuModel: string, cpuCores: number, ramGb: number, gpu: string, os: string}} profile
   * @returns {Promise<{ok: boolean}>}
   */
  registerProvider: (profile) => ipcRenderer.invoke('provider:register', profile),

  /**
   * Toggle provider sharing on or off.
   * @param {boolean} active
   * @returns {Promise<{ok: boolean, active: boolean}>}
   */
  toggleProvider: (active) => ipcRenderer.invoke('provider:toggle', { active }),

  // ── Consumer / Marketplace ────────────────────────────────────────────
  /**
   * List all currently active (ONLINE) providers from DynamoDB.
   * @returns {Promise<object[]>}
   */
  listProviders: () => ipcRenderer.invoke('providers:list'),
  getProviders: () => ipcRenderer.invoke('providers:list'),

  /**
   * Open a native directory picker. Returns the selected folder path.
   * @returns {Promise<string|null>}
   */
  selectWorkspaceFolder: () => ipcRenderer.invoke('cluster:pick-folder'),

  // ── Cluster ───────────────────────────────────────────────────────────
  /**
   * Create a new cluster session targeting the given provider IDs.
   * @param {{providerIds: string[], workspacePath: string}} opts
   * @returns {Promise<{sessionId: string}>}
   */
  createClusterSession: (opts) => ipcRenderer.invoke('cluster:create', opts),

  /**
   * Accept an incoming cluster request (provider-side).
   * @param {string} sessionId
   * @returns {Promise<{ok: boolean}>}
   */
  acceptClusterRequest: (sessionId) => ipcRenderer.invoke('cluster:accept', { sessionId }),

  /**
   * Decline an incoming cluster request (provider-side).
   * @param {string} sessionId
   * @returns {Promise<{ok: boolean}>}
   */
  declineClusterRequest: (sessionId) => ipcRenderer.invoke('cluster:decline', { sessionId }),

  /**
   * Get aggregated telemetry from all cluster nodes.
   * @returns {Promise<{totalCores: number, totalRamGb: number, totalGpus: number, nodeCount: number}>}
   */
  getClusterTelemetry: () => ipcRenderer.invoke('cluster:telemetry'),

  /**
   * Dispatch a workload command to one or both cluster nodes.
   * @param {{target: 'node-1'|'node-2'|'both', command: string}} opts
   * @returns {Promise<{ok: boolean, logs: string[]}>}
   */
  dispatchWorkload: (opts) => ipcRenderer.invoke('cluster:dispatch', opts),

  /**
   * Stop the cluster and clean up containers.
   * @returns {Promise<{ok: boolean}>}
   */
  stopCluster: () => ipcRenderer.invoke('cluster:stop'),
  redeployPods: () => ipcRenderer.invoke('cluster:redeploy-pods'),

  // ── Credits ───────────────────────────────────────────────────────────
  /**
   * Get the current user's credit balance.
   * @returns {Promise<{credits: number}>}
   */
  getCredits: () => ipcRenderer.invoke('credits:get'),

  // ── Push event listeners ──────────────────────────────────────────────
  /**
   * Subscribe to cluster status change events.
   * @param {(payload: object) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onClusterStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('cluster:status', handler);
    return () => ipcRenderer.removeListener('cluster:status', handler);
  },

  /**
   * Subscribe to cluster log line events.
   * @param {(line: string) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onClusterLog: (callback) => {
    const handler = (_event, line) => callback(line);
    ipcRenderer.on('cluster:log', handler);
    return () => ipcRenderer.removeListener('cluster:log', handler);
  },

  /**
   * Subscribe to incoming cluster request notifications (provider-side).
   * @param {(request: object) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onClusterRequest: (callback) => {
    const handler = (_event, request) => callback(request);
    ipcRenderer.on('cluster:request', handler);
    return () => ipcRenderer.removeListener('cluster:request', handler);
  },

  // ── Setup checker & System helpers ──────────────────────────────────────
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  pullK3sImage: () => ipcRenderer.invoke('setup:pull-k3s'),
  installTailscale: () => ipcRenderer.invoke('setup:install-tailscale'),
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
  launchDocker: () => ipcRenderer.invoke('system:launch-docker'),
  getNetworkDebug: () => ipcRenderer.invoke('cluster:network-debug'),
  onSetupProgress: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('setup:install-progress', handler);
    return () => ipcRenderer.removeListener('setup:install-progress', handler);
  },
  onK3sPullProgress: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('setup:pull-k3s-progress', handler);
    return () => ipcRenderer.removeListener('setup:pull-k3s-progress', handler);
  },

  // ── Mesh Settings ───────────────────────────────────────────────────────
  getTailscaleKey: () => ipcRenderer.invoke('settings:get-tailscale-key'),
  saveTailscaleKey: (key) => ipcRenderer.invoke('settings:save-tailscale-key', key),

  // ── Window Controls ─────────────────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChange: (callback) => {
    const handler = (_event, isMax) => callback(isMax);
    ipcRenderer.on('window:maximized-change', handler);
    return () => ipcRenderer.removeListener('window:maximized-change', handler);
  },
});

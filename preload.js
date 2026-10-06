'use strict';

/**
 * preload.js — Electron contextBridge preload script for C3
 * Exposes window.c3 securely to the React renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('c3', {
  // ── Authentication & Identity ──
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  openHostedLogin: () => ipcRenderer.invoke('auth:open-hosted-login'),
  signUp: (email, password) => ipcRenderer.invoke('auth:signup', { email, password }),
  confirmSignUp: (email, code) => ipcRenderer.invoke('auth:confirm', { email, code }),
  signOut: () => ipcRenderer.invoke('auth:signout'),
  getUser: () => ipcRenderer.invoke('auth:getuser'),
  setName: (displayName) => ipcRenderer.invoke('auth:set-name', { displayName }),

  // ── Cloud Registry (DynamoDB) ──
  getProviders: () => ipcRenderer.invoke('providers:list'),
  registerProvider: (profile) => ipcRenderer.invoke('provider:register', profile),
  getNegotiationSession: (sessionId) => ipcRenderer.invoke('negotiation:get-session', sessionId),
  getNegotiationMessages: (sessionId) => ipcRenderer.invoke('negotiation:get-messages', sessionId),
  sendNegotiationMessage: (message) => ipcRenderer.invoke('negotiation:send-message', message),
  acceptNegotiatedOffer: (sessionId, offerPerHour) => ipcRenderer.invoke('negotiation:accept-offer', { sessionId, offerPerHour }),

  // ── Hardware & Telemetry ──
  getHardwareSpecs: (force) => ipcRenderer.invoke('hw:specs', force),
  getLiveStats: () => ipcRenderer.invoke('hw:livestats'),

  // ── Phase 3: Provider Mode (Hardware Sharing) ──
  startProviderSharing: (config) => ipcRenderer.invoke('provider:start-sharing', config),
  stopProviderSharing: () => ipcRenderer.invoke('provider:stop-sharing'),
  acceptProviderSession: (sessionData) => ipcRenderer.invoke('provider:accept-session', sessionData),
  declineProviderSession: (sessionId) => ipcRenderer.invoke('provider:decline-session', sessionId),
  getProviderState: () => ipcRenderer.invoke('provider:get-state'),
  onProviderInvitation: (callback) => {
    const handler = (_event, invitation) => callback(invitation);
    ipcRenderer.on('provider:invitation-received', handler);
    return () => ipcRenderer.removeListener('provider:invitation-received', handler);
  },
  onProviderRequestError: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('provider:request-error', handler);
    return () => ipcRenderer.removeListener('provider:request-error', handler);
  },
  onProviderSessionStarted: (callback) => {
    const handler = (_event, session) => callback(session);
    ipcRenderer.on('provider:session-started', handler);
    return () => ipcRenderer.removeListener('provider:session-started', handler);
  },
  onProviderSessionEnded: (callback) => {
    const handler = (_event, session) => callback(session);
    ipcRenderer.on('provider:session-ended', handler);
    return () => ipcRenderer.removeListener('provider:session-ended', handler);
  },

  // ── Phase 4: Consumer Studio (Distributed Orchestration) ──
  discoverNodes: () => ipcRenderer.invoke('consumer:discover-nodes'),
  pickWorkspaceFolder: () => ipcRenderer.invoke('consumer:pick-folder'),
  startCluster: (params) => ipcRenderer.invoke('consumer:start-cluster', params),
  getClusterStatus: () => ipcRenderer.invoke('consumer:cluster-status'),
  getClusterInventory: () => ipcRenderer.invoke('cluster:explorer-inventory'),
  getPodProcesses: (target) => ipcRenderer.invoke('cluster:pod-processes', target),
  stopCluster: () => ipcRenderer.invoke('consumer:stop-cluster'),
  onClusterStatusUpdate: (callback) => {
    const handler = (_event, update) => callback(update);
    ipcRenderer.on('cluster:status-update', handler);
    return () => ipcRenderer.removeListener('cluster:status-update', handler);
  },

  // ── Phase 5: Interactive Terminal ──
  initTerminal: (target, dimensions) => ipcRenderer.invoke('terminal:init', target, dimensions),
  writeTerminal: (data) => ipcRenderer.invoke('terminal:write', data),
  resizeTerminal: (cols, rows) => ipcRenderer.invoke('terminal:resize', cols, rows),
  killTerminal: () => ipcRenderer.invoke('terminal:kill'),
  onTerminalData: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },

  // ── Phase 5 & 6: Ray AI Distributed Engine ──
  getRayTemplates: () => ipcRenderer.invoke('ray:get-templates'),
  startRayJob: (options) => ipcRenderer.invoke('ray:start-job', options),
  stopRayJob: () => ipcRenderer.invoke('ray:stop-job'),
  getRayJob: () => ipcRenderer.invoke('ray:get-job'),
  getRayStatus: () => ipcRenderer.invoke('ray:get-status'),
  startRayCluster: () => ipcRenderer.invoke('ray:start-cluster'),
  openRayResults: (jobId) => ipcRenderer.invoke('ray:open-results', jobId),
  onRayJobStarted: (callback) => {
    const handler = (_event, job) => callback(job);
    ipcRenderer.on('ray:job-started', handler);
    return () => ipcRenderer.removeListener('ray:job-started', handler);
  },
  onRayJobProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('ray:job-progress', handler);
    return () => ipcRenderer.removeListener('ray:job-progress', handler);
  },
  onRayJobCompleted: (callback) => {
    const handler = (_event, job) => callback(job);
    ipcRenderer.on('ray:job-completed', handler);
    return () => ipcRenderer.removeListener('ray:job-completed', handler);
  },
  onRayJobStopped: (callback) => {
    const handler = (_event, job) => callback(job);
    ipcRenderer.on('ray:job-stopped', handler);
    return () => ipcRenderer.removeListener('ray:job-stopped', handler);
  },

  // ── Phase 7: System Settings & Maintenance ──
  pruneContainers: () => ipcRenderer.invoke('settings:prune-containers'),
  getContainerStatus: () => ipcRenderer.invoke('settings:container-status'),
  claimFaucetCredits: (amount) => ipcRenderer.invoke('settings:claim-faucet', { amount }),
  getTransactions: () => ipcRenderer.invoke('settings:get-transactions'),
  testP2PConnectivity: (host, port) => ipcRenderer.invoke('settings:test-p2p', { host, port }),
  getNetworkDiagnostics: () => ipcRenderer.invoke('settings:network-diag'),

  // ── System Prerequisites & 1-Click Dependency Management ──
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  startDocker: () => ipcRenderer.invoke('setup:start-docker'),
  installTailscale: () => ipcRenderer.invoke('setup:install-tailscale'),
  connectTailscale: (authKey) => ipcRenderer.invoke('setup:connect-tailscale', { authKey }),
  pullImage: (imageName) => ipcRenderer.invoke('setup:pull-image', { imageName }),
  onPullProgress: (callback) => {
    const handler = (_event, msg) => callback(msg);
    ipcRenderer.on('setup:pull-progress', handler);
    return () => ipcRenderer.removeListener('setup:pull-progress', handler);
  },
  openExternal: (url) => ipcRenderer.invoke('system:open-external', url),

  // ── Window Frame Controls ──
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

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('c3', {
  // ── Auth ────────────────────────────────────────────────────────────────────
  login:          (email, pass)       => ipcRenderer.invoke('auth:login',   { email, pass }),
  signUp:         (email, pass)       => ipcRenderer.invoke('auth:signup',  { email, pass }),
  confirmSignUp:  (email, code)       => ipcRenderer.invoke('auth:confirm', { email, code }),
  signOut:        ()                  => ipcRenderer.invoke('auth:signout'),
  getUser:        ()                  => ipcRenderer.invoke('auth:getuser'),

  // ── Hardware ─────────────────────────────────────────────────────────────────
  getHardwareSpecs: ()                => ipcRenderer.invoke('hw:specs'),
  runBenchmark:     ()                => ipcRenderer.invoke('hw:benchmark'),
  getLiveStats:     ()                => ipcRenderer.invoke('hw:livestats'),

  // ── Provider ─────────────────────────────────────────────────────────────────
  isDockerRunning:  ()                => ipcRenderer.invoke('docker:ping'),
  registerProvider: (profile)         => ipcRenderer.invoke('provider:register',  profile),
  toggleStatus:     (active)          => ipcRenderer.invoke('provider:toggle',    active),
  getPendingReqs:   ()                => ipcRenderer.invoke('provider:pending'),
  acceptRequest:    (sessionId, data) => ipcRenderer.invoke('provider:accept',    { sessionId, data }),
  declineRequest:   (sessionId)       => ipcRenderer.invoke('provider:decline',   sessionId),
  endSession:       (sessionId)       => ipcRenderer.invoke('provider:end',       sessionId),

  // ── Marketplace ───────────────────────────────────────────────────────────────
  getProviders:     ()                => ipcRenderer.invoke('market:providers'),
  sendSessionReq:   (payload)         => ipcRenderer.invoke('market:request',     payload),

  // ── Credits ───────────────────────────────────────────────────────────────────
  getCredits:       ()                => ipcRenderer.invoke('credits:get'),

  // ── Chat ──────────────────────────────────────────────────────────────────────
  sendChat:         (toUserId, text)  => ipcRenderer.invoke('chat:send',    { toUserId, text }),
  startChatPoll:    (chatId)          => ipcRenderer.invoke('chat:startpoll', chatId),
  stopChatPoll:     ()                => ipcRenderer.invoke('chat:stoppoll'),

  // ── SSH Terminal ──────────────────────────────────────────────────────────────
  connectSSH:       (sessionId)       => ipcRenderer.invoke('ssh:connect',  sessionId),
  disconnectSSH:    ()                => ipcRenderer.invoke('ssh:disconnect'),
  sendTermInput:    (data)            => ipcRenderer.send('ssh:input',      data),
  resizeTerminal:   (cols, rows)      => ipcRenderer.send('ssh:resize',     { cols, rows }),

  // ── SFTP ──────────────────────────────────────────────────────────────────────
  listFiles:        (remotePath)      => ipcRenderer.invoke('sftp:list',     remotePath),
  uploadFile:       (local, remote)   => ipcRenderer.invoke('sftp:upload',   { local, remote }),
  downloadFile:     (remote, local)   => ipcRenderer.invoke('sftp:download', { remote, local }),

  // ── Push events (backend → renderer) ─────────────────────────────────────────
  onTerminalData:   (cb) => { ipcRenderer.on('ssh:data',          (_, d) => cb(d)); },
  onTerminalClose:  (cb) => { ipcRenderer.on('ssh:close',         (_, d) => cb(d)); },
  onTelemetry:      (cb) => { ipcRenderer.on('ssh:telemetry',     (_, d) => cb(d)); },
  onChatMessages:   (cb) => { ipcRenderer.on('chat:messages',     (_, d) => cb(d)); },
  onSessionReady:   (cb) => { ipcRenderer.on('session:ready',     (_, d) => cb(d)); },
  onNewRequest:     (cb) => { ipcRenderer.on('provider:newreq',   (_, d) => cb(d)); },
  removeListeners:  (ch) => { ipcRenderer.removeAllListeners(ch); },
});

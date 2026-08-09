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
  getProviderProfile: ()              => ipcRenderer.invoke('provider:get-profile'),
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

  // ── WebRTC Signaling (Provider Side) ──────────────────────────────────────────
  onStartProvider:    (cb) => { ipcRenderer.on('webrtc:start-provider', (_, d) => cb(d)); },
  sendProviderOffer:  (data) => ipcRenderer.invoke('webrtc:provider-offer', data),
  onAnswerReceived:   (cb) => { ipcRenderer.on('webrtc:answer-received', (_, d) => cb(d)); },
  onPtyData:          (cb) => { ipcRenderer.on('pty:data', (_, d) => cb(d)); },
  sendPtyInput:       (data) => ipcRenderer.send('pty:input', data),
  sendPtyResize:      (data) => ipcRenderer.send('pty:resize', data),

  // ── WebRTC Signaling (User Side) ──────────────────────────────────────────────
  connectTerminal:    (sessionId) => ipcRenderer.invoke('terminal:connect', sessionId),
  disconnectTerminal: () => ipcRenderer.invoke('terminal:disconnect'),
  onWebRTCOffer:      (cb) => { ipcRenderer.on('webrtc:offer', (_, d) => cb(d)); },
  sendUserAnswer:     (data) => ipcRenderer.invoke('webrtc:user-answer', data),

  // ── WebRTC ICE Config ─────────────────────────────────────────────────────────
  getIceConfig:        ()                       => ipcRenderer.invoke('ice:config'),

  // ── File Transfer ─────────────────────────────────────────────────────────────
  pickFileForUpload:   ()                       => ipcRenderer.invoke('file:pick-upload'),
  saveDownloadedFile:  (data)                   => ipcRenderer.invoke('file:save-download', data),
  containerWriteFile:  (data)                   => ipcRenderer.invoke('container:write-file', data),
  containerReadFile:   (data)                   => ipcRenderer.invoke('container:read-file', data),


  // ── Push events (backend → renderer) ─────────────────────────────────────────
  onChatMessages:   (cb) => { ipcRenderer.on('chat:messages',     (_, d) => cb(d)); },
  onSessionReady:   (cb) => { ipcRenderer.on('session:ready',     (_, d) => cb(d)); },
  onNewRequest:     (cb) => { ipcRenderer.on('provider:newreq',   (_, d) => cb(d)); },
  onDebugLog:       (cb) => { ipcRenderer.on('debug:log',         (_, d) => cb(d)); },
  removeListeners:  (ch) => { ipcRenderer.removeAllListeners(ch); },

});

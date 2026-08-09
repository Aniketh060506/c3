'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Core modules ──────────────────────────────────────────────────────────────
const cognito  = require('./core/cognito');
const dynamo   = require('./core/dynamodb');
const hardware = require('./core/hardware');
const docker   = require('./core/docker');

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindow       = null;
let heartbeatTimer   = null;
let pendingPollTimer = null;
let chatPollTimer    = null;
let sessionPollMap   = new Map(); // sessionId → interval
let activeUserId     = null;
let activePtyStreams = new Map(); // sessionId -> stream

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#09090c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.maximize();

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-ui', 'index.html'));
  }
}

const SESSION_FILE = path.join(app.getPath('userData'), 'c3_session.json');

function saveSession(data) {
  try {
    const existing = loadSession() || {};
    const updated = typeof data === 'string' ? { ...existing, userId: data } : { ...existing, ...data };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(updated), 'utf8');
  } catch (_) {}
}
function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; }
}

app.whenReady().then(() => {
  // Restore session userId so IPC handlers work after restart
  const saved = loadSession();
  if (saved?.userId) activeUserId = saved.userId;
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── Helper: send to renderer ──────────────────────────────────────────────────
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Helper: broadcast a debug log line to the debug panel in the UI ─────────
function debugLog(level, msg, detail = '') {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = { ts, level, msg, detail };
  console.log(`[C3 ${level.toUpperCase()}] ${msg}${detail ? ' | ' + detail : ''}`);
  send('debug:log', line);
}

function getUserId() {
  return cognito.getUserId() || activeUserId || 'anonymous_user';
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('auth:login', async (_, { email, pass }) => {
  const data = await cognito.login(email, pass);
  activeUserId = data.userId;
  try { await dynamo.createUser(data.userId, data.email); } catch (_e) {}
  const user = await dynamo.getUser(data.userId).catch(() => ({ userId: data.userId, email: data.email, credits: 100 }));
  const fullUser = { ...data, ...user };
  saveSession(fullUser);
  return fullUser;
});

ipcMain.handle('auth:signup', async (_, { email, pass }) => {
  return await cognito.signUp(email, pass);
});

ipcMain.handle('auth:confirm', async (_, { email, code }) => {
  return await cognito.confirmSignUp(email, code);
});

ipcMain.handle('auth:signout', async () => {
  await cognito.signOut().catch(() => {});
  activeUserId = null;
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
  return true;
});

ipcMain.handle('auth:getuser', async () => {
  const saved = loadSession();
  const userId = saved?.userId || getUserId();
  if (!userId || userId === 'anonymous_user') return null;
  try {
    const user = await dynamo.getUser(userId);
    const result = { ...saved, ...user, email: user?.email || saved?.email || cognito.getEmail() };
    saveSession(result);
    return result;
  } catch {
    return saved || { userId, email: cognito.getEmail(), credits: 100 };
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HARDWARE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('hw:specs',      async () => hardware.getHardwareSpecs());
ipcMain.handle('hw:benchmark',  async () => hardware.runBenchmark());
ipcMain.handle('hw:livestats',  async () => hardware.getLiveStats());

// ═══════════════════════════════════════════════════════════════════════════════
// DOCKER HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('docker:ping', async () => docker.isDockerRunning());

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('provider:register', async (_, profile) => {
  const userId = getUserId();
  await dynamo.registerProvider(userId, profile);
  return true;
});

ipcMain.handle('provider:get-profile', async () => {
  const userId = getUserId();
  return await dynamo.getProvider(userId);
});

ipcMain.handle('provider:toggle', async (_, active) => {
  const userId = getUserId();
  console.log(`[C3] provider:toggle → ${active} for userId=${userId}`);

  await dynamo.updateProviderStatus(userId, active ? 'ACTIVE' : 'INACTIVE')
    .then(() => console.log('[C3] DynamoDB status updated successfully'))
    .catch(e => console.error('[C3] DynamoDB updateProviderStatus FAILED:', e.message));

  if (active) {
    // Immediately write a fresh heartbeat so lastHeartbeat is current
    await dynamo.heartbeat(userId)
      .then(() => console.log('[C3] Initial heartbeat written'))
      .catch(e => console.error('[C3] Heartbeat FAILED:', e.message));

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => dynamo.heartbeat(userId).catch(e => console.error('[C3] heartbeat err:', e.message)), 60_000);
    }
    if (!pendingPollTimer) {
      pendingPollTimer = setInterval(async () => {
        try {
          const reqs = await dynamo.getPendingRequestsForProvider(userId);
          if (reqs.length > 0) send('provider:newreq', reqs[0]);
        } catch (e) { console.error('[C3] pendingPoll err:', e.message); }
      }, 5_000);
    }
  } else {
    if (heartbeatTimer)   { clearInterval(heartbeatTimer);   heartbeatTimer   = null; }
    if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
  }
  return true;
});

ipcMain.handle('provider:pending', async () => {
  const userId = getUserId();
  return dynamo.getPendingRequestsForProvider(userId).catch(() => []);
});

ipcMain.handle('provider:accept', async (_, { sessionId, data }) => {
  debugLog('info', '▶ Provider Accept started', `sessionId=${sessionId}`);

  // Step 1: Check Docker
  debugLog('step', '⌛ Step 1/3: Checking Docker Desktop...');
  const dockerOk = await docker.isDockerRunning();
  if (!dockerOk) {
    debugLog('error', '❌ Docker not running');
    throw new Error('Docker Desktop is not running.');
  }
  debugLog('ok', '✅ Docker Desktop is running');

  // Step 2: Start container
  debugLog('step', '⌛ Step 2/3: Starting Docker container...');
  try {
    await docker.startSession(
      sessionId,
      data.environment || 'base',
      data.cpuCores || 2,
      data.ramGb || 4,
      data.cudaRequested || false,
    );
    debugLog('ok', '✅ Container started');
  } catch (err) {
    debugLog('error', '❌ Container start failed', err.message);
    throw err;
  }

  // Step 3: Create docker exec shell
  debugLog('step', '⌛ Step 3/3: Creating shell session...');
  try {
    const { stream: ptyStream, exec: ptyExec } = await docker.execShell(sessionId);
    activePtyStreams.set(sessionId, { stream: ptyStream, exec: ptyExec });
    
    // Pipe docker exec stdout → renderer (provider side)
    ptyStream.on('data', (chunk) => {
      send('pty:data', chunk.toString());
    });
    ptyStream.on('end', () => {
      debugLog('info', 'Docker exec shell ended');
      activePtyStreams.delete(sessionId);
    });
    
    debugLog('ok', '✅ Shell session created');
  } catch (err) {
    debugLog('error', '❌ Shell creation failed', err.message);
    throw err;
  }

  // Tell the provider renderer to start WebRTC as initiator
  send('webrtc:start-provider', { sessionId });
  debugLog('step', '⏳ Waiting for WebRTC offer from renderer...');

  // The actual DynamoDB update happens when we receive the offer from the renderer
  return { sessionId };
});

// Provider renderer sends its SDP offer
ipcMain.handle('webrtc:provider-offer', async (_, { sessionId, offer }) => {
  debugLog('info', 'WebRTC offer received from renderer, storing in DynamoDB...');
  await dynamo.storeSignal(sessionId, 'sdpOffer', offer);
  await dynamo.updateSessionStatus(sessionId, 'READY');
  debugLog('ok', '✅ Session READY — offer stored, waiting for user answer...');
  
  // Poll DynamoDB for the user's answer
  const poll = setInterval(async () => {
    try {
      const answer = await dynamo.getSignal(sessionId, 'sdpAnswer');
      if (answer) {
        clearInterval(poll);
        debugLog('ok', '✅ User answer received from DynamoDB!');
        send('webrtc:answer-received', { sessionId, answer });
      }
    } catch (e) {
      debugLog('warn', 'Poll error: ' + e.message);
    }
  }, 1000);
  
  // Store the poll so we can clean it up
  sessionPollMap.set('signal-' + sessionId, poll);
  return true;
});

// User renderer sends its SDP answer
ipcMain.handle('webrtc:user-answer', async (_, { sessionId, answer }) => {
  debugLog('info', 'Storing user WebRTC answer in DynamoDB...');
  await dynamo.storeSignal(sessionId, 'sdpAnswer', answer);
  debugLog('ok', '✅ User answer stored');
  return true;
});

// User requests terminal connection
ipcMain.handle('terminal:connect', async (_, sessionId) => {
  debugLog('info', 'User requesting terminal connection', `sessionId=${sessionId}`);
  
  // Retry up to 10 times (5 seconds) waiting for sdpOffer in DynamoDB
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const session = await dynamo.getSession(sessionId);
      if (session && session.sdpOffer) {
        debugLog('ok', `✅ SDP offer found on attempt ${attempt}`);
        return { offer: session.sdpOffer };
      }
    } catch (e) {
      debugLog('warn', `Attempt ${attempt} fetching session error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  
  throw new Error('Provider offer not found (timed out waiting for offer in DynamoDB)');
});

ipcMain.handle('terminal:disconnect', async () => {
  debugLog('info', 'Terminal disconnect requested');
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════════
// FILE TRANSFER HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

const { dialog } = require('electron');
const { exec: execChild } = require('child_process');

// User side: pick a local file to upload and return its content as base64
ipcMain.handle('file:pick-upload', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select file to upload',
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const name = require('path').basename(filePath);
  const content = fs.readFileSync(filePath);
  return {
    name,
    size: content.length,
    base64: content.toString('base64')
  };
});

// User side: save received file content to local disk
ipcMain.handle('file:save-download', async (_, { name, base64 }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save file',
    defaultPath: name,
  });
  if (result.canceled) return false;
  fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
  return true;
});

// Provider side: write received upload bytes into the running Docker container
ipcMain.handle('container:write-file', async (_, { sessionId, destPath, base64 }) => {
  const Docker = require('dockerode');
  const d = new Docker();
  const c = d.getContainer(`c3-${sessionId}`);

  const exec = await c.exec({
    Cmd: ['bash', '-c', `mkdir -p "$(dirname "${destPath}")" && echo '${base64}' | base64 -d > '${destPath}'`],
    AttachStdout: true,
    AttachStderr: true,
  });
  const s = await exec.start({});
  s.on('data', () => {});
  await new Promise((resolve) => s.on('end', resolve));
  return true;
});

// Provider side: read a file or folder from the running Docker container and return base64
ipcMain.handle('container:read-file', async (_, { sessionId, srcPath }) => {
  const Docker = require('dockerode');
  const d = new Docker();
  const c = d.getContainer(`c3-${sessionId}`);

  // Check if srcPath is a directory or file
  const checkExec = await c.exec({ Cmd: ['bash', '-c', `test -d "${srcPath}" && echo "DIR" || echo "FILE"`] });
  const checkStream = await checkExec.start({});
  let type = '';
  checkStream.on('data', chunk => { type += chunk.toString(); });
  await new Promise(resolve => checkStream.on('end', resolve));
  const isDir = type.includes('DIR');

  const baseName = require('path').basename(srcPath);
  let cmd = '';
  let downloadName = baseName;

  if (isDir) {
    downloadName = `${baseName}.tar.gz`;
    cmd = `tar -czf /tmp/c3_dl.tar.gz -C "$(dirname "${srcPath}")" "${baseName}" && base64 /tmp/c3_dl.tar.gz`;
  } else {
    cmd = `base64 "${srcPath}"`;
  }

  const exec = await c.exec({
    Cmd: ['bash', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });
  const s = await exec.start({});
  const chunks = [];
  s.on('data', chunk => chunks.push(chunk));
  await new Promise(resolve => s.on('end', resolve));
  const raw = Buffer.concat(chunks).toString();
  return { name: downloadName, base64: raw.replace(/\s+/g, '') };
});

// Provider renderer forwards user input to docker exec stdin
ipcMain.on('pty:input', (_, data) => {
  for (const [sid, pty] of activePtyStreams) {
    try {
      const stream = pty.stream || pty;
      stream.write(data);
    } catch (e) {}
  }
});

// Provider renderer forwards resize to docker exec
ipcMain.on('pty:resize', (_, { cols, rows }) => {
  const c = parseInt(cols, 10);
  const r = parseInt(rows, 10);
  if (isNaN(c) || isNaN(r)) return;
  for (const [sid, pty] of activePtyStreams) {
    try {
      if (pty.exec && typeof pty.exec.resize === 'function') {
        pty.exec.resize({ h: r, w: c });
      }
    } catch (e) {}
  }
});

ipcMain.handle('provider:decline', async (_, sessionId) => {
  // Update DynamoDB first so the user-side poll sees DECLINED immediately
  await dynamo.updateSessionStatus(sessionId, 'DECLINED').catch(e => console.error('[C3] decline dynamo error:', e));
  return true;
});

ipcMain.handle('provider:end', async (_, sessionId) => {
  // Clean up pty stream
  const pty = activePtyStreams.get(sessionId);
  const stream = pty?.stream || pty;
  if (stream) { try { stream.end(); } catch(_){} activePtyStreams.delete(sessionId); }
  // Clean up signal poll
  const signalPoll = sessionPollMap.get('signal-' + sessionId);
  if (signalPoll) { clearInterval(signalPoll); sessionPollMap.delete('signal-' + sessionId); }
  // Stop container
  try { await docker.stopSession(sessionId); } catch (_) {}
  await dynamo.updateSessionStatus(sessionId, 'COMPLETED').catch(() => {});
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════════
// ICE / TURN CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const awsConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'aws-config.json'), 'utf8'));

ipcMain.handle('ice:config', async () => {
  const base = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
  const turnServers = awsConfig.turnServers || [];
  return [...base, ...turnServers];
});

// ═══════════════════════════════════════════════════════════════════════════════
// MARKETPLACE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('market:providers', async () => {
  try {
    const list = await dynamo.getActiveProviders();
    console.log('[C3] market:providers returning', list.length, 'nodes');
    return list;
  } catch (e) {
    console.error('[C3] market:providers ERROR:', e.message);
    return [];
  }
});

ipcMain.handle('market:request', async (_, payload) => {
  const userId = getUserId();
  const sessionId = require('uuid').v4();

  await dynamo.createSessionRequest({
    sessionId,
    providerId: payload.providerId,
    userId,
    environment: payload.environment || 'base',
    cpuCores: payload.cpuCores || 2,
    ramGb: payload.ramGb || 4,
    durationHours: payload.durationHours || 1,
    cudaRequested: payload.cudaRequested || false,
    status: 'PENDING',
  });

  // Poll for session status (READY/DECLINED) - with logging so errors are visible
  debugLog('info', `Polling DynamoDB for session ${sessionId} status...`);
  const poll = setInterval(async () => {
    try {
      const session = await dynamo.getSession(sessionId);
      if (!session) {
        debugLog('warn', `Session ${sessionId} not found in DynamoDB yet`);
        return;
      }
      debugLog('info', `Session ${sessionId} status: ${session.status}`);
      if (session.status === 'READY') {
        clearInterval(poll);
        sessionPollMap.delete(sessionId);
        debugLog('ok', `✅ Session READY — notifying renderer`);
        send('session:ready', { sessionId, ...session });
      } else if (session.status === 'DECLINED' || session.status === 'COMPLETED') {
        clearInterval(poll);
        sessionPollMap.delete(sessionId);
        send('session:ready', { sessionId, status: session.status });
      }
    } catch (e) {
      debugLog('warn', `Session poll error: ${e.message}`);
    }
  }, 1000);

  sessionPollMap.set(sessionId, poll);
  return { sessionId };
});

// Allow renderer to directly check session status (fallback for cross-device polling)
ipcMain.handle('session:get', async (_, sessionId) => {
  try {
    return await dynamo.getSession(sessionId);
  } catch (e) {
    console.error('[C3] session:get error:', e.message);
    return null;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREDITS & CHAT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('credits:get', async () => {
  const userId = getUserId();
  const user = await dynamo.getUser(userId).catch(() => ({ credits: 100 }));
  return user?.credits ?? 100;
});

ipcMain.handle('chat:send', async (_, { toUserId, text }) => {
  const userId = getUserId();
  const chatId = [userId, toUserId].sort().join('#');
  await dynamo.sendChatMessage(chatId, userId, text);
  return true;
});

ipcMain.handle('chat:startpoll', async (_, chatId) => {
  if (chatPollTimer) clearInterval(chatPollTimer);

  // Fetch the last hour of messages immediately when poll starts
  try {
    const sinceInit = Math.floor(Date.now() / 1000) - 3600;
    const history   = await dynamo.getChatMessages(chatId, sinceInit);
    if (history.length > 0) send('chat:messages', history);
  } catch (_) {}

  let since = Math.floor(Date.now() / 1000);
  chatPollTimer = setInterval(async () => {
    try {
      const msgs = await dynamo.getChatMessages(chatId, since);
      if (msgs.length > 0) { since = Math.floor(Date.now() / 1000); send('chat:messages', msgs); }
    } catch (_) {}
  }, 2_000);
  return true;
});

ipcMain.handle('chat:stoppoll', () => {
  if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  return true;
});

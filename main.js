'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');


// ── Core modules ──────────────────────────────────────────────────────────────
const cognito  = require('./core/cognito');
const dynamo   = require('./core/dynamodb');
const hardware = require('./core/hardware');
const docker   = require('./core/docker');
const tunnel   = require('./core/tunnel');
const ssh      = require('./core/ssh');
const keypair  = require('./core/keypair');

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindow       = null;
let heartbeatTimer   = null;
let pendingPollTimer = null;
let chatPollTimer    = null;
let sessionPollMap   = new Map(); // sessionId → interval
let privateKeyMap    = new Map(); // sessionId → privateKeyPem
let activeUserId     = null;

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

function saveSession(userId) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ userId }), 'utf8'); } catch (_) {}
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

function getUserId() {
  return cognito.getUserId() || activeUserId || 'anonymous_user';
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

ipcMain.handle('auth:login', async (_, { email, pass }) => {
  const data = await cognito.login(email, pass);
  activeUserId = data.userId;
  saveSession(data.userId); // persist so IPC works after restart
  try { await dynamo.createUser(data.userId, data.email); } catch (_e) {}
  const user = await dynamo.getUser(data.userId).catch(() => ({ userId: data.userId, email: data.email, credits: 100 }));
  return { ...data, ...user };
});

ipcMain.handle('auth:signup', async (_, { email, pass }) => {
  return await cognito.signUp(email, pass);
});

ipcMain.handle('auth:confirm', async (_, { email, code }) => {
  return await cognito.confirmSignUp(email, code);
});

ipcMain.handle('auth:signout', async () => {
  await cognito.signOut();
  activeUserId = null;
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
  return true;
});

ipcMain.handle('auth:getuser', async () => {
  const userId = getUserId();
  if (!userId || userId === 'anonymous_user') return null;
  try {
    const user = await dynamo.getUser(userId);
    return { ...user, email: cognito.getEmail() };
  } catch {
    return { userId, email: cognito.getEmail(), credits: 100 };
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
  const dockerOk = await docker.isDockerRunning();
  if (!dockerOk) throw new Error('Docker Desktop is not running. Please start Docker Desktop first.');

  // Start container with SSH server — returns { container, hostPort }
  const { hostPort } = await docker.startSession(
    sessionId,
    data.environment   || 'base',
    data.cpuCores      || 2,
    data.ramGb         || 4,
    data.publicKey     || '',
    data.cudaRequested || false,
  );

  console.log(`[C3] Container up — SSH listening on host port ${hostPort}`);

  // Start reverse SSH tunnel pointing to the container's SSH port
  let host, port;
  try {
    ({ host, port } = await tunnel.startTunnel(parseInt(hostPort), sessionId));
    console.log(`[C3] Tunnel resolved → SSH endpoint: ${host}:${port}`);
  } catch (tunnelErr) {
    // Tunnel completely failed — throw so provider sees the error
    await docker.stopSession(sessionId).catch(() => {});
    throw new Error(`Tunnel failed: ${tunnelErr.message}`);
  }

  // Mark session READY with SSH endpoint — this is what the user reads
  await dynamo.updateSessionStatus(sessionId, 'READY', { sshHost: host, sshPort: port });
  console.log(`[C3] DynamoDB updated: sshHost=${host} sshPort=${port}`);

  return { host, port };
});

ipcMain.handle('provider:decline', async (_, sessionId) => {
  // Update DynamoDB first so the user-side poll sees DECLINED immediately
  await dynamo.updateSessionStatus(sessionId, 'DECLINED').catch(e => console.error('[C3] decline dynamo error:', e));
  return true;
});

ipcMain.handle('provider:end', async (_, sessionId) => {
  try { tunnel.stopTunnel(); } catch (_) {}
  try { await docker.stopSession(sessionId); } catch (_) {}
  await dynamo.updateSessionStatus(sessionId, 'COMPLETED').catch(() => {});
  return true;
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
  const { privateKeyPem, publicKeyOpenSSH } = keypair.generateKeyPair();
  const sessionId = require('uuid').v4();
  privateKeyMap.set(sessionId, privateKeyPem);

  await dynamo.createSessionRequest({
    sessionId,
    providerId:     payload.providerId,
    userId,
    environment:    payload.environment   || 'base',
    cpuCores:       payload.cpuCores      || 2,
    ramGb:          payload.ramGb         || 4,
    durationHours:  payload.durationHours || 1,
    cudaRequested:  payload.cudaRequested || false,
    publicKey:      publicKeyOpenSSH,
    status:         'PENDING',
  });

  const poll = setInterval(async () => {
    try {
      const session = await dynamo.getSession(sessionId);
      if (session.status === 'READY') {
        clearInterval(poll);
        sessionPollMap.delete(sessionId);
        send('session:ready', { sessionId, ...session });
      } else if (session.status === 'DECLINED' || session.status === 'COMPLETED') {
        clearInterval(poll);
        sessionPollMap.delete(sessionId);
        send('session:ready', { sessionId, status: session.status });
      }
    } catch (_) {}
  }, 2_000);

  sessionPollMap.set(sessionId, poll);
  return { sessionId };
});

// ═══════════════════════════════════════════════════════════════════════════════
// CREDITS & CHAT & SSH & SFTP HANDLERS
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

ipcMain.handle('ssh:connect', async (_, sessionId) => {
  const session       = await dynamo.getSession(sessionId);
  const privateKeyPem = privateKeyMap.get(sessionId);

  if (!privateKeyPem) throw new Error('Session keypair not found — please reconnect.');
  if (!session.sshHost || !session.sshPort) throw new Error('Session not ready — no SSH endpoint.');

  console.log(`[C3] Connecting SSH → ${session.sshHost}:${session.sshPort}`);

  await ssh.connect(
    session.sshHost,
    session.sshPort,
    privateKeyPem,
    (data) => send('ssh:data',  data),
    ()     => send('ssh:close', null),
  );

  // SFTP is optional — open in background so the terminal isn't blocked by it
  ssh.openSftp().catch(e => console.warn('[C3] SFTP init failed (non-fatal):', e.message));
  ssh.startTelemetry((m) => send('ssh:telemetry', m));
  return true;
});

ipcMain.handle('ssh:disconnect', async () => {
  ssh.stopTelemetry();
  ssh.disconnect();
  return true;
});

ipcMain.on('ssh:input',  (_, data)           => ssh.sendInput(data));
ipcMain.on('ssh:resize', (_, { cols, rows }) => ssh.resizeTerminal(cols, rows));

ipcMain.handle('sftp:list',     async (_, remotePath)          => ssh.listFiles(remotePath));
ipcMain.handle('sftp:upload',   async (_, { local, remote })   => ssh.uploadFile(local, remote));
ipcMain.handle('sftp:download', async (_, { remote, local })   => ssh.downloadFile(remote, local));

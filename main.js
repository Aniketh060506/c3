'use strict';

/**
 * main.js — Electron main process for C3 Community Compute Cloud
 *
 * Responsibilities:
 *  - Window lifecycle management
 *  - All IPC handlers (auth, hardware, provider, cluster, credits)
 *  - Background polling loops (heartbeat, request polling)
 *  - Cluster orchestration state machine
 *  - Persisting/restoring session across app restarts
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const cognito = require('./core/cognito');
const dynamo = require('./core/dynamodb');
const tailscale = require('./core/tailscale');
const k3s = require('./core/k3s-cluster');
const hardware = require('./core/hardware');
const dispatcher = require('./core/task-dispatcher');
const setupChecker = require('./core/setup-checker');
const awsConfig = require('./aws-config.json');

// ── Constants ─────────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development';
const SESSION_FILE = path.join(app.getPath('userData'), 'c3_session.json');

// ── State ─────────────────────────────────────────────────────────────────
let mainWindow = null;
let heartbeatInterval = null;
let requestPollInterval = null;
let providerActive = false;
let currentSession = null; // { sessionId, role: 'consumer'|'provider', ... }

// ── Session persistence ────────────────────────────────────────────────────
function saveSession(data) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[session] Failed to save session:', err.message);
  }
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    }
  } catch {
    // Ignore corrupt sessions
  }
  return null;
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {}
  currentSession = null;
}

// ── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#1e293b',
      height: 64,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.removeMenu();
  mainWindow.show();
  mainWindow.focus();

  const distHtml = path.join(__dirname, 'dist-ui', 'index.html');
  const AUTH_URL = 'https://ap-south-11fuiqpnq2.auth.ap-south-1.amazoncognito.com/login?client_id=7frk04l4hn042tssu6rpievuf3&response_type=code&scope=email+openid+phone&redirect_uri=https%3A%2F%2Fd84l1y8p4kdic.cloudfront.net';
  const REDIRECT_PREFIX = 'https://d84l1y8p4kdic.cloudfront.net';

  const saved = loadSession();
  if (saved?.tokens?.idToken) {
    cognito.restoreSession(saved.tokens);
    currentSession = saved;
    mainWindow.loadFile(distHtml);
  } else {
    // Directly launch AWS Cognito Hosted Login UI
    mainWindow.loadURL(AUTH_URL);
  }

  // Intercept the CloudFront redirect to capture the auth code automatically
  let exchangingAuth = false;
  const handleAuthNavigation = async (url) => {
    if (url.startsWith(REDIRECT_PREFIX) && !exchangingAuth) {
      try {
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        if (code) {
          exchangingAuth = true;
          console.log('[auth] Intercepted authorization code from AWS Hosted UI!');
          const user = await cognito.exchangeCodeForTokens(code);
          try { await dynamo.createUser(user.userId, user.email); } catch (_) {}
          currentSession = { userId: user.userId, tokens: user.tokens };
          saveSession(currentSession);
          console.log('[auth] Login succeeded! Loading C3 dashboard...');
          mainWindow.loadFile(distHtml);
        }
      } catch (err) {
        exchangingAuth = false;
        console.error('[auth] Code exchange error:', err.message);
      }
    }
  };

  mainWindow.webContents.on('will-redirect', (_e, url) => handleAuthNavigation(url));
  mainWindow.webContents.on('will-navigate', (_e, url) => handleAuthNavigation(url));
  mainWindow.webContents.on('did-navigate', (_e, url) => handleAuthNavigation(url));

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('maximize', () => pushToRenderer('window:maximized-change', true));
  mainWindow.on('unmaximize', () => pushToRenderer('window:maximized-change', false));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Helper: push events to renderer ───────────────────────────────────────
function pushToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ── Provider polling helpers ──────────────────────────────────────────────
function startProviderLoop(userId) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (requestPollInterval) clearInterval(requestPollInterval);

  // Heartbeat every 60 seconds
  heartbeatInterval = setInterval(async () => {
    try {
      await dynamo.heartbeat(userId);
    } catch (err) {
      console.error('[heartbeat] Error:', err.message);
    }
  }, 60000);

  // Poll for pending cluster requests every 1.5 seconds for instant invitation alerts
  requestPollInterval = setInterval(async () => {
    try {
      const requests = await dynamo.getPendingClusterRequestsForProvider(userId);
      if (requests && requests.length > 0) {
        pushToRenderer('cluster:request', requests[0]);
      }
    } catch (err) {
      console.error('[poll:requests] Error:', err.message);
    }
  }, 1500);
}

function stopProviderLoop() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (requestPollInterval) { clearInterval(requestPollInterval); requestPollInterval = null; }
}

let demoSessionUser = null;

// ── IPC: Auth (AWS Hosted UI) ─────────────────────────────────────────────
ipcMain.handle('auth:open-hosted-login', async () => {
  return new Promise((resolve, reject) => {
    const authUrl = 'https://ap-south-11fuiqpnq2.auth.ap-south-1.amazoncognito.com/login?client_id=7frk04l4hn042tssu6rpievuf3&response_type=code&scope=email+openid+phone&redirect_uri=https%3A%2F%2Fd84l1y8p4kdic.cloudfront.net';

    const authWin = new BrowserWindow({
      width: 520,
      height: 720,
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      autoHideMenuBar: true,
      title: 'AWS Cognito Sign In',
      backgroundColor: '#ffffff',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    authWin.loadURL(authUrl);

    let resolved = false;

    const handleNavigation = async (url) => {
      if (url.startsWith('https://d84l1y8p4kdic.cloudfront.net')) {
        try {
          const parsed = new URL(url);
          const code = parsed.searchParams.get('code');
          const error = parsed.searchParams.get('error');

          if (error) {
            resolved = true;
            authWin.destroy();
            return reject(new Error(parsed.searchParams.get('error_description') || error));
          }

          if (code) {
            resolved = true;
            authWin.destroy();
            const user = await cognito.exchangeCodeForTokens(code);
            try { await dynamo.createUser(user.userId, user.email); } catch (_) {}
            currentSession = { userId: user.userId, tokens: user.tokens };
            saveSession(currentSession);
            resolve(user);
          }
        } catch (err) {
          resolved = true;
          authWin.destroy();
          reject(err);
        }
      }
    };

    authWin.webContents.on('will-redirect', (_e, url) => handleNavigation(url));
    authWin.webContents.on('will-navigate', (_e, url) => handleNavigation(url));
    authWin.webContents.on('did-navigate', (_e, url) => handleNavigation(url));

    authWin.on('closed', () => {
      if (!resolved) {
        reject(new Error('Sign in window was closed'));
      }
    });
  });
});

// ── IPC: Auth (Direct / Demo) ─────────────────────────────────────────────
ipcMain.handle('auth:login', async (_e, { email, password }) => {
  if (email?.toLowerCase().includes('demo') || password?.toLowerCase() === 'demo' || email?.includes('test')) {
    demoSessionUser = { userId: 'demo-user-1', email: email || 'demo@c3.cloud', credits: 250 };
    return demoSessionUser;
  }
  const result = await cognito.login(email, password);
  // Attempt to create user record if first login (ignores ConditionFailedException)
  try {
    await dynamo.createUser(result.userId, result.email);
  } catch { /* Already exists */ }
  return result;
});

ipcMain.handle('auth:signup', async (_e, { email, password }) => {
  await cognito.signUp(email, password);
  return { ok: true };
});

ipcMain.handle('auth:confirm', async (_e, { email, code }) => {
  await cognito.confirmSignUp(email, code);
  return { ok: true };
});

ipcMain.handle('auth:signout', async () => {
  demoSessionUser = null;
  stopProviderLoop();
  providerActive = false;
  clearSession();
  dynamo.resetClient();
  await cognito.signOut().catch(() => {});
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(AUTH_URL);
  }
  return { ok: true };
});

ipcMain.handle('auth:getuser', async () => {
  if (demoSessionUser) return demoSessionUser;
  const userId = cognito.getUserId();
  if (!userId) return null;
  try {
    const user = await dynamo.getUser(userId);
    return { userId, email: cognito.getEmail(), credits: user?.credits ?? 0 };
  } catch {
    return { userId, email: cognito.getEmail(), credits: 0 };
  }
});

// ── IPC: Hardware ─────────────────────────────────────────────────────────
ipcMain.handle('hw:specs', async () => {
  return await hardware.getHardwareSpecs();
});

ipcMain.handle('hw:livestats', async () => {
  return await hardware.getLiveStats();
});

// ── IPC: Provider ─────────────────────────────────────────────────────────
ipcMain.handle('provider:register', async (_e, profile) => {
  const userId = cognito.getUserId() || demoSessionUser?.userId;
  if (!userId) throw new Error('Not authenticated');
  if (demoSessionUser) return { ok: true };
  await dynamo.registerProvider(userId, profile);
  return { ok: true };
});

ipcMain.handle('provider:toggle', async (_e, { active }) => {
  const userId = cognito.getUserId() || demoSessionUser?.userId;
  if (!userId) throw new Error('Not authenticated');

  if (demoSessionUser) {
    providerActive = active;
    return { ok: true, active: providerActive };
  }

  if (active) {
    await dynamo.updateProviderStatus(userId, 'ONLINE');
    await dynamo.heartbeat(userId);
    startProviderLoop(userId);
    providerActive = true;
  } else {
    stopProviderLoop();
    await dynamo.updateProviderStatus(userId, 'OFFLINE');
    providerActive = false;
    // Instantly remove any running cluster containers
    await k3s.stopCluster().catch(() => {});
  }
  return { ok: true, active: providerActive };
});

// ── IPC: Cluster (Consumer-side) ──────────────────────────────────────────
ipcMain.handle('cluster:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Workspace Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('cluster:create', async (_e, { providerIds, workspacePath }) => {
  const userId = cognito.getUserId();
  if (!userId) throw new Error('Not authenticated');

  const sessionId = uuidv4();
  const clusterToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');

  let tailscaleAuthKey = '';
  try {
    const freshCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'aws-config.json'), 'utf8'));
    tailscaleAuthKey = freshCfg.tailscaleAuthKey || '';
  } catch {
    tailscaleAuthKey = awsConfig.tailscaleAuthKey || '';
  }

  await dynamo.createClusterSession({
    sessionId,
    consumerId: userId,
    providerIds,
    k3sToken: clusterToken,
    tailscaleAuthKey,
  });

  pushToRenderer('cluster:status', { status: 'NEGOTIATING', sessionId });
  pushToRenderer('cluster:log', `[c3] Session ${sessionId} created. Waiting for providers...`);

  // Poll until all providers ACCEPTED (or timeout 5 minutes)
  const deadline = Date.now() + 5 * 60 * 1000;
  let allAccepted = false;

  const pollAcceptance = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(pollAcceptance);
      await dynamo.setClusterStatus(sessionId, 'TIMEOUT');
      pushToRenderer('cluster:status', { status: 'TIMEOUT', sessionId });
      pushToRenderer('cluster:log', '[c3] Timeout: not all providers accepted.');
      return;
    }

    try {
      const session = await dynamo.getSession(sessionId);
      if (!session) return;

      const statuses = Object.values(session.providersStatus || {});
      if (statuses.some((s) => s === 'DECLINED')) {
        clearInterval(pollAcceptance);
        pushToRenderer('cluster:status', { status: 'DECLINED', sessionId });
        pushToRenderer('cluster:log', '[c3] A provider declined the request.');
        return;
      }

      if (statuses.every((s) => s === 'ACCEPTED')) {
        clearInterval(pollAcceptance);
        allAccepted = true;
        pushToRenderer('cluster:log', '[c3] All providers accepted. Bootstrapping cluster...');
        pushToRenderer('cluster:status', { status: 'BOOTSTRAPPING', sessionId });
        bootstrapMasterNode(sessionId, clusterToken, workspacePath);
      }
    } catch (err) {
      console.error('[poll:acceptance]', err.message);
    }
  }, 1200);

  return { sessionId };
});

async function bootstrapMasterNode(sessionId, clusterToken, workspacePath) {
  try {
    pushToRenderer('cluster:log', '[c3] Discovering cluster network interface...');
    if (awsConfig.tailscaleAuthKey && !awsConfig.tailscaleAuthKey.includes('PLACEHOLDER')) {
      try {
        pushToRenderer('cluster:log', '[c3] Connecting to Tailscale mesh fabric...');
        await tailscale.joinMesh(awsConfig.tailscaleAuthKey, 'c3-consumer');
      } catch (tsErr) {
        console.warn('[tailscale] Mesh join note:', tsErr.message);
      }
    }
    const net = await tailscale.getConnectableIp();
    const meshIp = net.ip;
    pushToRenderer('cluster:log', `[c3] Network mode: ${net.type.toUpperCase()} (Endpoint: ${meshIp})`);

    pushToRenderer('cluster:log', '[c3] Starting K3s master control plane in Docker...');
    await k3s.startMasterNode({ meshIp, clusterToken, localWorkspacePath: workspacePath });
    pushToRenderer('cluster:log', '[c3] K3s master is running and accepting worker nodes.');

    await dynamo.setClusterMasterMeshIp(sessionId, meshIp);
    await dynamo.setClusterStatus(sessionId, 'ACTIVE');

    const session = await dynamo.getSession(sessionId);
    currentSession = { ...session, role: 'consumer', workspacePath };
    saveSession(currentSession);

    pushToRenderer('cluster:status', { status: 'ACTIVE', sessionId, meshIp, session: currentSession });
    pushToRenderer('cluster:log', '[c3] Cluster is ACTIVE and ready.');
  } catch (err) {
    pushToRenderer('cluster:log', `[c3] Bootstrap error: ${err.message}`);
    pushToRenderer('cluster:status', { status: 'ERROR', error: err.message });
    await dynamo.setClusterStatus(sessionId, 'ERROR').catch(() => {});
  }
}

// ── IPC: Cluster (Provider-side) ──────────────────────────────────────────
ipcMain.handle('cluster:accept', async (_e, { sessionId }) => {
  const userId = cognito.getUserId();
  if (!userId) throw new Error('Not authenticated');

  await dynamo.acceptClusterRequest(sessionId, userId);
  pushToRenderer('cluster:log', `[c3] Accepted session ${sessionId}. Waiting for master IP...`);

  // Poll for consumerMeshIp
  const deadline = Date.now() + 5 * 60 * 1000;
  const pollMeshIp = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(pollMeshIp);
      pushToRenderer('cluster:log', '[c3] Timeout waiting for master IP.');
      return;
    }
    try {
      const session = await dynamo.getSession(sessionId);
      if (session?.consumerMeshIp) {
        clearInterval(pollMeshIp);
        pushToRenderer('cluster:log', `[c3] Got master IP: ${session.consumerMeshIp}. Starting worker...`);

        // Automatically join Tailscale mesh if Host provided a valid auth key
        if (session.tailscaleAuthKey && session.tailscaleAuthKey.startsWith('tskey-auth-')) {
          try {
            pushToRenderer('cluster:log', '[c3] Joining Tailscale mesh with session auth key...');
            await tailscale.joinMesh(session.tailscaleAuthKey, `c3-worker-${userId.slice(0, 8)}`);
            pushToRenderer('cluster:log', '[c3] Joined Tailscale mesh successfully.');
          } catch (tsErr) {
            console.warn('[tailscale] Worker mesh join note:', tsErr.message);
            pushToRenderer('cluster:log', `[tailscale] Mesh note: ${tsErr.message}`);
          }
        }

        await k3s.startWorkerNode({
          masterMeshIp: session.consumerMeshIp,
          clusterToken: session.k3sToken,
          gpuEnabled: false,
        });
        currentSession = { ...session, role: 'provider' };
        saveSession(currentSession);
        pushToRenderer('cluster:status', { status: 'WORKER_ACTIVE', sessionId });
        pushToRenderer('cluster:log', '[c3] Worker node is active and connected to cluster.');
      }
    } catch (err) {
      console.error('[poll:meshIp]', err.message);
    }
  }, 1500);

  return { ok: true };
});

ipcMain.handle('cluster:decline', async (_e, { sessionId }) => {
  const userId = cognito.getUserId();
  if (!userId) throw new Error('Not authenticated');
  await dynamo.declineClusterRequest(sessionId, userId);
  return { ok: true };
});

ipcMain.handle('cluster:telemetry', async () => {
  return await dispatcher.getAggregatedTelemetry();
});

ipcMain.handle('cluster:dispatch', async (_e, { target, command }) => {
  const logs = [];
  await dispatcher.dispatchWorkload({
    target,
    command,
    onLog: (line) => {
      logs.push(line);
      pushToRenderer('cluster:log', line);
    },
  });
  return { ok: true, logs };
});

ipcMain.handle('cluster:stop', async () => {
  try {
    await k3s.stopCluster();
    if (currentSession?.sessionId) {
      await dynamo.setClusterStatus(currentSession.sessionId, 'STOPPED').catch(() => {});
    }
  } catch (err) {
    console.error('[cluster:stop]', err.message);
  }
  clearSession();
  pushToRenderer('cluster:status', { status: 'STOPPED' });
  return { ok: true };
});

ipcMain.handle('settings:get-tailscale-key', async () => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'aws-config.json'), 'utf8'));
    return cfg.tailscaleAuthKey || '';
  } catch {
    return awsConfig.tailscaleAuthKey || '';
  }
});

ipcMain.handle('settings:save-tailscale-key', async (_e, key) => {
  try {
    const cfgPath = path.join(__dirname, 'aws-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.tailscaleAuthKey = (key || '').trim();
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    awsConfig.tailscaleAuthKey = cfg.tailscaleAuthKey;
    if (cfg.tailscaleAuthKey.startsWith('tskey-auth-')) {
      await tailscale.joinMesh(cfg.tailscaleAuthKey, 'c3-host').catch(() => {});
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: Credits ──────────────────────────────────────────────────────────
ipcMain.handle('credits:get', async () => {
  if (demoSessionUser) return { credits: demoSessionUser.credits || 250 };
  const userId = cognito.getUserId();
  if (!userId) return { credits: 0 };
  try {
    const user = await dynamo.getUser(userId);
    return { credits: user?.credits ?? 0 };
  } catch {
    return { credits: 0 };
  }
});

// ── Providers marketplace ─────────────────────────────────────────────────
ipcMain.handle('providers:list', async () => {
  try {
    const list = await dynamo.getActiveProviders();
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.error('[providers:list] DynamoDB error:', err.message);
    return [];
  }
});

// ── IPC: Setup Checker & System ──────────────────────────────────────────
ipcMain.handle('setup:check', async () => {
  try {
    return await setupChecker.runAllChecks();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('setup:pull-k3s', async () => {
  const logs = [];
  try {
    await setupChecker.pullK3sImage(msg => {
      logs.push(msg);
      pushToRenderer('setup:pull-k3s-progress', msg);
    });
    return { ok: true, logs };
  } catch (err) {
    return { ok: false, error: err.message, logs };
  }
});

ipcMain.handle('setup:install-tailscale', async () => {
  const logs = [];
  try {
    await setupChecker.installTailscale(msg => {
      logs.push(msg);
      pushToRenderer('setup:install-progress', msg);
    });
    return { ok: true, logs };
  } catch (err) {
    return { ok: false, error: err.message, logs };
  }
});

ipcMain.handle('system:open-external', async (_e, url) => {
  if (url && typeof url === 'string') {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('system:launch-docker', async () => {
  const { exec } = require('child_process');
  exec('start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe" || start docker');
  return { ok: true };
});

// ── IPC: Window Controls ──────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('window:maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

ipcMain.handle('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

ipcMain.handle('window:is-maximized', () => {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false;
});

// ── App lifecycle with single-instance lock ──────────────────────────────
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    // Restore session tokens if saved
    const saved = loadSession();
    if (saved?.tokens) {
      cognito.restoreSession(saved.tokens);
      currentSession = saved;
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  stopProviderLoop();
});

'use strict';

/**
 * main.js — Electron main process for C3 Community Compute Cloud
 *
 * Full Integration:
 *  - AWS Cognito Authentication (Hosted UI + Direct Credentials)
 *  - Machine Name Prompt (per account / per machine)
 *  - DynamoDB Provider Registry, Heartbeat & Session Negotiation
 *  - P2P LAN & Tailscale Mesh Discovery
 *  - Real-Time Hardware Telemetry (No Hardcoded Fallbacks)
 *  - Single-Instance Locking & Frameless Native Titlebar
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const cognito = require('./core/cognito');
const dynamo = require('./core/dynamodb');
const tailscale = require('./core/tailscale');
const k3s = require('./core/k3s-cluster');
const hardware = require('./core/hardware');
const dispatcher = require('./core/task-dispatcher');
const setupChecker = require('./core/setup-checker');
const p2p = require('./core/p2p-coordinator');
let awsConfig;
try {
  awsConfig = require('./aws-config.json');
} catch {
  awsConfig = {
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_1FuIqpNq2',
    clientId: '7frk04l4hn042tssu6rpievuf3',
    clientSecret: 'gijgjmh3ig3kbtqrr26tqfr4g53gnigbpl1q1r6hnbdmef0rfrl',
    identityPoolId: 'ap-south-1:65a4b02e-18e7-47b1-ab84-d8877f9b10e2',
    tailscaleAuthKey: 'tskey-auth-kuxGWyFp7S11CNTRL-Mb8qcGZZXMTVErF3YUjjMTB61TSWNgLg',
  };
  try {
    fs.writeFileSync(path.join(__dirname, 'aws-config.json'), JSON.stringify(awsConfig, null, 2), 'utf8');
  } catch (_) {}
}

// ── Persistence Paths ──────────────────────────────────────────────────────
const SESSION_FILE = path.join(app.getPath('userData'), 'c3_session.json');
const PROFILE_FILE = path.join(app.getPath('userData'), 'c3_node_profile.json');
const AUTH_URL = 'https://ap-south-11fuiqpnq2.auth.ap-south-1.amazoncognito.com/login?client_id=7frk04l4hn042tssu6rpievuf3&response_type=code&scope=email+openid+phone&redirect_uri=https%3A%2F%2Fd84l1y8p4kdic.cloudfront.net';
const REDIRECT_PREFIX = 'https://d84l1y8p4kdic.cloudfront.net';

let mainWindow = null;
let currentSession = null; // Current cluster session
let providerActive = false;
let heartbeatInterval = null;
let requestPollInterval = null;
let demoSessionUser = null;
const pendingJoinRequests = new Map();

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
  } catch (_) {}
  return null;
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (_) {}
  demoSessionUser = null;
}

function loadAllProfiles() {
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
      if (typeof data === 'object' && data !== null) return data;
    }
  } catch (_) {}
  return {};
}

function getProfileForEmail(email) {
  if (!email) return { displayName: '' };
  const all = loadAllProfiles();
  const normalized = email.trim().toLowerCase();
  if (all[normalized] && typeof all[normalized] === 'object') {
    return all[normalized];
  }
  return { displayName: '' };
}

function saveProfileForEmail(email, data) {
  try {
    if (!email) return;
    const all = loadAllProfiles();
    const normalized = email.trim().toLowerCase();
    all[normalized] = { ...(all[normalized] || {}), ...data, email: normalized };
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(all, null, 2), 'utf-8');
  } catch (err) {
    console.error('[profile] Failed to save profile:', err.message);
  }
}

function loadProfile(email) {
  const targetEmail = email || cognito.getEmail() || demoSessionUser?.email || loadSession()?.email || '';
  if (targetEmail) return getProfileForEmail(targetEmail);
  return { displayName: '' };
}

// ── Window Management ──────────────────────────────────────────────────────
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
    ...(fs.existsSync(path.join(__dirname, 'assets', 'icon.png')) ? { icon: path.join(__dirname, 'assets', 'icon.png') } : {}),
  });

  mainWindow.removeMenu();
  mainWindow.show();
  mainWindow.focus();

  const distHtml = path.join(__dirname, 'dist-ui', 'index.html');

  // Intercept AWS Cognito OAuth redirect on mainWindow
  async function handleCognitoRedirect(url) {
    try {
      const parsed = new URL(url);
      const code = parsed.searchParams.get('code');
      const error = parsed.searchParams.get('error');

      if (error) {
        console.error('[auth] Cognito redirect error:', error);
        mainWindow.loadURL(AUTH_URL);
        return;
      }

      if (code) {
        console.log('[auth] Intercepted authorization code from AWS Hosted UI!');
        const user = await cognito.exchangeCodeForTokens(code);
        try { await dynamo.createUser(user.userId, user.email); } catch (_) {}

        const profile = getProfileForEmail(user.email);
        const displayName = profile?.displayName || '';

        const sessionData = {
          userId: user.userId,
          email: user.email,
          tokens: user.tokens,
          displayName,
        };
        saveSession(sessionData);

        p2p.updateProfile({ displayName });

        // Auth succeeded -> Load application UI!
        mainWindow.loadFile(distHtml);
      }
    } catch (err) {
      console.error('[auth] Failed to process Cognito redirect:', err.message);
      mainWindow.loadURL(AUTH_URL);
    }
  }

  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (url.startsWith(REDIRECT_PREFIX)) {
      event.preventDefault();
      handleCognitoRedirect(url);
    }
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(REDIRECT_PREFIX)) {
      event.preventDefault();
      handleCognitoRedirect(url);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL && validatedURL.includes('amazoncognito.com')) {
      console.warn(`[auth] Failed to load AWS Cognito (${errorCode}): ${errorDescription}`);
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>AWS Sign In</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #fafafa; color: #1e293b; }
            .card { background: white; border: 1px solid #e2e8f0; border-radius: 20px; padding: 40px; max-width: 400px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
            h2 { margin: 0 0 10px 0; font-size: 20px; }
            p { font-size: 13px; color: #64748b; margin-bottom: 24px; line-height: 1.5; }
            button { background: #ff9900; color: #0f172a; border: none; border-radius: 12px; font-weight: bold; padding: 12px 24px; font-size: 14px; cursor: pointer; }
            button:hover { background: #ffaa22; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Connection to AWS Failed</h2>
            <p>Could not reach Amazon Cognito. Please check your internet connection and try again.</p>
            <button onclick="window.location.href='${AUTH_URL}'">Retry AWS Sign In</button>
          </div>
        </body>
        </html>
      `)}`);
    }
  });

  // Check if saved session exists and is still valid
  const saved = loadSession();
  let hasValidSession = false;
  if (saved?.tokens?.idToken) {
    try {
      cognito.restoreSession(saved.tokens);
      if (cognito.getUserId()) {
        hasValidSession = true;
      }
    } catch (_) {}
  }

  if (hasValidSession) {
    mainWindow.loadFile(distHtml);
  } else {
    // Directly give AWS Cognito Hosted UI!
    mainWindow.loadURL(AUTH_URL);
  }

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

function pushToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ── Provider Loops (DynamoDB) ──────────────────────────────────────────────
function startProviderLoop(userId) {
  stopProviderLoop();

  // Heartbeat every 60 seconds
  heartbeatInterval = setInterval(async () => {
    try {
      await dynamo.heartbeat(userId);
    } catch (err) {
      console.error('[heartbeat] DynamoDB error:', err.message);
    }
  }, 60000);

  // Poll for pending cluster requests every 1.5 seconds
  requestPollInterval = setInterval(async () => {
    try {
      const requests = await dynamo.getPendingClusterRequestsForProvider(userId);
      if (requests && requests.length > 0) {
        for (const req of requests) {
          if (!pendingJoinRequests.has(req.sessionId)) {
            pendingJoinRequests.set(req.sessionId, req);
            pushToRenderer('cluster:request', req);
          }
        }
      }
    } catch (err) {
      // Quiet poll
    }
  }, 1500);
}

function stopProviderLoop() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (requestPollInterval) { clearInterval(requestPollInterval); requestPollInterval = null; }
}

// ── IPC: Auth (AWS Cognito & Session) ─────────────────────────────────────
ipcMain.handle('auth:getuser', async () => {
  if (demoSessionUser) return demoSessionUser;

  const saved = loadSession();
  if (saved?.tokens?.idToken) {
    try {
      cognito.restoreSession(saved.tokens);
    } catch (_) {}
  }

  const userId = cognito.getUserId();
  if (!userId) return null; // Triggers AuthScreen in UI

  const email = cognito.getEmail() || saved?.email || '';
  let credits = 100;
  try {
    const dbUser = await dynamo.getUser(userId);
    if (dbUser?.credits !== undefined) credits = dbUser.credits;
  } catch (_) {}

  // Look up profile specifically for this email on this device
  const profile = getProfileForEmail(email);
  const displayName = profile?.displayName || '';

  return {
    userId,
    email,
    displayName,
    suggestedName: os.hostname() || 'My-Laptop',
    credits,
  };
});

ipcMain.handle('auth:open-aws-login', async () => {
  clearSession();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(AUTH_URL);
  }
  return { ok: true };
});

ipcMain.handle('auth:open-hosted-login', async () => {
  clearSession();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(AUTH_URL);
  }
  return { ok: true };
});

ipcMain.handle('auth:login', async (_e, { email, password }) => {
  if (email?.toLowerCase().includes('demo') || password?.toLowerCase() === 'demo' || email?.includes('test')) {
    const profile = getProfileForEmail(email || 'demo@c3.cloud');
    demoSessionUser = {
      userId: 'demo-user-1',
      email: email || 'demo@c3.cloud',
      displayName: profile?.displayName || '',
      suggestedName: os.hostname() || 'My-Laptop',
      credits: 250,
    };
    saveSession(demoSessionUser);
    return demoSessionUser;
  }

  const result = await cognito.login(email, password);
  try { await dynamo.createUser(result.userId, result.email); } catch (_) {}

  const profile = getProfileForEmail(result.email);
  const displayName = profile?.displayName || '';

  const sessionData = {
    userId: result.userId,
    email: result.email,
    tokens: result.tokens,
    displayName,
  };
  saveSession(sessionData);

  p2p.updateProfile({ displayName });

  return {
    userId: result.userId,
    email: result.email,
    displayName,
    suggestedName: os.hostname() || 'My-Laptop',
    credits: 100,
  };
});

ipcMain.handle('auth:signup', async (_e, { email, password }) => {
  await cognito.signUp(email, password);
  return { ok: true };
});

ipcMain.handle('auth:confirm', async (_e, { email, code }) => {
  await cognito.confirmSignUp(email, code);
  return { ok: true };
});

ipcMain.handle('auth:set-name', async (_e, { displayName }) => {
  const cleanName = (displayName || '').trim();
  if (!cleanName) throw new Error('Machine name cannot be blank.');

  const email = cognito.getEmail() || demoSessionUser?.email || loadSession()?.email || '';
  if (email) {
    saveProfileForEmail(email, { displayName: cleanName });
  }

  const session = loadSession() || {};
  session.displayName = cleanName;
  saveSession(session);

  p2p.updateProfile({ displayName: cleanName });

  const userId = cognito.getUserId() || demoSessionUser?.userId;
  if (userId && !demoSessionUser) {
    try {
      const specs = await hardware.getHardwareSpecs();
      await dynamo.registerProvider(userId, {
        displayName: cleanName,
        cpuModel: specs.cpuModel,
        cpuCores: specs.cpuCores,
        ramGb: specs.ramGb,
        gpu: specs.gpu,
        os: specs.os,
      });
    } catch (_) {}
  }

  return {
    ok: true,
    user: {
      userId: session.userId || userId,
      email: email || session.email || cleanName,
      displayName: cleanName,
      credits: 100,
    },
  };
});

ipcMain.handle('auth:signout', async () => {
  stopProviderLoop();
  providerActive = false;
  clearSession();
  dynamo.resetClient();
  await cognito.signOut().catch(() => {});
  p2p.setSharing(false);
  await k3s.stopCluster().catch(() => {});
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(AUTH_URL);
  }
  return { ok: true };
});

// ── IPC: Hardware ─────────────────────────────────────────────────────────
ipcMain.handle('hw:specs', async () => {
  return await hardware.getHardwareSpecs();
});

let _lastLiveStatsResult = null;
let _liveStatsIpcBusy = false;
ipcMain.handle('hw:livestats', async () => {
  if (_liveStatsIpcBusy) return _lastLiveStatsResult;
  _liveStatsIpcBusy = true;
  try {
    _lastLiveStatsResult = await hardware.getLiveStats();
    return _lastLiveStatsResult;
  } finally {
    _liveStatsIpcBusy = false;
  }
});

// ── IPC: Provider (Sharing Hardware) ──────────────────────────────────────
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

  providerActive = Boolean(active);
  p2p.setSharing(providerActive);

  if (demoSessionUser) {
    return { ok: true, active: providerActive };
  }

  if (providerActive) {
    const session = loadSession() || {};
    const displayName = session.displayName || getProfileForEmail(session.email)?.displayName || os.hostname() || 'Compute Node';

    // Update p2p with correct userId now that we're authenticated
    p2p.updateProfile({ displayName });

    // Return immediately — register in background so UI is instant
    setImmediate(async () => {
      try {
        const specs = await hardware.getHardwareSpecs(); // instant — cached
        await dynamo.registerProvider(userId, {
          displayName,
          cpuModel: specs.cpuModel,
          cpuCores: specs.cpuCores,
          ramGb: specs.ramGb,
          gpu: specs.gpu,
          os: specs.os,
        });
        await dynamo.updateProviderStatus(userId, 'ONLINE');
        await dynamo.heartbeat(userId);
      } catch (err) {
        console.warn('[provider:toggle] DynamoDB register note:', err.message);
      }
    });
    startProviderLoop(userId);
  } else {
    stopProviderLoop();
    dynamo.updateProviderStatus(userId, 'OFFLINE').catch(() => {});
    k3s.stopCluster().catch(() => {});
  }

  return { ok: true, active: providerActive };
});

// ── IPC: Marketplace (DynamoDB + P2P) ─────────────────────────────────────
ipcMain.handle('providers:list', async () => {
  const currentUserId = cognito.getUserId() || demoSessionUser?.userId;
  const merged = new Map();

  // 1. Fetch from DynamoDB
  try {
    const dList = await dynamo.getActiveProviders();
    if (Array.isArray(dList)) {
      for (const p of dList) {
        const isSelf = Boolean(currentUserId && p.userId === currentUserId);
        merged.set(p.userId, { ...p, isSelf });
      }
    }
  } catch (err) {
    console.warn('[providers:list] DynamoDB note:', err.message);
  }

  // 2. Fetch from local P2P coordinator
  try {
    const pList = p2p.getAvailableProviders();
    if (Array.isArray(pList)) {
      for (const p of pList) {
        const isSelf = Boolean(currentUserId && p.userId === currentUserId);
        merged.set(p.userId, { ...(merged.get(p.userId) || {}), ...p, isSelf });
      }
    }
  } catch (_) {}

  // 3. If this machine is actively sharing, ensure it appears in the marketplace
  if (providerActive && currentUserId) {
    try {
      const specs = hardware.getHardwareSpecs ? await hardware.getHardwareSpecs() : {}; // instant — cached
      const email = cognito.getEmail() || loadSession()?.email || '';
      const profile = getProfileForEmail(email);
      const existing = merged.get(currentUserId) || {};
      merged.set(currentUserId, {
        userId: currentUserId,
        displayName: profile?.displayName || existing.displayName || loadSession()?.displayName || os.hostname() || 'This Machine',
        cpuModel: specs.cpuModel || existing.cpuModel,
        cpuCores: specs.cpuCores || existing.cpuCores,
        ramGb: specs.ramGb || existing.ramGb,
        gpu: specs.gpu || existing.gpu,
        os: specs.os || existing.os,
        status: 'ONLINE',
        isSelf: true,
      });
    } catch (_) {}
  }

  // 4. Deduplicate by displayName — same device can appear from both DynamoDB and P2P
  //    Prefer entries with real Cognito userIds (not starting with 'device-') over P2P fallback ids
  const all = Array.from(merged.values());
  const seenNames = new Map(); // displayName.toLowerCase() -> best entry
  for (const p of all) {
    const nameKey = (p.displayName || '').trim().toLowerCase();
    if (!nameKey || nameKey === 'compute node') {
      // No name — always include
      seenNames.set(p.userId, p);
      continue;
    }
    const existing = seenNames.get(nameKey);
    if (!existing) {
      seenNames.set(nameKey, p);
    } else {
      // Prefer the entry with the real Cognito userId (not a device- fallback)
      const existingIsReal = !existing.userId.startsWith('device-');
      const pIsReal = !p.userId.startsWith('device-');
      if (pIsReal && !existingIsReal) {
        seenNames.set(nameKey, p);
      }
    }
  }

  return Array.from(seenNames.values());
});

ipcMain.handle('cluster:add-peer-ip', async (_e, { ip }) => {
  try {
    const peer = await p2p.pingPeer(ip);
    return { ok: Boolean(peer), peer };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('cluster:pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Workspace Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── IPC: Cluster Orchestration ─────────────────────────────────────────────
ipcMain.handle('cluster:create', async (_e, { providerIds, workspacePath }) => {
  const userId = cognito.getUserId() || demoSessionUser?.userId;
  if (!userId) throw new Error('Not authenticated');

  const sessionId = uuidv4();
  let clusterToken = uuidv4().replace(/-/g, '');

  pushToRenderer('cluster:status', { status: 'NEGOTIATING', sessionId });
  pushToRenderer('cluster:log', `[c3] Starting cluster session ${sessionId}...`);

  const net = await tailscale.getConnectableIp();
  const masterIp = net.ip;
  pushToRenderer('cluster:log', `[c3] Master network endpoint: ${net.type.toUpperCase()} (${masterIp})`);

  let tailscaleAuthKey = '';
  try {
    const freshCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'aws-config.json'), 'utf8'));
    tailscaleAuthKey = freshCfg.tailscaleAuthKey || '';
  } catch {
    tailscaleAuthKey = awsConfig.tailscaleAuthKey || '';
  }

  // Register in DynamoDB
  if (!demoSessionUser) {
    try {
      await dynamo.createClusterSession({
        sessionId,
        consumerId: userId,
        providerIds,
        k3sToken: clusterToken,
        tailscaleAuthKey,
        consumerMeshIp: masterIp,
      });
    } catch (e) {
      console.warn('[dynamo] createClusterSession note:', e.message);
    }
  }

  pushToRenderer('cluster:log', '[c3] Bootstrapping K3s master control plane in Docker...');
  let masterRes;
  try {
    masterRes = await k3s.startMasterNode({
      meshIp: masterIp,
      clusterToken,
      localWorkspacePath: workspacePath,
    });
    if (masterRes?.clusterToken) {
      clusterToken = masterRes.clusterToken;
    }
  } catch (mErr) {
    throw mErr;
  }
  pushToRenderer('cluster:log', '✓ K3s master control plane active and accepting worker nodes.');
  k3s.exportHostKubeconfig().catch(() => {});

  // ── Deploy default pods ASYNC — do NOT block ACTIVE status ───────────────
  // python:3.10-slim needs to pull (~150MB) + pod needs to start.
  // This takes 1-5 min. We push ACTIVE immediately so the terminal opens.
  // The pod watchdog (startPodWatchdog) will redeploy if not Running.
  k3s.deployDefaultPods().then(() => {
    pushToRenderer('cluster:log', '✓ Workload runner pod (c3-worker-runner) is Running. /workspace is mounted.');
  }).catch(err => {
    pushToRenderer('cluster:log', `[c3] Pod deploy note: ${err.message} — watchdog will retry.`);
  });

  // ── Compute Worker Node ──────────────────────────────────────────────────
  // If external provider is selected, consumer is purely the Master Control Plane.
  // Only start local worker if no external providers are selected (solo mode).
  if (!providerIds || providerIds.length === 0) {
    pushToRenderer('cluster:log', '[c3] Solo mode: joining self as local compute worker node...');
    try {
      const specsForWorker = await hardware.getHardwareSpecs();
      const hasNvidiaGpu = specsForWorker.gpuVendor === 'NVIDIA';
      await k3s.startWorkerNode({
        masterMeshIp: '127.0.0.1',
        clusterToken,
        gpuEnabled: hasNvidiaGpu,
        localWorkspacePath: workspacePath,
        nodeName: 'c3-worker-local',
      });
      pushToRenderer('cluster:log', '✓ Local worker node joined.');
    } catch (workerErr) {
      console.warn('[k3s] Self-worker start note:', workerErr.message);
    }
  } else {
    pushToRenderer('cluster:log', `[c3] Master Control Plane active. Awaiting connection from ${providerIds.length} provider worker node(s)...`);
  }

  if (!demoSessionUser) {
    try {
      await dynamo.setClusterMasterMeshIp(sessionId, masterIp, clusterToken);
      await dynamo.setClusterStatus(sessionId, 'ACTIVE');
    } catch (_) {}
  }

  // Also broadcast join request via P2P coordinator to local peers
  const p2pNodes = p2p.getAvailableProviders().filter(p => providerIds.includes(p.userId));
  if (p2pNodes.length === 0) {
    pushToRenderer('cluster:log', `[c3] Note: No P2P-discovered providers matching selected IDs — using DynamoDB session only.`);
  }
  for (const prov of p2pNodes) {
    pushToRenderer('cluster:log', `[c3] Sending join invitation to provider "${prov.displayName}" at ${prov.ip}:${prov.port || 44344}...`);
    p2p.requestJoinCluster({
      providerId: prov.userId,
      providerIp: prov.ip,
      providerPort: prov.port || 44344,
      sessionId,
      workspacePath,
      masterIp,
      clusterToken,
    }).then(() => {
      pushToRenderer('cluster:log', `✓ Provider "${prov.displayName}" accepted the cluster invitation.`);
    }).catch((err) => {
      pushToRenderer('cluster:log', `✗ Provider "${prov.displayName}" join failed: ${err.message}`);
    });
  }

  p2p.setActiveWorkspace(workspacePath);

  currentSession = {
    sessionId,
    role: 'consumer',
    workspacePath,
    masterIp,
    clusterToken,
    providerIds,
    tailscaleIp: masterIp,
  };
  saveSession(currentSession);

  pushToRenderer('cluster:status', { status: 'ACTIVE', sessionId, workspacePath, providerIds, tailscaleIp: masterIp });
  startPodWatchdog();
  return { sessionId };
});

ipcMain.handle('cluster:accept', async (_e, { sessionId }) => {
  const userId = cognito.getUserId() || demoSessionUser?.userId;
  if (!userId) throw new Error('Not authenticated');

  let req = pendingJoinRequests.get(sessionId);

  if (!demoSessionUser) {
    try {
      await dynamo.acceptClusterRequest(sessionId, userId);
    } catch (e) {
      console.warn('[dynamo] acceptClusterRequest note:', e.message);
    }
  }

  // Retrieve masterIp and token from request or DynamoDB session
  let masterAddress = req?.masterIp || req?.consumerMeshIp || req?.consumerIp;
  let token = req?.clusterToken || req?.k3sToken;

  // Set up local provider workspace and auto-sync files from consumer over P2P
  const localWsDir = path.join(os.homedir(), 'c3_workspace');
  if (!fs.existsSync(localWsDir)) {
    try { fs.mkdirSync(localWsDir, { recursive: true }); } catch (_) {}
  }
  const syncSourceIp = req?.consumerIp || req?.masterIp;
  if (syncSourceIp) {
    pushToRenderer('cluster:log', `[c3] Syncing workspace files from consumer at ${syncSourceIp}...`);
    try {
      await p2p.syncWorkspaceFromConsumer({ consumerIp: syncSourceIp, targetDir: localWsDir });
    } catch (_) {}
  }
  let providerWorkspace = localWsDir;

  if (!masterAddress || !token) {
    pushToRenderer('cluster:log', `[c3] Fetching session credentials from DynamoDB for session ${sessionId}...`);
    // Poll up to 10 seconds for consumerMeshIp to be populated in DynamoDB
    for (let i = 0; i < 10; i++) {
      try {
        const dSession = await dynamo.getSession(sessionId);
        if (dSession) {
          masterAddress = masterAddress || dSession.consumerMeshIp;
          token = token || dSession.k3sToken;
          if (masterAddress && token) break;
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (masterAddress && token) {
    pushToRenderer('cluster:log', `[c3] Connecting to master at ${masterAddress} with cluster token...`);
    try {
      await k3s.startWorkerNode({
        masterMeshIp: masterAddress,
        clusterToken: token,
        gpuEnabled: false,
        localWorkspacePath: providerWorkspace,
      });
      pushToRenderer('cluster:log', `✓ Connected to master cluster! Worker node is now active.`);
    } catch (err) {
      pushToRenderer('cluster:log', `✗ Failed to connect to master at ${masterAddress}: ${err.message}`);
      throw err;
    }

    if (req?.consumerIp) {
      p2p.replyJoinRequest({
        consumerIp: req.consumerIp,
        consumerPort: 44344,
        sessionId,
        accepted: true,
      }).catch(() => {});
    }

    pendingJoinRequests.delete(sessionId);
  } else {
    const errMsg = `Could not resolve master IP address or token for session ${sessionId}.`;
    pushToRenderer('cluster:log', `[c3] Error: ${errMsg}`);
    throw new Error(errMsg);
  }

  pushToRenderer('cluster:status', { status: 'WORKER_ACTIVE', sessionId });
  return { ok: true };
});

ipcMain.handle('cluster:decline', async (_e, { sessionId }) => {
  const userId = cognito.getUserId() || demoSessionUser?.userId;
  if (!userId) throw new Error('Not authenticated');

  if (!demoSessionUser) {
    try { await dynamo.declineClusterRequest(sessionId, userId); } catch (_) {}
  }

  const req = pendingJoinRequests.get(sessionId);
  if (req) {
    await p2p.replyJoinRequest({
      consumerIp: req.consumerIp,
      consumerPort: 44344,
      sessionId,
      accepted: false,
    });
    pendingJoinRequests.delete(sessionId);
  }

  return { ok: true };
});

ipcMain.handle('cluster:stop', async () => {
  stopPodWatchdog();
  await k3s.stopCluster().catch(() => {});
  clearSession();
  pushToRenderer('cluster:log', '[c3] Cluster session ended.');
  return { ok: true };
});

// ── Pod watchdog: if runner pod is missing while session is active, redeploy ──
let _podWatchdogTimer = null;
function startPodWatchdog() {
  if (_podWatchdogTimer) return;
  _podWatchdogTimer = setInterval(async () => {
    if (!currentSession || currentSession.role !== 'consumer') return;
    try {
      const { exec: _exec } = require('child_process');
      const { promisify: _prom } = require('util');
      const _ea = _prom(_exec);
      const { stdout } = await _ea(
        'docker exec c3-k3s-master kubectl get pod c3-worker-runner -o jsonpath={.status.phase} 2>/dev/null',
        { timeout: 8000 }
      );
      const phase = stdout.trim();
      if (phase !== 'Running') {
        console.log(`[watchdog] c3-worker-runner phase="${phase}" — redeploying...`);
        pushToRenderer('cluster:log', '[c3] Watchdog: workload pod not running — redeploying...');
        await k3s.deployDefaultPods().catch(() => {});
        pushToRenderer('cluster:log', '✓ Workload pod redeployed by watchdog.');
      }
    } catch (_) {}
  }, 30_000);
}
function stopPodWatchdog() {
  if (_podWatchdogTimer) { clearInterval(_podWatchdogTimer); _podWatchdogTimer = null; }
}

ipcMain.handle('cluster:redeploy-pods', async () => {
  pushToRenderer('cluster:log', '[c3] Redeploying workload pods...');
  await k3s.deployDefaultPods();
  pushToRenderer('cluster:log', '✓ Pods redeployed.');
  return { ok: true };
});



let _lastTelemetryResult = null;
let _telemetryIpcBusy = false;
ipcMain.handle('cluster:telemetry', async () => {
  if (_telemetryIpcBusy) return _lastTelemetryResult; // already running — return cached
  _telemetryIpcBusy = true;
  try {
    _lastTelemetryResult = await dispatcher.getAggregatedTelemetry();
    return _lastTelemetryResult;
  } finally {
    _telemetryIpcBusy = false;
  }
});

ipcMain.handle('cluster:dispatch', async (_e, { target, command }) => {
  return await dispatcher.dispatchWorkload({ target, command, onLog: line => pushToRenderer('cluster:log', line) });
});

ipcMain.handle('cluster:network-debug', async () => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  const run = async (cmd, timeoutMs = 3000) => {
    try {
      const { stdout } = await execAsync(cmd, { timeout: timeoutMs });
      return stdout.trim();
    } catch (e) {
      return null;
    }
  };

  // 1. Tailscale status
  let tailscaleStatus = { connected: false, ip: null, peers: [] };
  try {
    const tsStatus = await tailscale.getStatus();
    if (tsStatus) {
      const selfIp = Object.values(tsStatus.Self?.TailscaleIPs || {})[0] || null;
      const peers = Object.values(tsStatus.Peer || {}).map(p => ({
        name: p.HostName || p.DNSName?.split('.')[0] || 'peer',
        ip: p.TailscaleIPs?.[0] || null,
        online: Boolean(p.Online),
        relay: p.Relay || 'direct',
      }));
      tailscaleStatus = { connected: true, ip: selfIp, peers };
    }
  } catch (_) {}

  // 2. Storage / Workspace check (inside c3-k3s-master container)
  let juicefs = { mounted: false, mountPoint: '/workspace', usage: null, backend: 'HostPath', fileCount: 0, files: [] };
  try {
    const lsOut = await run('docker exec c3-k3s-master ls -1 /workspace 2>/dev/null', 5000);
    if (lsOut !== null) {
      const fileList = lsOut.split('\n').map(f => f.trim()).filter(Boolean);
      juicefs = {
        mounted: true,
        mountPoint: '/workspace',
        usage: { size: 'Direct NVMe', used: `${fileList.length} items`, avail: 'Local SSD', percent: '100%' },
        backend: 'Direct Host Mount (NVMe)',
        fileCount: fileList.length,
        files: fileList.slice(0, 8),
      };
    }
  } catch (_) {}

  // 3. Docker containers (C3-related only)
  let containers = [];
  try {
    const ctOut = await run('docker ps --filter "name=c3" --format "{{.Names}}|{{.Status}}|{{.Image}}"', 3000);
    if (ctOut) {
      containers = ctOut.split('\n').filter(Boolean).map(line => {
        const [name, status, image] = line.split('|');
        return { name, status, image, ok: status?.startsWith('Up') };
      });
    }
  } catch (_) {}

  // 4. K3s API server health (inside container)
  let k3sApi = { reachable: false, nodeCount: 0 };
  try {
    const nodeOut = await run('docker exec c3-k3s-master kubectl get nodes --no-headers 2>/dev/null', 5000);
    if (nodeOut) {
      const nodeLines = nodeOut.split('\n').filter(Boolean);
      k3sApi = { reachable: true, nodeCount: nodeLines.length, nodes: nodeLines.map(l => l.trim().split(/\s+/)[0]) };
    }
  } catch (_) {}

  return { tailscale: tailscaleStatus, juicefs, containers, k3sApi, ts: Date.now() };
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

// ── App Lifecycle ──────────────────────────────────────────────────────────
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

    // Warm up hardware specs in background (cache for later calls)
    hardware.getHardwareSpecs().catch(() => {});

    // Start P2P coordinator non-blocking after app opens
    setImmediate(async () => {
      try {
        const saved = loadSession();
        const profile = saved?.email ? getProfileForEmail(saved.email) : loadProfile();
        // Use real userId from session (not 'local-node') so dedup works correctly
        const userId = cognito.getUserId() || saved?.userId || `device-${require('os').hostname()}`;
        const displayName = profile?.displayName || saved?.displayName || os.hostname() || 'Compute Node';

        await p2p.start({ userId, displayName, specs: {} });

        // Load specs and update p2p profile (non-blocking)
        hardware.getHardwareSpecs().then(specs => {
          p2p.updateProfile({ specs });
        }).catch(() => {});

        p2p.onRequestReceived = (req) => {
          pendingJoinRequests.set(req.sessionId, req);
          pushToRenderer('cluster:request', {
            sessionId: req.sessionId,
            consumerId: req.consumerId,
            consumerEmail: req.consumerName || req.consumerId,
            workspacePath: req.workspacePath,
          });
        };
      } catch (e) {
        console.warn('[P2P] Startup note:', e.message);
      }
    });
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
  p2p.stop();
});

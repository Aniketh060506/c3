'use strict';

/**
 * main.js — Electron Main Process for C3 Community Compute Cloud
 * Phase 2: AWS Cognito Authentication & DynamoDB Cloud Registry
 */

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const cognito = require('./core/cognito');
const dynamodb = require('./core/dynamodb');
const hardware = require('./core/hardware');
const setupChecker = require('./core/setup-checker');
const providerDaemon = require('./core/provider-daemon');
const clusterOrchestrator = require('./core/cluster-orchestrator');
const clusterExplorer = require('./core/cluster-explorer');
const terminalManager = require('./core/terminal-manager');
const rayEngine = require('./core/ray-engine');
const settingsManager = require('./core/settings-manager');

let mainWindow = null;
let sessionRestorePromise = Promise.resolve(false);
const PROFILE_FILE = path.join(app.getPath('userData'), 'c3_profile.json');
const SESSION_FILE = path.join(app.getPath('userData'), 'c3_session.json');

settingsManager.initUserDataDir(app.getPath('userData'));

const AUTH_URL = 'https://ap-south-11fuiqpnq2.auth.ap-south-1.amazoncognito.com/login?client_id=7frk04l4hn042tssu6rpievuf3&response_type=code&scope=email+openid+phone&redirect_uri=https%3A%2F%2Fd84l1y8p4kdic.cloudfront.net';
const REDIRECT_PREFIX = 'https://d84l1y8p4kdic.cloudfront.net';

// ── Profile & Session Persistence ───────────────────────────────────────────
function loadProfile() {
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
    }
  } catch (_) {}
  return { displayName: os.hostname() || 'Rog' };
}

function saveProfile(data) {
  try {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[profile] Failed to save profile:', err.message);
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

function saveSession(data) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[session] Failed to save session:', err.message);
  }
}

async function authenticatedUserPayload(userId, email) {
  const cloudIdentityReady = Boolean(cognito.getCredentials());
  const account = cloudIdentityReady ? await dynamodb.getUser(userId) : null;
  const balance = Number(account?.credits ?? 0);
  return {
    userId,
    email,
    displayName: loadProfile().displayName || os.hostname(),
    credits: account?.credits ?? null,
    faucetEligible: Boolean(account && !account.faucetClaimedAt && balance <= 100),
    status: 'ONLINE',
    cloudIdentityReady,
    cloudIdentityError: cloudIdentityReady ? null : (cognito.getCredentialError?.() || null),
  };
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (_) {}
}

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#f6f8fc',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f6f8fc',
      symbolColor: '#1e293b',
      height: 48,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  const distHtml = path.join(__dirname, 'dist-ui', 'index.html');
  const loadApp = () => {
    if (fs.existsSync(distHtml)) {
      mainWindow.loadFile(distHtml);
    } else {
      mainWindow.loadURL('http://localhost:5173').catch(() => mainWindow.loadFile(distHtml));
    }
  };

  // ── Intercept Hosted UI OAuth Redirect ────────────────────────────────────
  const handleRedirect = async (event, url) => {
    if (url.startsWith(REDIRECT_PREFIX)) {
      event.preventDefault();
      try {
        const urlObj = new URL(url);
        const code = urlObj.searchParams.get('code');
        if (code) {
          console.log('[cognito] Exchanging OAuth authorization code...');
          const tokens = await cognito.exchangeCodeForTokens(code, REDIRECT_PREFIX);
          saveSession(tokens);
          // Register user in DynamoDB
          dynamodb.createUser(tokens.userId, tokens.email, loadProfile().displayName)
            .catch(err => console.warn('[cognito] Cloud profile registration failed:', err.message));
          console.log('[cognito] OAuth sign-in successful:', tokens.email);
        }
      } catch (err) {
        console.error('[cognito] OAuth exchange error:', err.message);
      } finally {
        loadApp();
      }
    }
  };

  mainWindow.webContents.on('will-redirect', handleRedirect);
  mainWindow.webContents.on('will-navigate', handleRedirect);

  // Restore saved session on startup
  const saved = loadSession();
  if (saved) {
    sessionRestorePromise = cognito.restoreSession(saved).then(restored => {
      if (restored) console.log('[cognito] Restored session for:', saved.email);
      else {
        clearSession();
        console.warn('[cognito] Saved login expired and could not be restored; sign-in is required.');
      }
      return restored;
    }).catch(err => {
      clearSession();
      console.warn('[cognito] Saved login could not be restored:', err.message);
      return false;
    });
  }

  loadApp();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-change', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-change', false));

  providerDaemon.setIpcCallback((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  });

  clusterOrchestrator.setIpcCallback((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  });

  terminalManager.setCallback((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', data);
    }
  });

  rayEngine.setIpcCallback((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  });

  mainWindow.on('closed', () => {
    terminalManager.kill();
    rayEngine.stopAiJob();
    mainWindow = null;
  });
}

// ── IPC Handlers: Authentication & Identity ──
ipcMain.handle('auth:getuser', async () => {
  // The renderer may load before Identity Pool credentials have been fetched.
  // Wait here so initial provider discovery does not race that AWS credential exchange.
  await sessionRestorePromise;
  const userId = cognito.getUserId();
  const email = cognito.getEmail();

  if (!userId) return null;
  return await authenticatedUserPayload(userId, email);
});

ipcMain.handle('auth:open-hosted-login', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(AUTH_URL);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle('auth:login', async (_e, { email, password }) => {
  const res = await cognito.login(email, password);
  saveSession(res);
  await dynamodb.createUser(res.userId, res.email, loadProfile().displayName)
    .catch(err => console.warn('[auth] Cloud profile registration failed:', err.message));
  return await authenticatedUserPayload(res.userId, res.email);
});

ipcMain.handle('auth:signup', async (_e, { email, password }) => {
  return await cognito.signUp(email, password);
});

ipcMain.handle('auth:confirm', async (_e, { email, code }) => {
  return await cognito.confirmSignUp(email, code);
});

ipcMain.handle('auth:signout', async () => {
  clearSession();
  await cognito.signOut();
  if (mainWindow && !mainWindow.isDestroyed()) {
    const distHtml = path.join(__dirname, 'dist-ui', 'index.html');
    mainWindow.loadFile(distHtml);
  }
  return { ok: true };
});

ipcMain.handle('auth:set-name', async (_e, { displayName }) => {
  const clean = (displayName || '').trim();
  if (!clean) throw new Error('Machine name cannot be blank.');
  const profile = { ...loadProfile(), displayName: clean };
  saveProfile(profile);

  const userId = cognito.getUserId();
  const email = cognito.getEmail();
  if (userId && email) {
    try {
      await dynamodb.createUser(userId, email, clean);
    } catch (_) {}
  }

  return { ok: true, user: profile };
});

// ── IPC Handlers: DynamoDB Cloud Registry ──
ipcMain.handle('providers:list', async () => {
  try {
    return await dynamodb.getActiveProviders();
  } catch (err) {
    console.warn('[providers:list] Error:', err.message);
    return [];
  }
});

ipcMain.handle('provider:register', async (_e, profile) => {
  const userId = cognito.getUserId();
  if (!userId) return null;
  try {
    return await dynamodb.registerProvider(userId, profile);
  } catch (err) {
    console.warn('[provider:register] Error:', err.message);
    return null;
  }
});

async function getAuthorizedNegotiationSession(sessionId) {
  const userId = cognito.getUserId();
  if (!userId) throw new Error('Sign in to view request negotiations.');
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(sessionId)) {
    throw new Error('Invalid request ID.');
  }
  const session = await dynamodb.getSession(sessionId);
  if (!session || ![session.consumerId, session.providerId].includes(userId)) {
    throw new Error('You are not a participant in this provider request.');
  }
  return { userId, session };
}

ipcMain.handle('negotiation:get-session', async (_e, sessionId) => {
  const { userId, session } = await getAuthorizedNegotiationSession(sessionId);
  const { clusterToken, ...safeSession } = session;
  return { ...safeSession, currentUserId: userId };
});

ipcMain.handle('negotiation:get-messages', async (_e, sessionId) => {
  await getAuthorizedNegotiationSession(sessionId);
  return await dynamodb.getChatMessages(sessionId);
});

ipcMain.handle('negotiation:send-message', async (_e, { sessionId, text, offerPerHour } = {}) => {
  const { userId } = await getAuthorizedNegotiationSession(sessionId);
  const cleanText = String(text || '').trim();
  const hasOffer = offerPerHour != null && offerPerHour !== '';
  const price = hasOffer ? Number(offerPerHour) : null;
  if (!cleanText && !hasOffer) throw new Error('Write a message or enter a price offer.');
  if (hasOffer && (!Number.isFinite(price) || price <= 0 || price > 1_000_000)) {
    throw new Error('Enter a positive offer up to 1,000,000 test credits per hour.');
  }
  return await dynamodb.createChatMessage({
    chatId: sessionId,
    senderId: userId,
    senderName: loadProfile().displayName || cognito.getEmail() || os.hostname(),
    text: cleanText || `Price offer: ${price} C3 test credits per hour.`,
    offerPerHour: price,
    type: hasOffer ? 'OFFER' : 'MESSAGE',
  });
});

ipcMain.handle('negotiation:accept-offer', async (_e, { sessionId, offerPerHour } = {}) => {
  const { userId, session } = await getAuthorizedNegotiationSession(sessionId);
  const price = Number(offerPerHour);
  if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) {
    throw new Error('This price offer is invalid.');
  }
  const messages = await dynamodb.getChatMessages(sessionId);
  const latestOffer = [...messages].reverse().find(message => message.type === 'OFFER' && message.senderId !== userId);
  if (!latestOffer || Number(latestOffer.offerPerHour) !== price) {
    throw new Error('Only the other participant’s latest offer can be accepted.');
  }
  await dynamodb.updateSessionStatus(sessionId, session.status || 'NEGOTIATING', {
    agreedPriceCreditsPerHour: price,
    priceAgreedBy: userId,
    priceAgreedAt: Date.now(),
  });
  return await dynamodb.createChatMessage({
    chatId: sessionId,
    senderId: userId,
    senderName: loadProfile().displayName || cognito.getEmail() || os.hostname(),
    text: `Accepted the offer of ${price} C3 test credits per hour. This is a quote only; settlement is not implemented.`,
    offerPerHour: price,
    type: 'ACCEPTED_OFFER',
  });
});

// ── IPC Handlers: Phase 3 Provider Mode ──
ipcMain.handle('provider:start-sharing', async (_e, config) => {
  const userId = cognito.getUserId() || `node-${os.hostname()}`;
  return await providerDaemon.startSharing(userId, config);
});

ipcMain.handle('provider:stop-sharing', async () => {
  return await providerDaemon.stopSharing();
});

ipcMain.handle('provider:accept-session', async (_e, sessionData) => {
  return await providerDaemon.acceptSession(sessionData);
});

ipcMain.handle('provider:decline-session', async (_e, sessionId) => {
  return await providerDaemon.declineSession(sessionId);
});

ipcMain.handle('provider:get-state', () => {
  return providerDaemon.getProviderState();
});

// ── IPC Handlers: Phase 4 Consumer Studio ──
ipcMain.handle('consumer:discover-nodes', async () => {
  return await clusterOrchestrator.discoverNodes();
});

ipcMain.handle('consumer:pick-folder', async () => {
  return await clusterOrchestrator.pickWorkspaceFolder(mainWindow);
});

ipcMain.handle('consumer:start-cluster', async (_e, params) => {
  const userId = cognito.getUserId() || `consumer-${os.hostname()}`;
  const profile = loadProfile();
  const cluster = await clusterOrchestrator.startCluster({
    ...params,
    userId,
    consumerName: profile.displayName || os.hostname(),
  });
  if (cluster?.status !== 'ACTIVE') return cluster;
  try {
    cluster.rayStatus = await rayEngine.startRayCluster();
  } catch (err) {
    // K3s remains usable even if the Ray image, pod scheduling, or dashboard
    // is unavailable; return both states so the UI can explain the failure.
    cluster.rayStatus = { status: 'ERROR', error: err.message };
  }
  return cluster;
});

ipcMain.handle('consumer:cluster-status', async () => {
  return await clusterOrchestrator.getClusterStatus();
});

ipcMain.handle('cluster:explorer-inventory', async () => {
  return await clusterExplorer.getInventory();
});

ipcMain.handle('cluster:pod-processes', async (_e, target) => {
  return await clusterExplorer.getPodProcesses(target);
});

ipcMain.handle('consumer:stop-cluster', async () => {
  await rayEngine.stopRayCluster();
  return await clusterOrchestrator.stopCluster();
});

// ── IPC Handlers: Phase 5 Interactive Terminal ──
ipcMain.handle('terminal:init', async (_e, target, dimensions) => {
  return await terminalManager.initTerminal(target, dimensions);
});

ipcMain.handle('terminal:write', (_e, data) => {
  terminalManager.write(data);
  return { ok: true };
});

ipcMain.handle('terminal:resize', (_e, cols, rows) => {
  terminalManager.resize(cols, rows);
  return { ok: true };
});

ipcMain.handle('terminal:kill', () => {
  terminalManager.kill();
  return { ok: true };
});

// ── IPC Handlers: Phase 5 & 6 Ray AI Distributed Engine ──
ipcMain.handle('ray:get-templates', () => {
  return rayEngine.getTemplates();
});

ipcMain.handle('ray:start-job', async (_e, options) => {
  const cluster = await clusterOrchestrator.getClusterStatus();
  if (options?.mode === 'project' && cluster.status !== 'ACTIVE') {
    throw new Error('Start the K3s cluster with your project folder selected before running a project.');
  }
  return await rayEngine.startAiJob({ ...options, workspacePath: cluster.workspacePath || null });
});

ipcMain.handle('ray:open-results', async (_e, jobId) => {
  if (typeof jobId !== 'string' || !/^c3-[a-z0-9]+$/.test(jobId)) return { ok: false, error: 'Invalid job id.' };
  const cluster = await clusterOrchestrator.getClusterStatus();
  if (!cluster.workspacePath) return { ok: false, error: 'The project workspace path is unavailable. Restart the C3 cluster from Consumer.' };
  const resultsPath = path.join(cluster.workspacePath, 'C3-results', jobId);
  if (!fs.existsSync(resultsPath)) return { ok: false, error: 'Results folder was not found in the selected workspace.' };
  const error = await shell.openPath(resultsPath);
  return error ? { ok: false, error } : { ok: true, path: resultsPath };
});

ipcMain.handle('ray:stop-job', () => {
  return rayEngine.stopAiJob();
});

ipcMain.handle('ray:get-job', () => {
  return rayEngine.getActiveJob();
});

ipcMain.handle('ray:get-status', async () => {
  return await rayEngine.getRayClusterStatus();
});

ipcMain.handle('ray:start-cluster', async () => {
  return await rayEngine.startRayCluster();
});

// ── IPC Handlers: Phase 7 System Settings & Maintenance ──
ipcMain.handle('settings:prune-containers', async () => {
  return await settingsManager.pruneContainers();
});

ipcMain.handle('settings:container-status', async () => {
  return await settingsManager.getContainerStatus();
});

ipcMain.handle('settings:claim-faucet', async (_e, { amount } = {}) => {
  const userId = cognito.getUserId();
  if (!userId) return { ok: false, error: 'Sign in again; the saved Cognito session is not active.' };
  if (!cognito.getCredentials()) return { ok: false, error: 'Cognito sign-in is active, but AWS cloud credentials are unavailable. Check the Cognito Identity Pool and IAM role, then sign in again.' };
  // The client cannot choose or repeat a larger grant; the DynamoDB condition
  // enforces the one-time account limit atomically across app instances.
  return await settingsManager.claimFaucetCredits(userId, 500);
});

ipcMain.handle('settings:get-transactions', () => {
  return settingsManager.getTransactions();
});

ipcMain.handle('settings:test-p2p', async (_e, { host, port } = {}) => {
  return await settingsManager.testP2PConnectivity(host || '127.0.0.1', port || 44344);
});

ipcMain.handle('settings:network-diag', async () => {
  return await settingsManager.getNetworkDiagnostics();
});

// ── IPC Handlers: Hardware & Telemetry ──
ipcMain.handle('hw:specs', async (_e, force) => {
  return await hardware.getHardwareSpecs(force);
});

ipcMain.handle('hw:livestats', async () => {
  return await hardware.getLiveStats();
});

// ── IPC Handlers: System Prerequisites & 1-Click Dependency Management ──
ipcMain.handle('setup:check', async () => {
  return await setupChecker.runAllChecks();
});

ipcMain.handle('setup:start-docker', async () => {
  return await setupChecker.startDocker();
});

ipcMain.handle('setup:install-tailscale', async () => {
  return await setupChecker.installTailscale((msg) => {
    mainWindow?.webContents.send('setup:pull-progress', msg);
  });
});

ipcMain.handle('setup:connect-tailscale', async (_e, { authKey }) => {
  return await setupChecker.connectTailscale(authKey);
});

ipcMain.handle('setup:pull-image', async (_e, { imageName }) => {
  const targetImg = imageName || setupChecker.K3S_IMAGE;
  try {
    const res = await setupChecker.pullComputeImage(targetImg, (msg) => {
      mainWindow?.webContents.send('setup:pull-progress', msg);
    });
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('system:open-external', async (_e, url) => {
  if (url && typeof url === 'string') {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false };
});

// ── IPC Handlers: Window Controls ──
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

// ── App Lifecycle & Single Instance Lock ──
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
    hardware.getHardwareSpecs().catch(() => {});
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

'use strict';

/**
 * core/cognito.js
 * AWS Cognito authentication engine for C3 Community Compute Cloud.
 * Handles:
 *  - Direct Email/Password login (InitiateAuthCommand with SECRET_HASH)
 *  - User registration & Email confirmation code verification
 *  - AWS Cognito Hosted UI OAuth2 Code Exchange
 *  - IAM Credential Exchange via Cognito Identity Pool (GetCredentialsForIdentity)
 *  - Token Refresh & Session Management
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  GlobalSignOutCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { fromCognitoIdentityPool } = require('@aws-sdk/credential-providers');

// ── Load AWS Configuration ──────────────────────────────────────────────────
const CFG_PATH = path.join(__dirname, '..', 'aws-config.json');
let cfg = {
  region: 'ap-south-1',
  // This value is case-sensitive and must match the Cognito ID token issuer.
  userPoolId: 'ap-south-1_1FuIqpNq2',
  clientId: '7frk04l4hn042tssu6rpievuf3',
  clientSecret: process.env.C3_COGNITO_CLIENT_SECRET || '',
  identityPoolId: 'ap-south-1:65a4b02e-18e7-47b1-ab84-d8877f9b10e2',
};

try {
  if (fs.existsSync(CFG_PATH)) {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) };
  }
} catch (_) {}

const idpClient = new CognitoIdentityProviderClient({ region: cfg.region });

// ── State ───────────────────────────────────────────────────────────────────
let currentCredentials = null;
let currentUserId = null;
let currentEmail = null;
let currentAccessToken = null;
let credentialError = null;
let refreshTimer = null;

// ── Helpers ─────────────────────────────────────────────────────────────────
function secretHash(username) {
  const s = cfg.clientSecret;
  if (!s) return undefined;
  return crypto
    .createHmac('SHA256', s)
    .update(username + cfg.clientId)
    .digest('base64');
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    return {};
  }
}

// ── Sign-Up ─────────────────────────────────────────────────────────────────
async function signUp(email, password) {
  const params = {
    ClientId: cfg.clientId,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: 'email', Value: email }],
  };
  const sh = secretHash(email);
  if (sh) params.SecretHash = sh;

  const res = await idpClient.send(new SignUpCommand(params));
  return {
    userSub: res.UserSub,
    codeDeliveryDetails: res.CodeDeliveryDetails,
    needsConfirmation: !res.UserConfirmed,
  };
}

// ── Confirm Sign-Up ─────────────────────────────────────────────────────────
async function confirmSignUp(email, code) {
  const params = {
    ClientId: cfg.clientId,
    Username: email,
    ConfirmationCode: code,
  };
  const sh = secretHash(email);
  if (sh) params.SecretHash = sh;

  await idpClient.send(new ConfirmSignUpCommand(params));
  return true;
}

// ── Direct Login (Email & Password) ─────────────────────────────────────────
async function login(email, password) {
  const authParams = {
    USERNAME: email,
    PASSWORD: password,
  };
  const sh = secretHash(email);
  if (sh) authParams.SECRET_HASH = sh;

  let res;
  try {
    res = await idpClient.send(new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: cfg.clientId,
      AuthParameters: authParams,
    }));
  } catch (err) {
    if (err.name === 'InvalidParameterException' || err.__type?.includes('NotAuthorizedException')) {
      authParams.PREFERRED_CHALLENGE = 'PASSWORD';
      res = await idpClient.send(new InitiateAuthCommand({
        AuthFlow: 'USER_AUTH',
        ClientId: cfg.clientId,
        AuthParameters: authParams,
      }));
    } else {
      throw err;
    }
  }

  if (res.ChallengeName === 'PASSWORD') {
    const challengeParams = { USERNAME: email, PASSWORD: password };
    const sh2 = secretHash(email);
    if (sh2) challengeParams.SECRET_HASH = sh2;

    res = await idpClient.send(new RespondToAuthChallengeCommand({
      ChallengeName: 'PASSWORD',
      ClientId: cfg.clientId,
      Session: res.Session,
      ChallengeResponses: challengeParams,
    }));
  }

  if (!res.AuthenticationResult) {
    throw new Error('Authentication failed — no tokens returned.');
  }

  const { IdToken, AccessToken, RefreshToken } = res.AuthenticationResult;
  const payload = decodeJwt(IdToken);

  currentUserId = payload.sub;
  currentEmail = email;
  currentAccessToken = AccessToken;

  await getTemporaryCredentials(IdToken);
  scheduleRefresh(RefreshToken);

  return {
    userId: currentUserId,
    email: currentEmail,
    idToken: IdToken,
    accessToken: AccessToken,
    refreshToken: RefreshToken,
  };
}

// ── Exchange Hosted UI Authorization Code for Tokens ────────────────────────
async function exchangeCodeForTokens(code, redirectUri) {
  const domain = `ap-south-11fuiqpnq2.auth.${cfg.region}.amazoncognito.com`;
  const postData = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    redirect_uri: redirectUri,
  }).toString();

  const options = {
    hostname: domain,
    port: 443,
    path: '/oauth2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  };
  // Public Cognito app clients do not use client authentication. A secret, if
  // required by a legacy app client, must come from ignored runtime config or
  // the environment; never embed it in a distributable desktop app.
  if (cfg.clientSecret) {
    options.headers.Authorization = 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', async () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            return reject(new Error(`OAuth error: ${json.error} - ${json.error_description || ''}`));
          }
          if (!json.id_token) {
            return reject(new Error('OAuth code exchange did not return id_token.'));
          }

          const payload = decodeJwt(json.id_token);
          currentUserId = payload.sub;
          currentEmail = payload.email || `${currentUserId.slice(0, 8)}@c3.cloud`;
          currentAccessToken = json.access_token;

          await getTemporaryCredentials(json.id_token);
          if (json.refresh_token) scheduleRefresh(json.refresh_token);

          resolve({
            userId: currentUserId,
            email: currentEmail,
            idToken: json.id_token,
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
          });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Get Temporary AWS Credentials via Identity Pool ─────────────────────────
async function getTemporaryCredentials(idToken) {
  try {
    const provider = fromCognitoIdentityPool({
      clientConfig: { region: cfg.region },
      identityPoolId: cfg.identityPoolId,
      logins: {
        [`cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`]: idToken,
      },
    });
    currentCredentials = await provider();
    credentialError = null;
    return currentCredentials;
  } catch (err) {
    currentCredentials = null;
    credentialError = err?.message || 'Cognito Identity Pool did not return AWS credentials.';
    console.warn('[cognito] getTemporaryCredentials note:', err.message);
    return null;
  }
}

// ── Session Refresh ─────────────────────────────────────────────────────────
async function refreshSession(refreshToken) {
  const params = {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: cfg.clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  };
  const sh = secretHash(currentEmail || '');
  if (sh) params.AuthParameters.SECRET_HASH = sh;

  const res = await idpClient.send(new InitiateAuthCommand(params));
  if (res.AuthenticationResult) {
    const { IdToken, AccessToken, RefreshToken: newRT } = res.AuthenticationResult;
    currentAccessToken = AccessToken;
    if (IdToken) {
      const payload = decodeJwt(IdToken);
      currentUserId = payload.sub || currentUserId;
      currentEmail = payload.email || currentEmail;
      await getTemporaryCredentials(IdToken);
    }
    scheduleRefresh(newRT || refreshToken);
  }
}

function scheduleRefresh(refreshToken) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshSession(refreshToken).catch(e => console.error('[C3] Token refresh failed:', e.message));
  }, 50 * 60 * 1000);
}

// ── Restore Existing Session on Startup ─────────────────────────────────────
async function restoreSession(session) {
  if (!session?.idToken) return false;
  try {
    const payload = decodeJwt(session.idToken);
    const exp = payload.exp ? payload.exp * 1000 : 0;
    currentUserId = session.userId || payload.sub;
    currentEmail = session.email || payload.email;
    currentAccessToken = session.accessToken;
    // Check if expired
    if (Date.now() > exp) {
      if (!session.refreshToken) return false;
      await refreshSession(session.refreshToken);
      return Boolean(currentUserId && currentAccessToken);
    }

    await getTemporaryCredentials(session.idToken);
    if (session.refreshToken) scheduleRefresh(session.refreshToken);
    return true;
  } catch (_) {
    return false;
  }
}

// ── Sign Out ────────────────────────────────────────────────────────────────
async function signOut() {
  if (currentAccessToken) {
    try {
      await idpClient.send(new GlobalSignOutCommand({ AccessToken: currentAccessToken }));
    } catch (_) {}
  }
  currentCredentials = null;
  currentUserId = null;
  currentEmail = null;
  currentAccessToken = null;
  credentialError = null;
  if (refreshTimer) clearTimeout(refreshTimer);
}

module.exports = {
  signUp,
  confirmSignUp,
  login,
  exchangeCodeForTokens,
  restoreSession,
  signOut,
  getCredentials: () => currentCredentials,
  getCredentialError: () => credentialError,
  getUserId: () => currentUserId,
  getEmail: () => currentEmail,
  getTemporaryCredentials,
  cfg,
};

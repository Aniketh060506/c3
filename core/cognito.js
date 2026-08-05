'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  GlobalSignOutCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { fromCognitoIdentityPool } = require('@aws-sdk/credential-providers');

// ── Config ────────────────────────────────────────────────────────────────────
const cfgPath = path.join(__dirname, '..', 'aws-config.json');
const cfg     = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const idpClient = new CognitoIdentityProviderClient({ region: cfg.region });

// ── Module state ──────────────────────────────────────────────────────────────
let currentCredentials = null;
let currentUserId      = null;
let currentEmail       = null;
let currentAccessToken = null;
let refreshTimer       = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function secretHash(username) {
  const s = cfg.clientSecret;
  if (!s || s.startsWith('PASTE_')) return undefined;
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

// ── Sign-Up ───────────────────────────────────────────────────────────────────
// Returns { userSub, codeDeliveryDetails }
// After this, user must confirm with the code sent to their email.
async function signUp(email, password) {
  const params = {
    ClientId:       cfg.clientId,
    Username:       email,
    Password:       password,
    UserAttributes: [{ Name: 'email', Value: email }],
  };
  const sh = secretHash(email);
  if (sh) params.SecretHash = sh;

  const res = await idpClient.send(new SignUpCommand(params));
  return {
    userSub:             res.UserSub,
    codeDeliveryDetails: res.CodeDeliveryDetails,
    needsConfirmation:   !res.UserConfirmed,
  };
}

// ── Confirm Sign-Up ───────────────────────────────────────────────────────────
async function confirmSignUp(email, code) {
  const params = {
    ClientId:         cfg.clientId,
    Username:         email,
    ConfirmationCode: code,
  };
  const sh = secretHash(email);
  if (sh) params.SecretHash = sh;

  await idpClient.send(new ConfirmSignUpCommand(params));
  return true;
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(email, password) {
  const authParams = {
    USERNAME: email,
    PASSWORD: password,
  };
  const sh = secretHash(email);
  if (sh) authParams.SECRET_HASH = sh;

  // Try USER_PASSWORD_AUTH first; fall back to USER_AUTH (choice-based)
  let res;
  try {
    res = await idpClient.send(new InitiateAuthCommand({
      AuthFlow:        'USER_PASSWORD_AUTH',
      ClientId:        cfg.clientId,
      AuthParameters:  authParams,
    }));
  } catch (err) {
    if (err.name === 'InvalidParameterException' || err.__type?.includes('NotAuthorizedException')) {
      // Fallback: USER_AUTH flow (Choice-based sign-in)
      authParams.PREFERRED_CHALLENGE = 'PASSWORD';
      res = await idpClient.send(new InitiateAuthCommand({
        AuthFlow:       'USER_AUTH',
        ClientId:       cfg.clientId,
        AuthParameters: authParams,
      }));
    } else {
      throw err;
    }
  }

  // Handle intermediate challenges (e.g. PASSWORD challenge in USER_AUTH flow)
  if (res.ChallengeName === 'PASSWORD') {
    const challengeParams = {
      USERNAME: email,
      PASSWORD: password,
    };
    const sh2 = secretHash(email);
    if (sh2) challengeParams.SECRET_HASH = sh2;

    res = await idpClient.send(new RespondToAuthChallengeCommand({
      ChallengeName:      'PASSWORD',
      ClientId:           cfg.clientId,
      Session:            res.Session,
      ChallengeResponses: challengeParams,
    }));
  }

  if (!res.AuthenticationResult) {
    throw new Error('Authentication failed — no tokens returned. Check Cognito app client auth flows.');
  }

  const { IdToken, AccessToken, RefreshToken } = res.AuthenticationResult;
  const payload = decodeJwt(IdToken);

  currentUserId      = payload.sub;
  currentEmail       = email;
  currentAccessToken = AccessToken;

  // Exchange ID token for temporary AWS credentials
  await getTemporaryCredentials(IdToken);

  // Schedule token refresh
  scheduleRefresh(RefreshToken);

  return {
    userId:       currentUserId,
    email:        currentEmail,
    idToken:      IdToken,
    accessToken:  AccessToken,
    refreshToken: RefreshToken,
  };
}

// ── Get Temporary AWS Credentials ─────────────────────────────────────────────
async function getTemporaryCredentials(idToken) {
  const provider = fromCognitoIdentityPool({
    clientConfig:    { region: cfg.region },
    identityPoolId:  cfg.identityPoolId,
    logins: {
      [`cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`]: idToken,
    },
  });
  currentCredentials = await provider();
  return currentCredentials;
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function refreshSession(refreshToken) {
  const params = {
    AuthFlow:       'REFRESH_TOKEN_AUTH',
    ClientId:       cfg.clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  };
  const sh = secretHash(currentEmail || '');
  if (sh) params.AuthParameters.SECRET_HASH = sh;

  const res = await idpClient.send(new InitiateAuthCommand(params));
  if (res.AuthenticationResult) {
    const { IdToken, AccessToken, RefreshToken: newRT } = res.AuthenticationResult;
    currentAccessToken = AccessToken;
    if (IdToken) await getTemporaryCredentials(IdToken);
    scheduleRefresh(newRT || refreshToken);
  }
}

function scheduleRefresh(refreshToken) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshSession(refreshToken).catch(e => console.error('[C3] Token refresh failed:', e));
  }, 50 * 60 * 1000); // 50 minutes
}

// ── Sign Out ──────────────────────────────────────────────────────────────────
async function signOut() {
  if (currentAccessToken) {
    try {
      await idpClient.send(new GlobalSignOutCommand({ AccessToken: currentAccessToken }));
    } catch (_) {}
  }
  currentCredentials = null;
  currentUserId      = null;
  currentEmail       = null;
  currentAccessToken = null;
  if (refreshTimer) clearTimeout(refreshTimer);
}

// ── Getters ───────────────────────────────────────────────────────────────────
function getCredentials() { return currentCredentials; }
function getUserId()      { return currentUserId; }
function getEmail()       { return currentEmail; }

module.exports = {
  signUp,
  confirmSignUp,
  login,
  signOut,
  getCredentials,
  getUserId,
  getEmail,
  getTemporaryCredentials,
};

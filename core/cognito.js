'use strict';

/**
 * core/cognito.js
 * AWS Cognito authentication module for C3.
 * Handles login, signup, confirmation, sign-out, and credential retrieval.
 * Uses HMAC-SHA256 SECRET_HASH for all Cognito USER_PASSWORD_AUTH flows.
 */

const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
  ConfirmSignUpCommand,
  GlobalSignOutCommand,
  GetUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} = require('@aws-sdk/client-cognito-identity');

let awsConfig;
try {
  awsConfig = require('../aws-config.json');
} catch {
  awsConfig = {
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_1FuIqpNq2',
    clientId: '7frk04l4hn042tssu6rpievuf3',
    clientSecret: 'gijgjmh3ig3kbtqrr26tqfr4g53gnigbpl1q1r6hnbdmef0rfrl',
    identityPoolId: 'ap-south-1:65a4b02e-18e7-47b1-ab84-d8877f9b10e2',
    tailscaleAuthKey: 'tskey-auth-kuxGWyFp7S11CNTRL-Mb8qcGZZXMTVErF3YUjjMTB61TSWNgLg',
  };
}

// ── In-memory token store ──────────────────────────────────────────────────
let _tokens = {
  idToken: null,
  accessToken: null,
  refreshToken: null,
  userId: null,
  email: null,
};

// ── Clients ────────────────────────────────────────────────────────────────
const cognitoIdpClient = new CognitoIdentityProviderClient({
  region: awsConfig.region,
});

const cognitoIdentityClient = new CognitoIdentityClient({
  region: awsConfig.region,
});

// ── Helpers ────────────────────────────────────────────────────────────────
/**
 * Computes the SECRET_HASH required by Cognito when a client secret is configured.
 * @param {string} username - The username (email) for the operation.
 * @returns {string} Base64-encoded HMAC-SHA256 hash.
 */
function computeSecretHash(username) {
  return crypto
    .createHmac('sha256', awsConfig.clientSecret)
    .update(username + awsConfig.clientId)
    .digest('base64');
}

/**
 * Extracts the Cognito sub (userId) from a decoded ID token payload.
 * @param {string} idToken - JWT ID token string.
 * @returns {string|null} The sub claim.
 */
function extractSubFromToken(idToken) {
  try {
    const payload = idToken.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return decoded.sub || null;
  } catch {
    return null;
  }
}

/**
 * Extracts the email claim from a decoded ID token payload.
 * @param {string} idToken - JWT ID token string.
 * @returns {string|null} The email claim.
 */
function extractEmailFromToken(idToken) {
  try {
    const payload = idToken.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return decoded.email || null;
  } catch {
    return null;
  }
}

// ── Auth operations ────────────────────────────────────────────────────────
/**
 * Signs a user in with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{userId: string, email: string}>}
 */
async function login(email, password) {
  const command = new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: awsConfig.clientId,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
      SECRET_HASH: computeSecretHash(email),
    },
  });

  const response = await cognitoIdpClient.send(command);
  const result = response.AuthenticationResult;

  if (!result) {
    throw new Error('Authentication failed: no result returned from Cognito.');
  }

  _tokens.idToken = result.IdToken;
  _tokens.accessToken = result.AccessToken;
  _tokens.refreshToken = result.RefreshToken;
  _tokens.userId = extractSubFromToken(result.IdToken);
  _tokens.email = extractEmailFromToken(result.IdToken);

  return { userId: _tokens.userId, email: _tokens.email };
}

/**
 * Registers a new user with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<void>}
 */
async function signUp(email, password) {
  const command = new SignUpCommand({
    ClientId: awsConfig.clientId,
    Username: email,
    Password: password,
    SecretHash: computeSecretHash(email),
    UserAttributes: [{ Name: 'email', Value: email }],
  });

  await cognitoIdpClient.send(command);
}

/**
 * Confirms a signup using the verification code sent to email.
 * @param {string} email
 * @param {string} code - 6-digit confirmation code.
 * @returns {Promise<void>}
 */
async function confirmSignUp(email, code) {
  const command = new ConfirmSignUpCommand({
    ClientId: awsConfig.clientId,
    Username: email,
    ConfirmationCode: code,
    SecretHash: computeSecretHash(email),
  });

  await cognitoIdpClient.send(command);
}

/**
 * Signs the current user out globally (invalidates all tokens).
 * @returns {Promise<void>}
 */
async function signOut() {
  if (!_tokens.accessToken) return;

  try {
    await cognitoIdpClient.send(
      new GlobalSignOutCommand({ AccessToken: _tokens.accessToken })
    );
  } finally {
    _tokens = {
      idToken: null,
      accessToken: null,
      refreshToken: null,
      userId: null,
      email: null,
    };
  }
}

/**
 * Returns the current authenticated user's Cognito sub (userId).
 * @returns {string|null}
 */
function getUserId() {
  return _tokens.userId;
}

/**
 * Returns the current authenticated user's email.
 * @returns {string|null}
 */
function getEmail() {
  return _tokens.email;
}

/**
 * Returns the in-memory token store (useful for restoring sessions).
 * @returns {{idToken, accessToken, refreshToken, userId, email}}
 */
function getCredentials() {
  return { ..._tokens };
}

/**
 * Restores a previously saved session from persisted tokens.
 * @param {{idToken, accessToken, refreshToken}} tokens
 */
function restoreSession(tokens) {
  _tokens.idToken = tokens.idToken || null;
  _tokens.accessToken = tokens.accessToken || null;
  _tokens.refreshToken = tokens.refreshToken || null;
  if (_tokens.idToken) {
    _tokens.userId = extractSubFromToken(_tokens.idToken);
    _tokens.email = extractEmailFromToken(_tokens.idToken);
  }
}

async function refreshTokens() {
  if (!_tokens.refreshToken) throw new Error('No refresh token available');
  const tokenUrl = 'https://ap-south-11fuiqpnq2.auth.ap-south-1.amazoncognito.com/oauth2/token';
  const basicAuth = Buffer.from(`${awsConfig.clientId}:${awsConfig.clientSecret}`).toString('base64');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: awsConfig.clientId,
    refresh_token: _tokens.refreshToken,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: params.toString(),
  });

  const data = await res.json();
  if (data.id_token) {
    _tokens.idToken = data.id_token;
    _tokens.accessToken = data.access_token || _tokens.accessToken;
    _tokens.userId = extractSubFromToken(_tokens.idToken);
    _tokens.email = extractEmailFromToken(_tokens.idToken);
    console.log('[cognito] ID token refreshed automatically.');
    return _tokens;
  }
  throw new Error(data.error || 'Failed to refresh tokens');
}

/**
 * Exchanges the Cognito ID token for temporary AWS credentials via
 * the Cognito Identity Pool (Federated Identities).
 * @returns {Promise<{accessKeyId, secretAccessKey, sessionToken}>}
 */
async function getIdentityCredentials(retryCount = 0) {
  if (!_tokens.idToken) {
    throw new Error('Not authenticated: no ID token available.');
  }

  const loginsKey = `cognito-idp.${awsConfig.region}.amazonaws.com/${awsConfig.userPoolId}`;

  try {
    // Step 1: Get Cognito Identity ID
    const getIdResponse = await cognitoIdentityClient.send(
      new GetIdCommand({
        AccountId: awsConfig.accountId,
        IdentityPoolId: awsConfig.identityPoolId,
        Logins: { [loginsKey]: _tokens.idToken },
      })
    );

    const identityId = getIdResponse.IdentityId;

    // Step 2: Get temporary credentials
    const credResponse = await cognitoIdentityClient.send(
      new GetCredentialsForIdentityCommand({
        IdentityId: identityId,
        Logins: { [loginsKey]: _tokens.idToken },
      })
    );

    const creds = credResponse.Credentials;
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretKey,
      sessionToken: creds.SessionToken,
    };
  } catch (err) {
    if (err.message && err.message.includes('expired') && retryCount === 0 && _tokens.refreshToken) {
      console.log('[cognito] Token expired. Refreshing...');
      await refreshTokens();
      return await getIdentityCredentials(1);
    }
    throw err;
  }
}

/**
 * Exchanges an OAuth authorization code from the Cognito Hosted UI for user tokens.
 * @param {string} code - The authorization code returned by Cognito.
 * @returns {Promise<{userId: string, email: string, tokens: object}>}
 */
async function exchangeCodeForTokens(code) {
  const tokenUrl = 'https://ap-south-11fuiqpnq2.auth.ap-south-1.amazoncognito.com/oauth2/token';
  const basicAuth = Buffer.from(`${awsConfig.clientId}:${awsConfig.clientSecret}`).toString('base64');

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: awsConfig.clientId,
    code: code,
    redirect_uri: 'https://d84l1y8p4kdic.cloudfront.net',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: params.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Failed to exchange authorization code');
  }

  _tokens.idToken = data.id_token;
  _tokens.accessToken = data.access_token;
  _tokens.refreshToken = data.refresh_token;
  _tokens.userId = extractSubFromToken(data.id_token);
  _tokens.email = extractEmailFromToken(data.id_token);

  return { userId: _tokens.userId, email: _tokens.email, tokens: { ..._tokens } };
}

module.exports = {
  login,
  signUp,
  confirmSignUp,
  signOut,
  getUserId,
  getEmail,
  getCredentials,
  restoreSession,
  getIdentityCredentials,
  exchangeCodeForTokens,
};

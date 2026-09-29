'use strict';

/**
 * core/dynamodb.js
 * DynamoDB module for C3 — handles provider registry, session management,
 * cluster negotiation, and user credits.
 *
 * Tables used:
 *   c3_providers  — provider profiles and online status
 *   c3_sessions   — cluster sessions (multi-provider negotiation)
 *   c3_users      — user profiles and credits
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');

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
const cognito = require('./cognito');

// ── Client factory (deferred so credentials are available) ────────────────
let _docClient = null;

async function getClient() {
  if (_docClient) return _docClient;

  let credentials;
  try {
    credentials = await cognito.getIdentityCredentials();
  } catch (err) {
    console.error('[dynamodb] getIdentityCredentials failed:', err.message);
    credentials = undefined;
  }

  const client = new DynamoDBClient({
    region: awsConfig.region,
    ...(credentials
      ? {
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
          },
        }
      : {}),
  });

  _docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });

  return _docClient;
}

/** Resets the cached client (call after re-auth). */
function resetClient() {
  _docClient = null;
}

// ── c3_providers ───────────────────────────────────────────────────────────
/**
 * Writes (upserts) a provider profile into c3_providers.
 * @param {string} userId
 * @param {{displayName: string, cpuModel: string, cpuCores: number, ramGb: number, gpu: string, os: string}} profile
 */
async function registerProvider(userId, profile) {
  const client = await getClient();
  await client.send(
    new PutCommand({
      TableName: 'c3_providers',
      Item: {
        userId,
        displayName: profile.displayName || `Node-${userId.slice(0, 6)}`,
        cpuModel: profile.cpuModel || 'Unknown',
        cpuCores: profile.cpuCores || 1,
        ramGb: profile.ramGb || 1,
        gpu: profile.gpu || 'None',
        os: profile.os || 'Unknown',
        status: 'ONLINE',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
      },
    })
  );
}

/**
 * Reads a provider profile.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getProvider(userId) {
  const client = await getClient();
  const res = await client.send(
    new GetCommand({ TableName: 'c3_providers', Key: { userId } })
  );
  return res.Item || null;
}

/**
 * Sets a provider's status to ONLINE or OFFLINE.
 * @param {string} userId
 * @param {'ONLINE'|'OFFLINE'} status
 */
async function updateProviderStatus(userId, status) {
  const client = await getClient();
  await client.send(
    new UpdateCommand({
      TableName: 'c3_providers',
      Key: { userId },
      UpdateExpression: 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    })
  );
}

/**
 * Updates the lastHeartbeat timestamp for a provider.
 * @param {string} userId
 */
async function heartbeat(userId) {
  const client = await getClient();
  await client.send(
    new UpdateCommand({
      TableName: 'c3_providers',
      Key: { userId },
      UpdateExpression: 'SET lastHeartbeat = :ts',
      ExpressionAttributeValues: { ':ts': Date.now() },
    })
  );
}

/**
 * Returns all providers with status=ONLINE and a heartbeat within the last 120 seconds.
 * @returns {Promise<object[]>}
 */
async function getActiveProviders() {
  const client = await getClient();
  const cutoff = Date.now() - 120 * 1000;
  const res = await client.send(
    new ScanCommand({
      TableName: 'c3_providers',
      FilterExpression: '#s = :online AND lastHeartbeat > :cutoff',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':online': 'ONLINE',
        ':cutoff': cutoff,
      },
    })
  );
  return res.Items || [];
}

// ── c3_sessions ────────────────────────────────────────────────────────────
/**
 * Creates a new cluster session record in c3_sessions.
 * @param {{sessionId: string, consumerId: string, providerIds: string[],
 *           k3sToken: string, tailscaleAuthKey: string}} sessionData
 */
async function createClusterSession(sessionData) {
  const client = await getClient();

  // Build providersStatus map: { [providerId]: 'PENDING' }
  const providersStatus = {};
  for (const pid of sessionData.providerIds) {
    providersStatus[pid] = 'PENDING';
  }

  await client.send(
    new PutCommand({
      TableName: 'c3_sessions',
      Item: {
        sessionId: sessionData.sessionId,
        consumerId: sessionData.consumerId,
        isCluster: true,
        providerIds: sessionData.providerIds,
        providersStatus,
        k3sToken: sessionData.k3sToken,
        tailscaleAuthKey: sessionData.tailscaleAuthKey,
        consumerMeshIp: null,
        clusterStatus: 'NEGOTIATING',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
  );
}

/**
 * Returns all pending cluster requests for a specific provider.
 * @param {string} providerId
 * @returns {Promise<object[]>}
 */
async function getPendingClusterRequestsForProvider(providerId) {
  const client = await getClient();
  const res = await client.send(
    new ScanCommand({
      TableName: 'c3_sessions',
      FilterExpression: 'clusterStatus = :neg',
      ExpressionAttributeValues: { ':neg': 'NEGOTIATING' },
    })
  );

  const items = res.Items || [];
  return items.filter(
    (item) =>
      Array.isArray(item.providerIds) &&
      item.providerIds.includes(providerId) &&
      item.providersStatus &&
      item.providersStatus[providerId] === 'PENDING'
  );
}

/**
 * Marks a provider's status in a session as ACCEPTED.
 * @param {string} sessionId
 * @param {string} providerId
 */
async function acceptClusterRequest(sessionId, providerId) {
  const client = await getClient();
  await client.send(
    new UpdateCommand({
      TableName: 'c3_sessions',
      Key: { sessionId },
      UpdateExpression:
        'SET providersStatus.#pid = :accepted, updatedAt = :now',
      ExpressionAttributeNames: { '#pid': providerId },
      ExpressionAttributeValues: {
        ':accepted': 'ACCEPTED',
        ':now': Date.now(),
      },
    })
  );
}

/**
 * Marks a provider's status in a session as DECLINED and sets clusterStatus to DECLINED.
 * @param {string} sessionId
 * @param {string} providerId
 */
async function declineClusterRequest(sessionId, providerId) {
  const client = await getClient();
  await client.send(
    new UpdateCommand({
      TableName: 'c3_sessions',
      Key: { sessionId },
      UpdateExpression:
        'SET providersStatus.#pid = :declined, clusterStatus = :ds, updatedAt = :now',
      ExpressionAttributeNames: { '#pid': providerId },
      ExpressionAttributeValues: {
        ':declined': 'DECLINED',
        ':ds': 'DECLINED',
        ':now': Date.now(),
      },
    })
  );
}

/**
 * Sets the consumer's mesh IP on a session and moves clusterStatus to BOOTSTRAPPING.
 * @param {string} sessionId
 * @param {string} meshIp
 */
async function setClusterMasterMeshIp(sessionId, meshIp, k3sToken) {
  const client = await getClient();
  const updateExp = k3sToken
    ? 'SET consumerMeshIp = :ip, k3sToken = :token, clusterStatus = :bs, updatedAt = :now'
    : 'SET consumerMeshIp = :ip, clusterStatus = :bs, updatedAt = :now';
  const expValues = {
    ':ip': meshIp,
    ':bs': 'BOOTSTRAPPING',
    ':now': Date.now(),
    ...(k3sToken ? { ':token': k3sToken } : {}),
  };
  await client.send(
    new UpdateCommand({
      TableName: 'c3_sessions',
      Key: { sessionId },
      UpdateExpression: updateExp,
      ExpressionAttributeValues: expValues,
    })
  );
}

/**
 * Updates the top-level clusterStatus field.
 * @param {string} sessionId
 * @param {string} status
 */
async function setClusterStatus(sessionId, status) {
  const client = await getClient();
  await client.send(
    new UpdateCommand({
      TableName: 'c3_sessions',
      Key: { sessionId },
      UpdateExpression: 'SET clusterStatus = :s, updatedAt = :now',
      ExpressionAttributeValues: { ':s': status, ':now': Date.now() },
    })
  );
}

/**
 * Retrieves a full session record by ID.
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
async function getSession(sessionId) {
  const client = await getClient();
  const res = await client.send(
    new GetCommand({ TableName: 'c3_sessions', Key: { sessionId } })
  );
  return res.Item || null;
}

// ── c3_users ───────────────────────────────────────────────────────────────
/**
 * Retrieves a user record.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getUser(userId) {
  const client = await getClient();
  const res = await client.send(
    new GetCommand({ TableName: 'c3_users', Key: { userId } })
  );
  return res.Item || null;
}

/**
 * Creates a new user record with 100 starter credits.
 * @param {string} userId
 * @param {string} email
 */
async function createUser(userId, email) {
  const client = await getClient();
  await client.send(
    new PutCommand({
      TableName: 'c3_users',
      ConditionExpression: 'attribute_not_exists(userId)',
      Item: {
        userId,
        email,
        credits: 100,
        createdAt: Date.now(),
      },
    })
  );
}

/**
 * Atomically adds `delta` to a user's credits (use negative delta to subtract).
 * @param {string} userId
 * @param {number} delta
 */
async function updateCredits(userId, delta) {
  const client = await getClient();
  await client.send(
    new UpdateCommand({
      TableName: 'c3_users',
      Key: { userId },
      UpdateExpression: 'ADD credits :d',
      ExpressionAttributeValues: { ':d': delta },
    })
  );
}

module.exports = {
  resetClient,
  // Providers
  registerProvider,
  getProvider,
  updateProviderStatus,
  heartbeat,
  getActiveProviders,
  // Sessions
  createClusterSession,
  getPendingClusterRequestsForProvider,
  acceptClusterRequest,
  declineClusterRequest,
  setClusterMasterMeshIp,
  setClusterStatus,
  getSession,
  // Users
  getUser,
  createUser,
  updateCredits,
};

'use strict';

/**
 * core/dynamodb.js
 * Amazon DynamoDB Cloud Node Registry & Session Coordinator.
 * Manages:
 *  - c3_providers: Node discovery, specs, and heartbeats
 *  - c3_users: User profiles and credit balances
 *  - c3_sessions: Cluster sessions and invitation negotiations
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ScanCommand,
  GetItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { getCredentials, cfg } = require('./cognito');

function getClient() {
  const credentials = getCredentials();
  const clientConfig = { region: cfg.region };
  if (credentials) clientConfig.credentials = credentials;
  return new DynamoDBClient(clientConfig);
}

// ── Provider Registry & Heartbeats ──────────────────────────────────────────
async function registerProvider(userId, profile) {
  const client = getClient();
  const item = {
    userId,
    status: 'ACTIVE',
    lastHeartbeat: Math.floor(Date.now() / 1000),
    ...profile,
  };

  const command = new PutItemCommand({
    TableName: 'c3_providers',
    Item: marshall(item),
  });

  await client.send(command);
  return item;
}

async function getProvider(userId) {
  const client = getClient();
  const command = new GetItemCommand({
    TableName: 'c3_providers',
    Key: marshall({ userId }),
  });
  try {
    const response = await client.send(command);
    return response.Item ? unmarshall(response.Item) : null;
  } catch (e) {
    return null;
  }
}

async function updateProviderStatus(userId, status) {
  const client = getClient();
  const command = new UpdateItemCommand({
    TableName: 'c3_providers',
    Key: marshall({ userId }),
    UpdateExpression: 'SET #status = :s, lastHeartbeat = :ts',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: marshall({
      ':s': status,
      ':ts': Math.floor(Date.now() / 1000),
    }),
  });

  await client.send(command);
}

async function heartbeat(userId, network = null) {
  const client = getClient();
  const now = Math.floor(Date.now() / 1000);
  const fields = { lastHeartbeat: now };
  if (network && typeof network === 'object') {
    if (Object.hasOwn(network, 'tailscaleIp')) fields.tailscaleIp = network.tailscaleIp || null;
    if (Object.hasOwn(network, 'tailscaleNodeName')) fields.tailscaleNodeName = network.tailscaleNodeName || null;
    if (Object.hasOwn(network, 'localIp')) fields.localIp = network.localIp || null;
    if (Number.isInteger(network.port) && network.port > 0 && network.port <= 65535) fields.port = network.port;
  }
  const values = { ':ts': now };
  const assignments = ['lastHeartbeat = :ts'];
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'lastHeartbeat') continue;
    const token = `:${key}`;
    assignments.push(`${key} = ${token}`);
    values[token] = value;
  }
  const command = new UpdateItemCommand({
    TableName: 'c3_providers',
    Key: marshall({ userId }),
    UpdateExpression: `SET ${assignments.join(', ')}`,
    ExpressionAttributeValues: marshall(values),
  });

  await client.send(command);
}

async function getActiveProviders() {
  const client = getClient();
  const items = [];
  let exclusiveStartKey;
  try {
    do {
      const command = new ScanCommand({
        TableName: 'c3_providers',
        FilterExpression: '#status = :s',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({ ':s': 'ACTIVE' }),
        ExclusiveStartKey: exclusiveStartKey,
      });
      const response = await client.send(command);
      if (response.Items) items.push(...response.Items.map(item => unmarshall(item)));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);

    const nowSec = Math.floor(Date.now() / 1000);

    // Active within last 10 minutes
    const activeItems = items.filter(item => {
      if (!item.lastHeartbeat) return true;
      const hb = typeof item.lastHeartbeat === 'string' ? parseInt(item.lastHeartbeat, 10) : item.lastHeartbeat;
      const hbSec = hb > 10_000_000_000 ? Math.floor(hb / 1000) : hb;
      return (nowSec - hbSec) < 600;
    });

    return activeItems;
  } catch (e) {
    console.warn('[dynamodb] getActiveProviders note:', e.message);
    return [];
  }
}

// ── Cluster Sessions & Negotiations ─────────────────────────────────────────
async function createSessionRequest(sessionData) {
  const client = getClient();
  const command = new PutItemCommand({
    TableName: 'c3_sessions',
    Item: marshall(sessionData),
  });

  await client.send(command);
  return sessionData;
}

async function updateSessionStatus(sessionId, status, extraFields = {}) {
  const client = getClient();
  let updateExp = 'SET #status = :s';
  const expNames = { '#status': 'status' };
  const expValues = { ':s': status };

  Object.keys(extraFields).forEach((key, index) => {
    const attrName = `#extra${index}`;
    const attrValue = `:val${index}`;
    updateExp += `, ${attrName} = ${attrValue}`;
    expNames[attrName] = key;
    expValues[attrValue] = extraFields[key];
  });

  const command = new UpdateItemCommand({
    TableName: 'c3_sessions',
    Key: marshall({ sessionId }),
    UpdateExpression: updateExp,
    ExpressionAttributeNames: expNames,
    ExpressionAttributeValues: marshall(expValues),
  });

  await client.send(command);
}

async function getSession(sessionId) {
  const client = getClient();
  const command = new GetItemCommand({
    TableName: 'c3_sessions',
    Key: marshall({ sessionId }),
  });

  const response = await client.send(command);
  return response.Item ? unmarshall(response.Item) : null;
}

async function getPendingRequestsForProvider(providerId) {
  if (!providerId) return [];
  const client = getClient();
  try {
    const items = [];
    let exclusiveStartKey;
    do {
      const response = await client.send(new QueryCommand({
        TableName: 'c3_sessions',
        IndexName: 'providerId-status-index',
        KeyConditionExpression: 'providerId = :p AND #status = :s',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({ ':p': providerId, ':s': 'PENDING' }),
        ExclusiveStartKey: exclusiveStartKey,
      }));
      if (response.Items) items.push(...response.Items.map(item => unmarshall(item)));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  } catch (indexError) {
    // Older deployments may not have the providerId-status GSI yet. Scan as
    // a compatibility fallback so a successfully written request still gets
    // delivered; keep errors visible if both permissions/paths fail.
    try {
      const items = [];
      let exclusiveStartKey;
      do {
        const response = await client.send(new ScanCommand({
          TableName: 'c3_sessions',
          FilterExpression: 'providerId = :p AND #status = :s',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: marshall({ ':p': providerId, ':s': 'PENDING' }),
          ExclusiveStartKey: exclusiveStartKey,
        }));
        if (response.Items) items.push(...response.Items.map(item => unmarshall(item)));
        exclusiveStartKey = response.LastEvaluatedKey;
      } while (exclusiveStartKey);
      return items;
    } catch (scanError) {
      const error = new Error(`Could not check provider requests. Index lookup failed: ${indexError.message}. Fallback lookup failed: ${scanError.message}`);
      error.cause = scanError;
      throw error;
    }
  }
}

// Negotiation messages use the existing c3_chat table (chatId partition key,
// numeric timestamp sort key). Session IDs are unique conversation IDs.
async function getChatMessages(chatId, limit = 100) {
  const client = getClient();
  const command = new QueryCommand({
    TableName: 'c3_chat',
    KeyConditionExpression: '#chatId = :chatId',
    ExpressionAttributeNames: { '#chatId': 'chatId' },
    ExpressionAttributeValues: marshall({ ':chatId': chatId }),
    ScanIndexForward: false,
    Limit: Math.max(1, Math.min(200, Number(limit) || 100)),
  });
  const response = await client.send(command);
  return (response.Items || []).map(item => unmarshall(item)).reverse();
}

async function createChatMessage({ chatId, senderId, senderName, text, offerPerHour = null, type = 'MESSAGE' }) {
  const client = getClient();
  const timestamp = Date.now() * 1000 + crypto.randomInt(0, 1000);
  const item = {
    chatId,
    timestamp,
    messageId: crypto.randomUUID(),
    senderId,
    senderName: senderName || 'C3 user',
    text: String(text || '').slice(0, 2000),
    type,
    createdAt: new Date().toISOString(),
  };
  if (offerPerHour != null) item.offerPerHour = Number(offerPerHour);

  await client.send(new PutItemCommand({
    TableName: 'c3_chat',
    Item: marshall(item, { removeUndefinedValues: true }),
  }));
  return item;
}

// ── User Profiles & Credits ─────────────────────────────────────────────────
async function createUser(userId, email, displayName) {
  const client = getClient();
  
  // 1. Check if user already exists to protect existing balance
  const existing = await getUser(userId);
  if (existing) {
    return existing; // Keep existing balance and profile!
  }

  // 2. Only grant starting balance of 100 for brand-new users
  const item = {
    userId,
    email,
    displayName: displayName || email.split('@')[0],
    credits: 100, // starting balance for new users only
    createdAt: Math.floor(Date.now() / 1000),
  };

  const command = new PutItemCommand({
    TableName: 'c3_users',
    Item: marshall(item),
    ConditionExpression: 'attribute_not_exists(userId)',
  });

  try {
    await client.send(command);
    return item;
  } catch (err) {
    const current = await getUser(userId);
    return current;
  }
}

async function getUser(userId) {
  const client = getClient();
  const command = new GetItemCommand({
    TableName: 'c3_users',
    Key: marshall({ userId }),
  });

  try {
    const response = await client.send(command);
    return response.Item ? unmarshall(response.Item) : null;
  } catch (_) {
    return null;
  }
}

async function getCredits(userId) {
  const u = await getUser(userId);
  return u?.credits ?? null;
}

async function updateUserCredits(userId, amount) {
  const client = getClient();
  const command = new UpdateItemCommand({
    TableName: 'c3_users',
    Key: marshall({ userId }),
    UpdateExpression: 'SET #credits = if_not_exists(#credits, :zero) + :amt, #faucetClaimedAt = :claimedAt, #faucetClaimAmount = :amt',
    ExpressionAttributeNames: {
      '#credits': 'credits',
      '#faucetClaimedAt': 'faucetClaimedAt',
      '#faucetClaimAmount': 'faucetClaimAmount',
    },
    ExpressionAttributeValues: marshall({
      ':zero': 0,
      ':amt': Number(amount),
      ':claimedAt': new Date().toISOString(),
      ':maxUnclaimedBalance': 100,
    }),
    // Atomic lifetime faucet: one 500-credit grant, and only before the
    // account balance rises above its initial signup credit. This also closes
    // the loophole for accounts that repeatedly claimed with older builds.
    ConditionExpression: 'attribute_exists(userId) AND attribute_not_exists(#faucetClaimedAt) AND (attribute_not_exists(#credits) OR #credits <= :maxUnclaimedBalance)',
    ReturnValues: 'ALL_NEW',
  });
  try {
    const res = await client.send(command);
    return res.Attributes ? unmarshall(res.Attributes) : null;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      const limited = new Error('The test faucet allows one +500 C3 claim per account. This account has already claimed or its balance is above the initial signup grant.');
      limited.code = 'FAUCET_LIMIT_REACHED';
      throw limited;
    }
    console.warn('[dynamodb] updateUserCredits failed:', err.message);
    return null;
  }
}

module.exports = {
  registerProvider,
  getProvider,
  updateProviderStatus,
  heartbeat,
  getActiveProviders,
  createSessionRequest,
  updateSessionStatus,
  getSession,
  getPendingRequestsForProvider,
  getChatMessages,
  createChatMessage,
  createUser,
  getUser,
  getCredits,
  updateUserCredits,
};


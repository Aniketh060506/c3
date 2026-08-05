const fs = require('fs');
const path = require('path');
const { DynamoDBClient, PutItemCommand, UpdateItemCommand, QueryCommand, ScanCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { getCredentials } = require('./cognito');

const configPath = path.join(__dirname, '..', 'aws-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function getClient() {
  const credentials = getCredentials();
  const clientConfig = { region: config.region };
  if (credentials) clientConfig.credentials = credentials;
  return new DynamoDBClient(clientConfig);
}

async function registerProvider(userId, profile) {
  const client = getClient();
  const item = {
    userId,
    status: 'ACTIVE',
    lastHeartbeat: Math.floor(Date.now() / 1000),
    ...profile
  };
  
  const command = new PutItemCommand({
    TableName: 'c3_providers',
    Item: marshall(item)
  });
  
  await client.send(command);
  return item;
}

async function updateProviderStatus(userId, status) {
  const client = getClient();
  const command = new UpdateItemCommand({
    TableName: 'c3_providers',
    Key: marshall({ userId }),
    UpdateExpression: 'SET #status = :s, lastHeartbeat = :ts',
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: marshall({
      ':s': status,
      ':ts': Math.floor(Date.now() / 1000)
    })
  });
  
  await client.send(command);
}

async function heartbeat(userId) {
  const client = getClient();
  const command = new UpdateItemCommand({
    TableName: 'c3_providers',
    Key: marshall({ userId }),
    UpdateExpression: 'SET lastHeartbeat = :ts',
    ExpressionAttributeValues: marshall({
      ':ts': Math.floor(Date.now() / 1000)
    })
  });
  
  await client.send(command);
}

async function getActiveProviders() {
  const client = getClient();
  
  const command = new ScanCommand({
    TableName: 'c3_providers',
    FilterExpression: '#status = :s',
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: marshall({
      ':s': 'ACTIVE'
    })
  });
  
  try {
    const response = await client.send(command);
    const items = response.Items ? response.Items.map(item => unmarshall(item)) : [];
    const nowSec = Math.floor(Date.now() / 1000);
    
    // Allow heartbeat within last 10 minutes (600s) or fallback if heartbeat missing
    const activeItems = items.filter(item => {
      if (!item.lastHeartbeat) return true;
      const hb = typeof item.lastHeartbeat === 'string' ? parseInt(item.lastHeartbeat, 10) : item.lastHeartbeat;
      // Handle millisecond vs second timestamps
      const hbSec = hb > 10_000_000_000 ? Math.floor(hb / 1000) : hb;
      return (nowSec - hbSec) < 600;
    });

    console.log(`[C3 Dynamo] getActiveProviders → found ${activeItems.length} active nodes (out of ${items.length} total active status)`);
    return activeItems;
  } catch (e) {
    console.error('[C3 Dynamo] getActiveProviders failed:', e.message);
    return [];
  }
}


async function createSessionRequest(sessionData) {
  const client = getClient();
  const command = new PutItemCommand({
    TableName: 'c3_sessions',
    Item: marshall(sessionData)
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
    ExpressionAttributeValues: marshall(expValues)
  });
  
  await client.send(command);
}

async function getSession(sessionId) {
  const client = getClient();
  const command = new GetItemCommand({
    TableName: 'c3_sessions',
    Key: marshall({ sessionId })
  });
  
  const response = await client.send(command);
  return response.Item ? unmarshall(response.Item) : null;
}

async function getPendingRequestsForProvider(providerId) {
  const client = getClient();
  const command = new QueryCommand({
    TableName: 'c3_sessions',
    IndexName: 'providerId-status-index',
    KeyConditionExpression: 'providerId = :p AND #status = :s',
    ExpressionAttributeNames: {
      '#status': 'status'
    },
    ExpressionAttributeValues: marshall({
      ':p': providerId,
      ':s': 'PENDING'
    })
  });
  
  const response = await client.send(command);
  return response.Items ? response.Items.map(item => unmarshall(item)) : [];
}

async function sendChatMessage(chatId, senderId, message) {
  const client = getClient();
  const timestamp = Math.floor(Date.now() / 1000);
  const item = {
    chatId,
    timestamp,
    senderId,
    message
  };
  
  const command = new PutItemCommand({
    TableName: 'c3_chat',
    Item: marshall(item)
  });
  
  await client.send(command);
  return item;
}

async function getChatMessages(chatId, sinceTimestamp = 0) {
  const client = getClient();
  const command = new QueryCommand({
    TableName: 'c3_chat',
    KeyConditionExpression: 'chatId = :cid AND #ts > :sts',
    ExpressionAttributeNames: {
      '#ts': 'timestamp'
    },
    ExpressionAttributeValues: marshall({
      ':cid': chatId,
      ':sts': sinceTimestamp
    })
  });
  
  const response = await client.send(command);
  return response.Items ? response.Items.map(item => unmarshall(item)) : [];
}

async function getUser(userId) {
  const client = getClient();
  const command = new GetItemCommand({
    TableName: 'c3_users',
    Key: marshall({ userId })
  });
  
  const response = await client.send(command);
  return response.Item ? unmarshall(response.Item) : null;
}

async function updateCredits(userId, delta) {
  const client = getClient();
  const command = new UpdateItemCommand({
    TableName: 'c3_users',
    Key: marshall({ userId }),
    UpdateExpression: 'ADD credits :delta',
    ExpressionAttributeValues: marshall({
      ':delta': delta
    })
  });
  
  await client.send(command);
}

async function createUser(userId, email) {
  const client = getClient();
  const item = {
    userId,
    email,
    credits: 100
  };
  
  const command = new PutItemCommand({
    TableName: 'c3_users',
    Item: marshall(item)
  });
  
  await client.send(command);
  return item;
}

module.exports = {
  registerProvider,
  updateProviderStatus,
  heartbeat,
  getActiveProviders,
  createSessionRequest,
  updateSessionStatus,
  getSession,
  getPendingRequestsForProvider,
  sendChatMessage,
  getChatMessages,
  getUser,
  updateCredits,
  createUser
};

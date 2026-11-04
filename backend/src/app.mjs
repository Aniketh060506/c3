import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

const region = process.env.AWS_REGION ?? "ap-south-1";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
const tables = {
  providers: process.env.PROVIDERS_TABLE ?? "online_providers",
  sessions: process.env.SESSIONS_TABLE ?? "sessions",
  conversations: process.env.CONVERSATIONS_TABLE ?? "conversations",
  messages: process.env.MESSAGES_TABLE ?? "messages",
};
const onlineWindowMs = 45_000;

const reply = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
const parseBody = (event) => event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : {};
const now = () => new Date().toISOString();
const normalizePeerIp = (value) => {
  const ip = String(value ?? "").trim().split("/")[0];
  return isIP(ip) ? ip : "";
};
const claims = (event) => event.requestContext?.authorizer?.jwt?.claims ?? {};
const user = (event) => {
  const c = claims(event);
  if (typeof c.sub !== "string" || !c.sub) throw Object.assign(new Error("Cognito identity is missing."), { statusCode: 401 });
  return { sub: c.sub, email: c.email ?? "", name: c.name ?? c.given_name ?? c.email ?? "ComputePool user" };
};
const all = async (table, filter) => {
  let items = [], ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
    items = items.concat(page.Items ?? []);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return filter ? items.filter(filter) : items;
};
const getSession = async (id) => (await ddb.send(new GetCommand({ TableName: tables.sessions, Key: { sessionId: id } }))).Item;
const participant = (item, actor) => !!item && (item.consumerSub === actor.sub || item.providerSub === actor.sub);
const assertParticipant = (item, actor) => { if (!participant(item, actor)) throw Object.assign(new Error("Negotiation was not found."), { statusCode: 404 }); };
const assertProvider = async (nodeId, actor) => {
  const item = (await ddb.send(new GetCommand({ TableName: tables.providers, Key: { nodeId } }))).Item;
  if (!item || item.ownerSub !== actor.sub) throw Object.assign(new Error("Provider is not owned by this signed-in account."), { statusCode: 404 });
  return item;
};
const saveMessage = async (conversationId, actor, text, proposal) => {
  const cleaned = String(text ?? "").trim();
  if (!cleaned || cleaned.length > 8000) throw Object.assign(new Error("Message must contain 1–8000 characters."), { statusCode: 400 });
  const message = { id: randomUUID(), conversationId, messageKey: `${now()}#${randomUUID()}`, senderSub: actor.sub, senderName: actor.name, text: cleaned, createdAt: now(), ...(proposal ? { proposal } : {}) };
  await ddb.send(new PutCommand({ TableName: tables.messages, Item: message }));
  return message;
};
const messagesFor = async (conversationId) => {
  const result = await ddb.send(new QueryCommand({ TableName: tables.messages, KeyConditionExpression: "conversationId = :id", ExpressionAttributeValues: { ":id": conversationId }, ScanIndexForward: true }));
  return result.Items ?? [];
};
let netbirdToken;
async function getNetBirdToken() {
  if (netbirdToken) return netbirdToken;
  netbirdToken = process.env.NETBIRD_MANAGEMENT_TOKEN?.trim();
  if (!netbirdToken) throw Object.assign(new Error("NetBird management token is not configured in the Lambda environment."), { statusCode: 503 });
  return netbirdToken;
}
async function createSetupKey(actor, role) {
  if (role !== "consumer" && role !== "provider") throw Object.assign(new Error("role must be consumer or provider."), { statusCode: 400 });
  const token = await getNetBirdToken();
  const body = { name: `computepool-${role}-${actor.sub.slice(0, 8)}-${Date.now()}`, type: "one-off", expires_in: 86400, auto_groups: process.env.NETBIRD_ENROLLMENT_GROUP_ID ? [process.env.NETBIRD_ENROLLMENT_GROUP_ID] : [], usage_limit: 1, ephemeral: false, allow_extra_dns_labels: false };
  const response = await fetch(`${(process.env.NETBIRD_API ?? "https://api.netbird.io").replace(/\/$/, "")}/api/setup-keys`, { method: "POST", headers: { authorization: `Token ${token}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw Object.assign(new Error(`NetBird setup-key request failed (${response.status}). Verify the API token and account permissions.`), { statusCode: 502 });
  const key = await response.json();
  if (typeof key.key !== "string" || !key.key) throw Object.assign(new Error("NetBird did not return a setup key."), { statusCode: 502 });
  return { setupKey: key.key, expiresAt: key.expires, type: key.type };
}
async function isManagedPeer(ip) {
  ip = normalizePeerIp(ip);
  if (!ip) return false;
  const token = await getNetBirdToken();
  const url = new URL(`${(process.env.NETBIRD_API ?? "https://api.netbird.io").replace(/\/$/, "")}/api/peers`);
  url.searchParams.set("ip", ip);
  const response = await fetch(url, { headers: { authorization: `Token ${token}`, accept: "application/json" } });
  if (!response.ok) throw Object.assign(new Error(`NetBird peer verification failed (${response.status}).`), { statusCode: 502 });
  const peers = await response.json();
  return Array.isArray(peers) && peers.some((peer) => peer.ip === ip && peer.connected === true);
}
async function netbirdRequest(method, path, body) {
  const token = await getNetBirdToken();
  const response = await fetch(`${(process.env.NETBIRD_API ?? "https://api.netbird.io").replace(/\/$/, "")}${path}`, { method, headers: { authorization: `Token ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok && !(method === "DELETE" && response.status === 404)) throw Object.assign(new Error(`NetBird ${method} ${path} failed (${response.status}).`), { statusCode: 502 });
  if (response.status === 404) return {};
  if (response.status === 204) return {};
  return response.json();
}
const groupIds = (groupList) => (groupList ?? []).map((g) => typeof g === "string" ? g : g.id).filter(Boolean);
async function assertNoWorkspaceWideAllowPolicy() {
  const policies = await netbirdRequest("GET", "/api/policies");
  const groups = await netbirdRequest("GET", "/api/groups");
  const allIds = new Set((Array.isArray(groups) ? groups : []).filter((group) => String(group.name).toLowerCase() === "all").map((group) => group.id));
  for (const policy of Array.isArray(policies) ? policies : []) {
    const broadlyScoped = (policy.rules ?? []).some((rule) => rule.enabled !== false && rule.action === "accept" && (groupIds(rule.sources).some((g) => allIds.has(g)) || groupIds(rule.destinations).some((g) => allIds.has(g))));
    if (policy.enabled !== true || !broadlyScoped) continue;
    const isDefault = String(policy.name ?? "").toLowerCase() === "default" || String(policy.description ?? "").toLowerCase().includes("default policy") || (policy.rules ?? []).some((rule) => String(rule.name ?? "").toLowerCase() === "default");
    const label = isDefault ? "default policy" : `policy “${policy.name ?? policy.id}”`;
    throw Object.assign(new Error(`NetBird ${label} grants access through the All group. ComputePool will not change your workspace-wide access rules. Narrow or remove that rule in NetBird before starting an isolated session.`), { statusCode: 409 });
  }
}
async function peerIdByIp(ip) {
  const url = new URL(`${(process.env.NETBIRD_API ?? "https://api.netbird.io").replace(/\/$/, "")}/api/peers`);
  url.searchParams.set("ip", ip);
  const token = await getNetBirdToken();
  const response = await fetch(url, { headers: { authorization: `Token ${token}`, accept: "application/json" } });
  if (!response.ok) throw Object.assign(new Error(`NetBird peer lookup failed (${response.status}).`), { statusCode: 502 });
  const peers = await response.json();
  const peer = Array.isArray(peers) ? peers.find((item) => item.ip === ip && item.connected === true) : null;
  if (!peer?.id) throw Object.assign(new Error("An accepted laptop is not connected to the ComputePool NetBird workspace."), { statusCode: 409 });
  return peer.id;
}
async function establishSessionNetwork(actor, event) {
  const body = parseBody(event);
  const ids = [...new Set((Array.isArray(body.negotiationIds) ? body.negotiationIds : []).map(String))];
  if (!ids.length || ids.length > 16) throw Object.assign(new Error("Select between one and sixteen accepted providers."), { statusCode: 400 });
  const consumerIp = normalizePeerIp(body.consumerPeerIp);
  if (!consumerIp) throw Object.assign(new Error("A valid consumer NetBird peer IP is required."), { statusCode: 400 });
  const accepted = await Promise.all(ids.map(getSession));
  for (const session of accepted) {
    assertParticipant(session, actor);
    if (session.consumerSub !== actor.sub || session.state !== "accepted") throw Object.assign(new Error("Every selected negotiation must be accepted by its provider."), { statusCode: 409 });
  }
  await assertNoWorkspaceWideAllowPolicy();
  const ips = [consumerIp];
  for (const session of accepted) {
    const provider = await ddb.send(new GetCommand({ TableName: tables.providers, Key: { nodeId: session.providerId } }));
    if (!provider.Item?.netbirdIp) throw Object.assign(new Error("An accepted provider has no registered NetBird IP."), { statusCode: 409 });
    const providerIp = normalizePeerIp(provider.Item.netbirdIp);
    if (!providerIp) throw Object.assign(new Error("An accepted provider has an invalid NetBird peer IP. Ask the provider to refresh its online status."), { statusCode: 409 });
    ips.push(providerIp);
  }
  const expiresAt = Date.now() + Math.min(...accepted.map((session) => Number(session.durationMinutes ?? 60))) * 60_000;
  const peerIds = await Promise.all([...new Set(ips)].map(peerIdByIp));
  const sessionGroup = await netbirdRequest("POST", "/api/groups", { name: `computepool-${randomUUID().slice(0, 12)}`, peers: peerIds });
  let policy;
  try {
    policy = await netbirdRequest("POST", "/api/policies", { name: `computepool-${randomUUID().slice(0, 12)}`, description: "ComputePool accepted session access", enabled: true, rules: [{ name: "session-peers", description: "Only accepted ComputePool session peers", enabled: true, action: "accept", bidirectional: true, protocol: "all", sources: [sessionGroup.id], destinations: [sessionGroup.id] }] });
  } catch (error) {
    if (sessionGroup?.id) await netbirdRequest("DELETE", `/api/groups/${encodeURIComponent(sessionGroup.id)}`).catch(() => {});
    throw error;
  }
  try {
    for (const session of accepted) await ddb.send(new UpdateCommand({ TableName: tables.sessions, Key: { sessionId: session.sessionId }, UpdateExpression: "SET netbirdGroupId = :group, netbirdPolicyId = :policy, networkGrantedAt = :now, networkExpiresAt = :expires", ExpressionAttributeValues: { ":group": sessionGroup.id, ":policy": policy.id, ":now": now(), ":expires": expiresAt } }));
  } catch (error) {
    if (policy?.id) await netbirdRequest("DELETE", `/api/policies/${encodeURIComponent(policy.id)}`).catch(() => {});
    if (sessionGroup?.id) await netbirdRequest("DELETE", `/api/groups/${encodeURIComponent(sessionGroup.id)}`).catch(() => {});
    throw error;
  }
  return { connectedPeers: peerIds.length, policyId: policy.id };
}
async function cleanupExpiredSessions() {
  const expired = await all(tables.sessions, (session) => Boolean(session.netbirdPolicyId) && Number(session.networkExpiresAt) <= Date.now());
  const policyIds = [...new Set(expired.map((item) => item.netbirdPolicyId).filter(Boolean))];
  const groupIdsToDelete = [...new Set(expired.map((item) => item.netbirdGroupId).filter(Boolean))];
  for (const id of policyIds) await netbirdRequest("DELETE", `/api/policies/${encodeURIComponent(id)}`);
  for (const id of groupIdsToDelete) await netbirdRequest("DELETE", `/api/groups/${encodeURIComponent(id)}`);
  for (const session of expired) await ddb.send(new UpdateCommand({ TableName: tables.sessions, Key: { sessionId: session.sessionId }, UpdateExpression: "SET networkEndedAt = :now, #state = :ended REMOVE netbirdGroupId, netbirdPolicyId, networkGrantedAt, networkExpiresAt", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":now": now(), ":ended": "ended" } }));
  return { expiredSessions: expired.length };
}
async function endSessionNetwork(actor, event) {
  const body = parseBody(event);
  const ids = [...new Set((Array.isArray(body.negotiationIds) ? body.negotiationIds : []).map(String))];
  const preserveAccepted = body.preserveAccepted === true;
  if (!ids.length) return { ended: true };
  const accepted = await Promise.all(ids.map(getSession));
  for (const session of accepted) { assertParticipant(session, actor); if (session.consumerSub !== actor.sub) throw Object.assign(new Error("Only the session consumer can end its network grant."), { statusCode: 403 }); }
  const policyIds = [...new Set(accepted.map((item) => item.netbirdPolicyId).filter(Boolean))];
  const groupIdsToDelete = [...new Set(accepted.map((item) => item.netbirdGroupId).filter(Boolean))];
  for (const id of policyIds) await netbirdRequest("DELETE", `/api/policies/${encodeURIComponent(id)}`);
  for (const id of groupIdsToDelete) await netbirdRequest("DELETE", `/api/groups/${encodeURIComponent(id)}`);
  for (const session of accepted) {
    const values = { ":now": now() };
    const names = {};
    const stateUpdate = preserveAccepted ? "" : ", #state = :ended";
    if (!preserveAccepted) { names["#state"] = "state"; values[":ended"] = "ended"; }
    await ddb.send(new UpdateCommand({ TableName: tables.sessions, Key: { sessionId: session.sessionId }, UpdateExpression: `SET networkEndedAt = :now${stateUpdate} REMOVE netbirdGroupId, netbirdPolicyId, networkGrantedAt, networkExpiresAt`, ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}), ExpressionAttributeValues: values }));
  }
  return { ended: !preserveAccepted, preservedAccepted: preserveAccepted };
}

async function handle(event) {
  const actor = user(event);
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  if (method === "GET" && path === "/providers") {
    const providers = await all(tables.providers);
    const timestamp = Date.now();
    return reply(200, providers.map((p) => ({ ...p, id: p.nodeId, online: p.online === true && timestamp - Date.parse(p.heartbeatAt ?? "") <= onlineWindowMs })).filter((p) => p.ownerSub !== actor.sub).map(({ ownerSub, ...p }) => p));
  }
  if (path === "/providers/me" && method === "PUT") {
    const body = parseBody(event);
    const nodeId = String(body.nodeId ?? "");
    if (!/^[\w-]{8,100}$/.test(nodeId)) throw Object.assign(new Error("A stable provider node ID is required."), { statusCode: 400 });
    const netbirdIp = normalizePeerIp(body.netbirdIp);
    if (body.online === true && !netbirdIp) throw Object.assign(new Error("A connected NetBird peer IP is required before this laptop can be listed online."), { statusCode: 400 });
    const prior = (await ddb.send(new GetCommand({ TableName: tables.providers, Key: { nodeId } }))).Item;
    if (prior && prior.ownerSub !== actor.sub) throw Object.assign(new Error("Provider node ID is already registered to another account."), { statusCode: 409 });
    const item = { nodeId, ownerSub: actor.sub, displayName: String(body.displayName ?? actor.name).slice(0, 100), username: actor.email, online: body.online === true, heartbeatAt: now(), netbirdIp, netbirdPeerId: String(body.netbirdPeerId ?? ""), limits: body.limits ?? {}, availableCores: Number(body.limits?.cpuCores ?? 0), availableMemoryBytes: Number(body.limits?.memoryBytes ?? 0), gpuNames: Array.isArray(body.gpuNames) ? body.gpuNames.slice(0, 16) : [], cpuModel: String(body.cpuModel ?? "").slice(0, 120), capturedAt: now() };
    await ddb.send(new PutCommand({ TableName: tables.providers, Item: item }));
    const { ownerSub, ...publicItem } = item;
    return reply(200, publicItem);
  }
  if (path === "/providers/me" && method === "DELETE") {
    const body = parseBody(event);
    const item = await assertProvider(String(body.nodeId ?? ""), actor);
    await ddb.send(new UpdateCommand({ TableName: tables.providers, Key: { nodeId: item.nodeId }, UpdateExpression: "SET online = :off, heartbeatAt = :now, capturedAt = :now", ExpressionAttributeValues: { ":off": false, ":now": now() } }));
    return reply(200, { online: false, capturedAt: now() });
  }
  if (path === "/netbird/setup-key" && method === "POST") return reply(200, await createSetupKey(actor, String(parseBody(event).role ?? "")));
  if (path === "/netbird/verify-peer" && method === "POST") return reply(200, { enrolled: await isManagedPeer(String(parseBody(event).ip ?? "")) });
  if (path === "/sessions/netbird" && method === "POST") return reply(200, await establishSessionNetwork(actor, event));
  if (path === "/sessions/netbird" && method === "DELETE") return reply(200, await endSessionNetwork(actor, event));
  if (path === "/negotiations" && method === "GET") {
    const items = await all(tables.sessions, (s) => s.consumerSub === actor.sub || s.providerSub === actor.sub);
    const withProvider = await Promise.all(items.map(async (item) => {
      const provider = (await ddb.send(new GetCommand({ TableName: tables.providers, Key: { nodeId: item.providerId } }))).Item;
      return { ...item, id: item.sessionId, provider: provider ? { id: provider.nodeId, peerId: provider.netbirdPeerId || provider.nodeId, netbirdIp: provider.netbirdIp, displayName: provider.displayName } : null };
    }));
    return reply(200, withProvider.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  }
  if (path === "/negotiations" && method === "POST") {
    const body = parseBody(event);
    const provider = await ddb.send(new GetCommand({ TableName: tables.providers, Key: { nodeId: String(body.providerId ?? "") } }));
    if (!provider.Item || provider.Item.online !== true || Date.now() - Date.parse(provider.Item.heartbeatAt ?? "") > onlineWindowMs) throw Object.assign(new Error("This provider is offline. Refresh the provider list and choose an online provider."), { statusCode: 409 });
    const limits = body.limits ?? {};
    const cpu = Number(limits.cpuCores ?? 0), memory = Number(limits.memoryBytes ?? 0), duration = Number(body.durationMinutes ?? 0);
    if (!Number.isInteger(cpu) || cpu < 1 || cpu > Number(provider.Item.availableCores) || !Number.isFinite(memory) || memory < 1 || memory > Number(provider.Item.availableMemoryBytes) || !Number.isInteger(duration) || duration < 1 || duration > 10080) throw Object.assign(new Error("Requested resources or duration exceed this provider’s advertised limits."), { statusCode: 400 });
    const gpuIds = Array.isArray(limits.gpuIds) ? [...new Set(limits.gpuIds.filter((id) => typeof id === "string"))] : [];
    const offeredGpuIds = Array.isArray(provider.Item.limits?.gpuIds) ? provider.Item.limits.gpuIds : [];
    if (gpuIds.length !== (Array.isArray(limits.gpuIds) ? limits.gpuIds.length : 0) || gpuIds.some((id) => !offeredGpuIds.includes(id))) throw Object.assign(new Error("The proposal requests a GPU that this provider did not offer."), { statusCode: 400 });
    const id = randomUUID(); const createdAt = now();
    const proposal = { cpuCores: cpu, memoryBytes: memory, gpuIds, durationMinutes: duration, priceAmount: 0, currency: "USD", state: "open" };
    const item = { sessionId: id, conversationId: id, providerId: provider.Item.nodeId, providerSub: provider.Item.ownerSub, providerName: provider.Item.displayName, consumerSub: actor.sub, consumer: actor.email, consumerName: actor.name, requestedLimits: limits, durationMinutes: duration, workloadDescription: String(body.workloadDescription ?? "").slice(0, 2000), proposal, state: "open", createdAt, updatedAt: createdAt };
    await ddb.send(new PutCommand({ TableName: tables.sessions, Item: item, ConditionExpression: "attribute_not_exists(sessionId)" }));
    await ddb.send(new PutCommand({ TableName: tables.conversations, Item: { conversationId: id, sessionId: id, providerId: item.providerId, providerSub: item.providerSub, consumerSub: actor.sub, createdAt } }));
    await saveMessage(id, actor, `Resource proposal: ${cpu} CPU core(s), ${(memory / 1024 ** 3).toFixed(1)} GiB RAM for ${duration} minutes.`, proposal);
    const { ownerSub, ...providerPublic } = provider.Item;
    return reply(201, { ...item, id: item.sessionId, provider: { ...providerPublic, id: providerPublic.nodeId, peerId: providerPublic.netbirdPeerId || providerPublic.nodeId } });
  }
  const decisionMatch = path.match(/^\/negotiations\/([^/]+)\/decision$/);
  if (decisionMatch && method === "POST") {
    const id = decodeURIComponent(decisionMatch[1]); const item = await getSession(id); assertParticipant(item, actor);
    if (item.providerSub !== actor.sub) throw Object.assign(new Error("Only the selected provider can accept or reject this proposal."), { statusCode: 403 });
    if (item.state !== "open") throw Object.assign(new Error("This negotiation already has a decision."), { statusCode: 409 });
    const decision = String(parseBody(event).decision ?? "");
    if (decision !== "accept" && decision !== "reject") throw Object.assign(new Error("Decision must be accept or reject."), { statusCode: 400 });
    const updatedAt = now();
    await ddb.send(new UpdateCommand({ TableName: tables.sessions, Key: { sessionId: id }, UpdateExpression: "SET #state = :state, updatedAt = :now, decisionBy = :sub", ConditionExpression: "#state = :open AND providerSub = :sub", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":state": decision === "accept" ? "accepted" : "rejected", ":open": "open", ":now": updatedAt, ":sub": actor.sub } }));
    if (item.proposal) item.proposal.state = decision === "accept" ? "accepted" : "rejected";
    await ddb.send(new UpdateCommand({ TableName: tables.sessions, Key: { sessionId: id }, UpdateExpression: "SET proposal = :proposal", ExpressionAttributeValues: { ":proposal": item.proposal ?? {} } }));
    await saveMessage(id, actor, `Provider ${decision}ed the proposal.`);
    return reply(200, { ...item, state: decision === "accept" ? "accepted" : "rejected", updatedAt, proposal: item.proposal });
  }
  const messagesMatch = path.match(/^\/negotiations\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const id = decodeURIComponent(messagesMatch[1]); const item = await getSession(id); assertParticipant(item, actor);
    if (method === "GET") {
      const list = await messagesFor(id);
      return reply(200, list.map(({ senderSub, ...m }) => ({ ...m, sender: senderSub === item.consumerSub ? "consumer" : "provider" })));
    }
    if (method === "POST") {
      const message = await saveMessage(id, actor, parseBody(event).text);
      const { senderSub, ...publicMessage } = message;
      await ddb.send(new UpdateCommand({ TableName: tables.sessions, Key: { sessionId: id }, UpdateExpression: "SET updatedAt = :now", ExpressionAttributeValues: { ":now": message.createdAt } }));
      return reply(201, { ...publicMessage, sender: actor.sub === item.consumerSub ? "consumer" : "provider" });
    }
  }
  return reply(404, { message: "Route not found." });
}

export const handler = async (event) => {
  if (event?.source === "computepool.cleanup") {
    try { return await cleanupExpiredSessions(); }
    catch (error) { console.error("Expired network grant cleanup failed", error?.name ?? "Error", error?.message ?? "Unknown error"); throw error; }
  }
  try { return await handle(event); }
  catch (error) {
    const statusCode = Number(error?.statusCode ?? 500);
    if (statusCode >= 500) console.error("Marketplace request failed", JSON.stringify({ requestId: event?.requestContext?.requestId ?? "unknown", method: event?.requestContext?.http?.method ?? "unknown", path: event?.rawPath ?? "unknown", name: error?.name ?? "Error", message: error?.message ?? "Unknown error" }));
    return reply(statusCode, { message: statusCode >= 500 ? "The ComputePool service could not complete this request." : error.message });
  }
};

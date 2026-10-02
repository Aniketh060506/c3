'use strict';

/**
 * core/p2p-coordinator.js
 * Pure decentralized peer-to-peer discovery and cluster handshake coordinator.
 * Replaces AWS Cognito & DynamoDB with local LAN/Mesh UDP broadcast and direct HTTP RPC.
 * Zero cloud dependency — works offline, on local Wi-Fi, or over Tailscale WireGuard.
 */

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const tailscale = require('./tailscale');

const HTTP_PORT = 44344;
const UDP_PORT = 44345;

class P2PCoordinator {
  constructor() {
    this.localNode = {
      userId: '',
      displayName: '',
      ip: '127.0.0.1',
      specs: null,
    };
    this.isSharing = false;
    this.httpServer = null;
    this.udpSocket = null;
    this.broadcastTimer = null;
    this.pruneTimer = null;
    this.tailscaleScanTimer = null;

    // Discovered provider nodes: Map<userId, ProviderInfo>
    this.discoveredProviders = new Map();

    // Pending cluster requests: Map<sessionId, { resolve, reject, timer }>
    this.pendingSessionRequests = new Map();

    // Event hooks
    this.onRequestReceived = null; // (req) => void
    this.onStatusChanged = null;  // (providers) => void
  }

  /**
   * Initializes the P2P coordinator with local node identity.
   */
  async start({ userId, displayName, specs }) {
    this.localNode.userId = userId || `node-${Date.now().toString(36)}`;
    this.localNode.displayName = displayName || os.hostname() || 'Compute Node';
    this.localNode.specs = specs || {};

    const ipInfo = await tailscale.getConnectableIp();
    this.localNode.ip = ipInfo.ip;

    await this.startHttpServer();
    await this.startUdpSocket();

    // Start background prune timer (remove offline nodes after 6s)
    this.pruneTimer = setInterval(() => this.pruneStaleProviders(), 3000);

    // Scan Tailscale peers periodically if Tailscale is active
    this.tailscaleScanTimer = setInterval(() => this.scanTailscalePeers(), 8000);
    this.scanTailscalePeers();

    console.log(`[P2P] Coordinator started for "${this.localNode.displayName}" (${this.localNode.ip})`);
  }

  updateProfile({ displayName, specs }) {
    if (displayName) this.localNode.displayName = displayName;
    if (specs) this.localNode.specs = specs;
  }

  setSharing(active) {
    this.isSharing = Boolean(active);
    if (this.isSharing) {
      this.broadcastAnnounce();
      if (!this.broadcastTimer) {
        this.broadcastTimer = setInterval(() => this.broadcastAnnounce(), 2000);
      }
      console.log(`[P2P] Node "${this.localNode.displayName}" started sharing resources.`);
    } else {
      if (this.broadcastTimer) {
        clearInterval(this.broadcastTimer);
        this.broadcastTimer = null;
      }
      this.broadcastOffline();
      console.log(`[P2P] Node "${this.localNode.displayName}" stopped sharing.`);
    }
  }

  // ── HTTP Server ────────────────────────────────────────────────────────────
  async startHttpServer() {
    if (this.httpServer) return;

    this.httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

        // GET /api/ping
        if (req.method === 'GET' && url.pathname === '/api/ping') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            userId: this.localNode.userId,
            displayName: this.localNode.displayName,
            ip: this.localNode.ip,
            port: HTTP_PORT,
            isSharing: this.isSharing,
            specs: this.localNode.specs,
          }));
          return;
        }

        // POST /api/cluster/request (Consumer requesting to join provider)
        if (req.method === 'POST' && url.pathname === '/api/cluster/request') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (!this.isSharing) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Provider is not currently sharing resources.' }));
                return;
              }

              console.log(`[P2P] Received cluster join request from ${data.consumerName || data.consumerId} (${data.consumerIp})`);
              if (this.onRequestReceived) {
                this.onRequestReceived(data);
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, status: 'RECEIVED' }));
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: e.message }));
            }
          });
          return;
        }

        // POST /api/cluster/response (Provider accepted/declined join request)
        if (req.method === 'POST' && url.pathname === '/api/cluster/response') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              const pending = this.pendingSessionRequests.get(data.sessionId);
              if (pending) {
                clearTimeout(pending.timer);
                this.pendingSessionRequests.delete(data.sessionId);
                pending.resolve(data);
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: e.message }));
            }
          });
          return;
        }

        // GET /api/workspace/files (Serve workspace files to provider)
        if (req.method === 'GET' && url.pathname === '/api/workspace/files') {
          const wsDir = this.activeWorkspace;
          if (!wsDir || !fs.existsSync(wsDir)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'No active workspace configured' }));
            return;
          }

          try {
            const files = {};
            const entries = fs.readdirSync(wsDir, { withFileTypes: true });
            for (const ent of entries) {
              if (ent.isFile()) {
                const fullPath = path.join(wsDir, ent.name);
                const stats = fs.statSync(fullPath);
                // Only sync files under 10MB
                if (stats.size < 10 * 1024 * 1024) {
                  files[ent.name] = fs.readFileSync(fullPath).toString('base64');
                }
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, files }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (outerErr) {
        // Safety net: ensure no request is ever left hanging
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ ok: false, error: outerErr.message }));
        } catch (_) {}
      }
    });

    return new Promise((resolve) => {
      this.httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
        resolve();
      });
      this.httpServer.on('error', (err) => {
        console.warn(`[P2P] HTTP server notice: ${err.message}`);
        resolve();
      });
    });
  }

  // ── UDP Broadcast ──────────────────────────────────────────────────────────
  async startUdpSocket() {
    if (this.udpSocket) return;

    this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.udpSocket.on('message', (msg, rinfo) => {
      try {
        const payload = JSON.parse(msg.toString('utf-8'));
        if (payload.userId === this.localNode.userId) return; // Ignore self

        if (payload.type === 'PROVIDER_ANNOUNCE') {
          const provider = {
            userId: payload.userId,
            displayName: payload.displayName || 'Compute Node',
            ip: payload.ip || rinfo.address,
            port: payload.port || HTTP_PORT,
            specs: payload.specs || {},
            cpuCores: payload.specs?.cpuCores || 0,
            cpuModel: payload.specs?.cpuModel || 'CPU',
            ramGb: payload.specs?.ramGb || 0,
            ramType: payload.specs?.ramType || '',
            ramSpeed: payload.specs?.ramSpeed || '',
            ramManufacturer: payload.specs?.ramManufacturer || '',
            gpu: payload.specs?.gpu || 'None',
            gpuModel: payload.specs?.gpuModel || 'None',
            gpuVramGb: payload.specs?.gpuVramGb || 0,
            status: 'ONLINE',
            lastSeen: Date.now(),
          };

          this.discoveredProviders.set(provider.userId, provider);
          this.notifyStatus();
        } else if (payload.type === 'PROVIDER_OFFLINE') {
          this.discoveredProviders.delete(payload.userId);
          this.notifyStatus();
        }
      } catch (_) {}
    });

    return new Promise((resolve) => {
      this.udpSocket.bind(UDP_PORT, '0.0.0.0', () => {
        try {
          this.udpSocket.setBroadcast(true);
        } catch (_) {}
        resolve();
      });
      this.udpSocket.on('error', (err) => {
        console.warn(`[P2P] UDP socket notice: ${err.message}`);
        resolve();
      });
    });
  }

  broadcastAnnounce() {
    if (!this.udpSocket) return;
    const packet = JSON.stringify({
      type: 'PROVIDER_ANNOUNCE',
      userId: this.localNode.userId,
      displayName: this.localNode.displayName,
      ip: this.localNode.ip,
      port: HTTP_PORT,
      specs: this.localNode.specs,
      timestamp: Date.now(),
    });

    const buf = Buffer.from(packet, 'utf-8');
    // Broadcast to global subnet
    try {
      this.udpSocket.send(buf, 0, buf.length, UDP_PORT, '255.255.255.255');
    } catch (_) {}

    // Broadcast across all local subnet broadcast addresses
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const net of ifaces[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          try {
            // Estimate subnet broadcast e.g. 192.168.1.255
            const parts = net.address.split('.');
            parts[3] = '255';
            const bcast = parts.join('.');
            this.udpSocket.send(buf, 0, buf.length, UDP_PORT, bcast);
          } catch (_) {}
        }
      }
    }
  }

  broadcastOffline() {
    if (!this.udpSocket) return;
    const packet = JSON.stringify({
      type: 'PROVIDER_OFFLINE',
      userId: this.localNode.userId,
    });
    const buf = Buffer.from(packet, 'utf-8');
    try {
      this.udpSocket.send(buf, 0, buf.length, UDP_PORT, '255.255.255.255');
    } catch (_) {}
  }

  pruneStaleProviders() {
    const now = Date.now();
    let changed = false;
    for (const [id, node] of this.discoveredProviders.entries()) {
      if (now - node.lastSeen > 6000) {
        this.discoveredProviders.delete(id);
        changed = true;
      }
    }
    if (changed) this.notifyStatus();
  }

  notifyStatus() {
    if (this.onStatusChanged) {
      this.onStatusChanged(this.getAvailableProviders());
    }
  }

  getAvailableProviders() {
    return Array.from(this.discoveredProviders.values()).filter(p => p.status === 'ONLINE');
  }

  // ── Manual & Tailscale Peer Probing ───────────────────────────────────────
  async pingPeer(ip, port = HTTP_PORT) {
    if (!ip) return null;
    return new Promise((resolve) => {
      const req = http.get(`http://${ip}:${port}/api/ping`, { timeout: 2000 }, (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.ok && data.userId !== this.localNode.userId) {
              const provider = {
                userId: data.userId,
                displayName: data.displayName || 'Compute Node',
                ip: data.ip || ip,
                port: data.port || port,
                specs: data.specs || {},
                cpuCores: data.specs?.cpuCores || 0,
                cpuModel: data.specs?.cpuModel || 'CPU',
                ramGb: data.specs?.ramGb || 0,
                ramType: data.specs?.ramType || '',
                ramSpeed: data.specs?.ramSpeed || '',
                ramManufacturer: data.specs?.ramManufacturer || '',
                gpu: data.specs?.gpu || 'None',
                gpuModel: data.specs?.gpuModel || 'None',
                gpuVramGb: data.specs?.gpuVramGb || 0,
                status: data.isSharing ? 'ONLINE' : 'STANDBY',
                lastSeen: Date.now(),
              };

              if (data.isSharing) {
                this.discoveredProviders.set(provider.userId, provider);
                this.notifyStatus();
              }
              resolve(provider);
              return;
            }
          } catch (_) {}
          resolve(null);
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }

  async scanTailscalePeers() {
    try {
      const status = await tailscale.getStatus();
      if (!status || !status.Peer) return;

      const peers = Object.values(status.Peer);
      for (const peer of peers) {
        if (!peer.Online) continue;
        const peerIp = peer.TailscaleIPs?.[0];
        if (peerIp && peerIp !== this.localNode.ip) {
          this.pingPeer(peerIp);
        }
      }
    } catch (_) {}
  }

  // ── Cluster Handshake ──────────────────────────────────────────────────────
  /**
   * Consumer sends join request directly to provider.
   */
  async requestJoinCluster({ providerId, providerIp, providerPort = HTTP_PORT, sessionId, workspacePath, masterIp, clusterToken }) {
    const payload = JSON.stringify({
      sessionId,
      consumerId: this.localNode.userId,
      consumerName: this.localNode.displayName,
      consumerIp: this.localNode.ip,
      masterIp: masterIp || this.localNode.ip,   // ← FIX: send masterIp so worker knows where to connect
      clusterToken: clusterToken || '',           // ← FIX: send token so worker can authenticate
      workspacePath,
    });

    return new Promise((resolve, reject) => {
      // 30s timeout waiting for user to click Accept on the provider laptop
      const timer = setTimeout(() => {
        this.pendingSessionRequests.delete(sessionId);
        reject(new Error(`Timed out waiting for response from provider (${providerIp})`));
      }, 30000);

      this.pendingSessionRequests.set(sessionId, { resolve, reject, timer });

      const req = http.request({
        hostname: providerIp,
        port: providerPort,
        path: '/api/cluster/request',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const r = JSON.parse(body);
            if (!r.ok) {
              clearTimeout(timer);
              this.pendingSessionRequests.delete(sessionId);
              reject(new Error(r.error || 'Provider rejected request'));
            }
          } catch (e) {
            clearTimeout(timer);
            this.pendingSessionRequests.delete(sessionId);
            reject(e);
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        this.pendingSessionRequests.delete(sessionId);
        reject(new Error(`Could not connect to provider at ${providerIp}:${providerPort} — ${err.message}`));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Provider replies to consumer with accept/decline.
   */
  async replyJoinRequest({ consumerIp, consumerPort = HTTP_PORT, sessionId, accepted, masterToken, masterIp }) {
    const payload = JSON.stringify({
      sessionId,
      providerId: this.localNode.userId,
      providerName: this.localNode.displayName,
      accepted,
      masterToken,
      masterIp: masterIp || this.localNode.ip,
    });

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: consumerIp,
        port: consumerPort,
        path: '/api/cluster/response',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
      }, (res) => {
        resolve();
      });

      req.on('error', (err) => {
        console.warn(`[P2P] Failed to send reply to consumer ${consumerIp}: ${err.message}`);
        resolve(); // Don't throw
      });

      req.write(payload);
      req.end();
    });
  }

  setActiveWorkspace(wsPath) {
    this.activeWorkspace = wsPath;
  }

  async syncWorkspaceFromConsumer({ consumerIp, targetDir }) {
    if (!consumerIp || !targetDir) return false;
    const fs = require('fs');
    const path = require('path');
    const http = require('http');

    return new Promise((resolve) => {
      const req = http.get(`http://${consumerIp}:${HTTP_PORT}/api/workspace/files`, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.ok && data.files) {
              if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
              }
              const count = Object.keys(data.files).length;
              for (const [filename, b64Content] of Object.entries(data.files)) {
                const dest = path.join(targetDir, filename);
                fs.writeFileSync(dest, Buffer.from(b64Content, 'base64'));
              }
              console.log(`[P2P] Synced ${count} file(s) from consumer to ${targetDir}`);
              resolve(true);
            } else {
              resolve(false);
            }
          } catch (_) {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    });
  }

  stop() {
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.tailscaleScanTimer) clearInterval(this.tailscaleScanTimer);
    if (this.isSharing) this.broadcastOffline();
    if (this.httpServer) {
      try { this.httpServer.close(); } catch (_) {}
    }
    if (this.udpSocket) {
      try { this.udpSocket.close(); } catch (_) {}
    }
  }
}

module.exports = new P2PCoordinator();

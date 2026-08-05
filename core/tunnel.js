const { Client } = require('ssh2');
const net = require('net');

let currentTunnelClient = null;
let reconnectTimer = null;
let retryCount = 0;
const MAX_RETRIES = 5;

async function startTunnel(localPort) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    currentTunnelClient = conn;

    conn.on('ready', () => {
      retryCount = 0; // Reset retries on successful connection
      
      conn.forwardIn('serveo.net', 0, (err, port) => {
        if (err || !port) {
          console.warn('[C3 Tunnel] Serveo bind failed, falling back to local connection:', err?.message);
          conn.end();
          return resolve({ host: '127.0.0.1', port: localPort });
        }
        
        console.log(`Tunnel established: serveo.net:${port} -> localhost:${localPort}`);
        resolve({ host: 'serveo.net', port: port });
      });
    });

    conn.on('tcp connection', (info, accept, reject) => {
      const srcSocket = net.connect(localPort, '127.0.0.1', () => {
        const tunnelStream = accept();
        srcSocket.pipe(tunnelStream).pipe(srcSocket);
      });
      
      srcSocket.on('error', (err) => {
        console.error('Tunnel local socket error:', err);
        reject();
      });
    });

    conn.on('error', (err) => {
      console.error('Tunnel error:', err);
      // Let close handler deal with reconnect
    });

    conn.on('close', () => {
      console.log('Tunnel connection closed');
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`Reconnecting tunnel in 3 seconds... (Attempt ${retryCount}/${MAX_RETRIES})`);
        reconnectTimer = setTimeout(() => {
          startTunnel(localPort).catch(err => console.error("Tunnel reconnect failed:", err));
        }, 3000);
      }
    });

    conn.connect({
      host: 'serveo.net',
      port: 22,
      username: 'serveo',
      tryKeyboard: true, // Bypass some strict auth checks
      readyTimeout: 8000
    });
  });
}

function stopTunnel() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (currentTunnelClient) {
    currentTunnelClient.end();
    currentTunnelClient = null;
  }
  retryCount = 0;
}

module.exports = {
  startTunnel,
  stopTunnel
};

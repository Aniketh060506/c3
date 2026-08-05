const { Client } = require('ssh2');

let sshConn = null;
let sshStream = null;
let sftpSession = null;
let telemetryInterval = null;

async function connect(host, port, privateKeyPem, onData, onClose) {
  return new Promise((resolve, reject) => {
    sshConn = new Client();
    
    sshConn.on('ready', () => {
      sshConn.shell({ term: 'xterm-256color', cols: 220, rows: 50 }, (err, stream) => {
        if (err) {
          sshConn.end();
          return reject(err);
        }
        
        sshStream = stream;
        
        stream.on('data', (data) => {
          if (onData) onData(data.toString());
        }).on('close', () => {
          if (onClose) onClose();
          sshConn.end();
        });
        
        resolve(true);
      });
    });
    
    const tryConnect = (user) => {
      sshConn.connect({
        host,
        port,
        username: user,
        privateKey: privateKeyPem,
        readyTimeout: 10000
      });
    };

    sshConn.on('error', (err) => {
      console.error('[C3 SSH] Connection error:', err);
      // Try root if c3user failed
      if (sshConn._user !== 'root') {
        sshConn._user = 'root';
        tryConnect('root');
      } else {
        reject(err);
      }
    });

    sshConn._user = 'c3user';
    tryConnect('c3user');
  });
}

function sendInput(text) {
  if (sshStream) {
    sshStream.write(text);
  }
}

function resizeTerminal(cols, rows) {
  if (sshStream) {
    sshStream.setWindow(rows, cols);
  }
}

function startTelemetry(onMetrics) {
  if (telemetryInterval) {
    clearInterval(telemetryInterval);
  }
  
  telemetryInterval = setInterval(() => {
    if (!sshConn) return;
    
    sshConn.exec("top -bn1 | grep 'Cpu(s)' && free -m", (err, stream) => {
      if (err) return;
      
      let output = '';
      stream.on('data', (data) => {
        output += data.toString();
      }).on('close', () => {
        try {
          const lines = output.trim().split('\n');
          let cpuPct = 0;
          let ramUsedMB = 0;
          let ramTotalMB = 0;
          
          if (lines[0] && lines[0].includes('Cpu(s)')) {
            const match = lines[0].match(/(\d+\.\d+)\s+us/);
            if (match) cpuPct = parseFloat(match[1]);
          }
          
          const memLine = lines.find(l => l.startsWith('Mem:'));
          if (memLine) {
            const parts = memLine.split(/\s+/);
            ramTotalMB = parseInt(parts[1], 10);
            ramUsedMB = parseInt(parts[2], 10);
          }
          
          if (onMetrics) {
            onMetrics({ cpuPct, ramUsedMB, ramTotalMB });
          }
        } catch (e) {
          console.error("Telemetry parse error", e);
        }
      });
    });
  }, 3000);
}

function stopTelemetry() {
  if (telemetryInterval) {
    clearInterval(telemetryInterval);
    telemetryInterval = null;
  }
}

async function openSftp() {
  return new Promise((resolve, reject) => {
    if (!sshConn) return reject(new Error("SSH not connected"));
    
    sshConn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftpSession = sftp;
      resolve();
    });
  });
}

async function listFiles(remotePath) {
  return new Promise((resolve, reject) => {
    if (!sftpSession) return reject(new Error("SFTP not initialized"));
    
    sftpSession.readdir(remotePath, (err, list) => {
      if (err) return reject(err);
      resolve(list);
    });
  });
}

async function uploadFile(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    if (!sftpSession) return reject(new Error("SFTP not initialized"));
    
    sftpSession.fastPut(localPath, remotePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

async function downloadFile(remotePath, localPath) {
  return new Promise((resolve, reject) => {
    if (!sftpSession) return reject(new Error("SFTP not initialized"));
    
    sftpSession.fastGet(remotePath, localPath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function disconnect() {
  stopTelemetry();
  if (sshConn) {
    sshConn.end();
    sshConn = null;
  }
  sshStream = null;
  sftpSession = null;
}

module.exports = {
  connect,
  sendInput,
  resizeTerminal,
  startTelemetry,
  stopTelemetry,
  openSftp,
  listFiles,
  uploadFile,
  downloadFile,
  disconnect
};

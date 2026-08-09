import React, { useState, useEffect, useRef } from 'react';
import SimplePeer from 'simple-peer';
import 'xterm/css/xterm.css';

export default function SSHWorkspace({ sessionId, provider, onEnd }) {
  const [telemetry, setTelemetry] = useState({ cpu: 0, ram: 0 });
  const [elapsed, setElapsed] = useState('00:00:00');
  const [status, setStatus] = useState('Connecting via WebRTC...');
  const [errorMsg, setErrorMsg] = useState(null);
  
  // New state variables for File Manager
  const [remotePath, setRemotePath] = useState('/workspace/');
  const [transferLog, setTransferLog] = useState([]);
  const [downloadBuffers, setDownloadBuffers] = useState({});
  const [uploadDir, setUploadDir] = useState('/workspace/');
  const [uploading, setUploading] = useState(false);

  const termRef = useRef(null);
  const startTime = useRef(Date.now());
  const peerRef = useRef(null);
  const xtermObj = useRef(null);

  const handleUpload = async () => {
    if (!peerRef.current?.connected) return;
    if (!window.c3?.pickFileForUpload) return;
    setUploading(true);
    const file = await window.c3.pickFileForUpload();
    if (!file) { setUploading(false); return; }
    setTransferLog(prev => [{ dir: 'up', name: file.name, size: file.size, status: 'Uploading...' }, ...prev.slice(0, 9)]);
    const CHUNK = 32768;
    const dir = uploadDir.trim() || '/workspace/';
    const destPath = dir.endsWith('/') ? dir + file.name : dir + '/' + file.name;
    peerRef.current.send(JSON.stringify({ t: 'upload_start', name: file.name, size: file.size, destPath }));
    const b64 = file.base64;
    for (let i = 0; i < b64.length; i += CHUNK) {
      peerRef.current.send(JSON.stringify({ t: 'upload_chunk', name: file.name, chunk: b64.slice(i, i + CHUNK), seq: Math.floor(i / CHUNK) }));
    }
    peerRef.current.send(JSON.stringify({ t: 'upload_end', name: file.name }));
    setTransferLog(prev => prev.map(t => t.name === file.name ? { ...t, status: 'Done ✓' } : t));
    setUploading(false);
  };

  const handleDownload = () => {
    if (!peerRef.current?.connected || !remotePath.trim()) return;
    peerRef.current.send(JSON.stringify({ t: 'download_req', path: remotePath.trim() }));
  };

  useEffect(() => {
    let term, fit;
    let resizeObserver;
    
    const initWorkspace = async () => {
      try {
        const { Terminal } = await import('xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        
        term = new Terminal({
          theme: { background: '#09090d', foreground: '#f8fafc', cursor: '#22c55e', selectionBackground: 'rgba(255,255,255,0.2)' },
          fontFamily: "'JetBrains Mono', 'Consolas', 'Courier New', monospace",
          fontSize: 13,
          lineHeight: 1.35,
          cursorBlink: true,
          convertEol: true,
          scrollback: 5000,
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(termRef.current);
        fit.fit();
        xtermObj.current = term;
        
        term.onData(d => {
          if (peerRef.current && peerRef.current.connected) {
            peerRef.current.send(JSON.stringify({ t: 'd', d }));
          }
        });

        resizeObserver = new ResizeObserver(() => {
          fit.fit();
          if (peerRef.current && peerRef.current.connected) {
            peerRef.current.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
          }
        });
        resizeObserver.observe(termRef.current);

        if (!window.c3) {
          term.write('C3 Desktop environment required.\r\n$ ');
          return;
        }

        setStatus('Fetching SDP offer from provider...');
        const res = await window.c3.connectTerminal(sessionId);
        if (!res || !res.offer) {
          throw new Error('Provider offer not found');
        }

        setStatus('Connecting P2P channel...');

        const peer = new SimplePeer({
          initiator: false,
          trickle: false,
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' },
              { urls: 'stun:global.stun.twilio.com:3478' }
            ]
          }
        });
        peerRef.current = peer;

        peer.on('signal', answerData => {
          console.log('[WebRTC User] Answer generated, sending to provider...');
          window.c3.sendUserAnswer({ sessionId, answer: JSON.stringify(answerData) });
        });

        peer.on('connect', () => {
          console.log('[WebRTC User] Connected to provider!');
          setStatus('Connected via WebRTC (P2P encrypted)');
          term.write('\r\n\x1b[32m[C3] P2P WebRTC connection established!\x1b[0m\r\n\r\n');
          peer.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
        });

        peer.on('data', rawData => {
          try {
            const msg = JSON.parse(rawData);
            if (msg.t === 'd' && msg.d) {
              term.write(msg.d);
            }
            if (msg.t === 'download_start') {
              setDownloadBuffers(prev => ({ ...prev, [msg.name]: { chunks: [], name: msg.name } }));
              setTransferLog(prev => [{ dir: 'down', name: msg.name, status: 'Downloading...' }, ...prev.slice(0, 9)]);
            }
            if (msg.t === 'download_chunk') {
              setDownloadBuffers(prev => {
                const existing = prev[msg.name] || { chunks: [], name: msg.name };
                return { ...prev, [msg.name]: { ...existing, chunks: [...existing.chunks, msg.chunk] } };
              });
            }
            if (msg.t === 'download_end') {
              setDownloadBuffers(prev => {
                const buf = prev[msg.name];
                if (buf) {
                  const fullBase64 = buf.chunks.join('');
                  window.c3?.saveDownloadedFile({ name: msg.name, base64: fullBase64 });
                  setTransferLog(tl => tl.map(t => t.name === msg.name ? { ...t, status: 'Done ✓' } : t));
                }
                const next = { ...prev };
                delete next[msg.name];
                return next;
              });
            }
          } catch (e) {
            console.error("Invalid WebRTC chunk:", e);
          }
        });

        peer.on('close', () => {
          setStatus('Disconnected');
          term.write('\r\n\x1b[31m[C3] Session closed.\x1b[0m\r\n');
        });

        peer.on('error', err => {
          console.error('[WebRTC User] Peer error:', err);
          setStatus('Error: ' + err.message);
          setErrorMsg(err.message);
        });

        peer.signal(JSON.parse(res.offer));

      } catch (e) {
        console.error("Failed to connect WebRTC terminal:", e);
        setStatus('Connection failed');
        setErrorMsg(e.message);
      }
    };
    
    initWorkspace();

    const timer = setInterval(() => {
      const diff = Math.floor((Date.now() - startTime.current) / 1000);
      const h = String(Math.floor(diff / 3600)).padStart(2, '0');
      const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
      const s = String(diff % 60).padStart(2, '0');
      setElapsed(`${h}:${m}:${s}`);
    }, 1000);

    return () => {
      clearInterval(timer);
      if (peerRef.current) peerRef.current.destroy();
      if (term) term.dispose();
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [sessionId]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#09090c', padding: 24, boxSizing: 'border-box' }}>
      
      {/* Top Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, background: '#111119', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 16, padding: '14px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: status.includes('Connected') ? '#22c55e' : '#f59e0b', boxShadow: status.includes('Connected') ? '0 0 10px rgba(34,197,94,0.6)' : 'none' }} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, color: '#f8fafc' }}>
              {provider?.displayName || 'Remote Node'} • <span style={{ color: status.includes('Connected') ? '#34d399' : '#f59e0b' }}>{status}</span>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
              Session ID: {sessionId} • Duration: {elapsed}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => {
            if (window.c3?.endSession) window.c3.endSession(sessionId).catch(() => {});
            onEnd();
          }} className="btn btn-danger btn-sm" style={{ padding: '8px 16px', borderRadius: 10, fontSize: 12, fontWeight: 700 }}>
            ✕ End Session
          </button>
        </div>
      </div>

      {/* Main Terminal Split View */}
      <div style={{ flex: 1, display: 'flex', gap: 16, overflow: 'hidden' }}>
        
        {/* Terminal Box (70%) */}
        <div className="terminal-shell" style={{ width: '70%', display: 'flex', flexDirection: 'column', background: '#000', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden' }}>
          <div className="terminal-titlebar" style={{ padding: '10px 16px', background: '#0a0a0f', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <div className="mac-dot red" style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444' }} />
              <div className="mac-dot yellow" style={{ width: 10, height: 10, borderRadius: '50%', background: '#f59e0b' }} />
              <div className="mac-dot green" style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e' }} />
            </div>
            <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace', marginLeft: 8 }}>bash — ubuntu@c3-container</span>
          </div>

          <div style={{ flex: 1, padding: 12, overflow: 'hidden' }} ref={termRef} />
        </div>

        {/* File Manager Box (30%) */}
        <div style={{ width: '30%', display: 'flex', flexDirection: 'column', background: '#0e0e12', borderLeft: '1px solid rgba(255,255,255,0.07)', borderRadius: 16, padding: 16, boxSizing: 'border-box' }}>
          <div style={{ fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', color: '#52525b', marginBottom: 16 }}>
            📁 File Transfer
          </div>
          
          {!status.includes('Connected') ? (
            <div style={{ color: '#64748b', fontSize: 12, textAlign: 'center', marginTop: 32 }}>
              Connect to a session first
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, overflow: 'hidden' }}>
              {/* Upload Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: '#a1a1aa', fontWeight: 600 }}>Upload Target Directory</div>
                <input
                  type="text"
                  value={uploadDir}
                  onChange={(e) => setUploadDir(e.target.value)}
                  placeholder="/workspace/"
                  style={{ background: '#222228', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 8, padding: '8px 12px', fontSize: 12, outline: 'none' }}
                />
                <button 
                  onClick={handleUpload}
                  disabled={uploading}
                  style={{ width: '100%', background: '#fff', color: '#000', border: 'none', borderRadius: 8, padding: '10px 16px', fontWeight: 'bold', cursor: uploading ? 'not-allowed' : 'pointer' }}
                >
                  {uploading ? 'Uploading...' : '↑ Upload Local File'}
                </button>
              </div>

              {/* Download Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: '#a1a1aa', fontWeight: 600 }}>Download File or Folder</div>
                <input
                  type="text"
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value)}
                  placeholder="/workspace/filename or /workspace/myfolder"
                  style={{ background: '#222228', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 8, padding: '8px 12px', fontSize: 12, outline: 'none' }}
                />
                <button 
                  onClick={handleDownload}
                  style={{ width: '100%', background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '10px 16px', fontWeight: 'bold', cursor: 'pointer' }}
                >
                  ↓ Download File / Folder
                </button>
              </div>

              {/* Transfer Log */}
              <div style={{ flex: 1, marginTop: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase', color: '#52525b', marginBottom: 8 }}>
                  Recent Transfers
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {transferLog.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#52525b' }}>No recent transfers</div>
                  ) : (
                    transferLog.map((log, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, fontFamily: 'monospace' }}>
                        <div style={{ color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '70%' }} title={log.name}>
                          {log.dir === 'up' ? '⬆️' : '⬇️'} {log.name} {log.size ? `(${Math.round(log.size / 1024)}KB)` : ''}
                        </div>
                        <div style={{ color: log.status.includes('Done') ? '#22c55e' : '#f59e0b', whiteSpace: 'nowrap' }}>
                          {log.status}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

      </div>

    </div>
  );
}

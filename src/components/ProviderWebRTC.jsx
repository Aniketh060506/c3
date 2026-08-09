import React, { useEffect, useRef, useState } from 'react';
import SimplePeer from 'simple-peer';

export default function ProviderWebRTC({ sessionId, onConnected, onError, onClose }) {
  const [status, setStatus] = useState('Creating WebRTC offer...');
  const [errorMsg, setErrorMsg] = useState('');
  const peerRef = useRef(null);
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    if (!window.c3) return;
    
    sessionIdRef.current = sessionId;

    setStatus('Gathering network STUN candidates...');

    // Instantiate SimplePeer as INITIATOR immediately on mount
    const peer = new SimplePeer({
      initiator: true,
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

    peer.on('signal', data => {
      console.log('[WebRTC] Provider generated offer, storing in DynamoDB...');
      setStatus('Offer saved to DynamoDB — waiting for user answer...');
      window.c3.sendProviderOffer({ sessionId, offer: JSON.stringify(data) })
        .catch(err => {
          console.error('[WebRTC] Failed to send offer:', err);
          setErrorMsg('Failed to store offer: ' + err.message);
        });
    });

    peer.on('connect', () => {
      setStatus('Connected via WebRTC (P2P encrypted)');
      if (onConnected) onConnected();
      console.log('[WebRTC] Provider connected to peer!');
    });

    peer.on('data', data => {
      try {
        const msg = JSON.parse(data);
        if (msg.t === 'd') {
          window.c3.sendPtyInput(msg.d);
        } else if (msg.t === 'r') {
          window.c3.sendPtyResize({ cols: msg.c, rows: msg.r });
        } else if (msg.t === 'upload_start') {
          // start collecting chunks for this file
          window._c3UploadBuffers = window._c3UploadBuffers || {};
          window._c3UploadBuffers[msg.name] = { chunks: [], destPath: msg.destPath };
        } else if (msg.t === 'upload_chunk') {
          if (window._c3UploadBuffers?.[msg.name]) {
            window._c3UploadBuffers[msg.name].chunks.push(msg.chunk);
          }
        } else if (msg.t === 'upload_end') {
          const buf = window._c3UploadBuffers?.[msg.name];
          if (buf) {
            const fullBase64 = buf.chunks.join('');
            // Write to container
            // Get sessionId from prop
            window.c3.containerWriteFile({ sessionId: sessionIdRef.current, destPath: buf.destPath, base64: fullBase64 })
              .then(() => {
                peer.send(JSON.stringify({ t: 'd', d: `\r\n\x1b[32m[C3] File uploaded: ${buf.destPath}\x1b[0m\r\n` }));
                delete window._c3UploadBuffers[msg.name];
              })
              .catch(e => console.error('[C3 Upload] Write failed:', e));
          }
        } else if (msg.t === 'download_req') {
          // Read file from container and send back
          window.c3.containerReadFile({ sessionId: sessionIdRef.current, srcPath: msg.path })
            .then(({ name, base64 }) => {
              const CHUNK_SIZE = 32768; // 32KB chunks in base64
              const totalChunks = Math.ceil(base64.length / CHUNK_SIZE);
              peer.send(JSON.stringify({ t: 'download_start', name, size: base64.length }));
              for (let i = 0; i < totalChunks; i++) {
                const chunk = base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                peer.send(JSON.stringify({ t: 'download_chunk', name, chunk, seq: i }));
              }
              peer.send(JSON.stringify({ t: 'download_end', name }));
            })
            .catch(e => console.error('[C3 Download] Read failed:', e));
        }
      } catch (e) {
        console.error("Invalid WebRTC message received:", e);
      }
    });

    peer.on('close', () => {
      setStatus('Connection closed');
      console.log('[WebRTC] Provider connection closed');
      if (onClose) onClose();
    });

    peer.on('error', err => {
      console.error('[WebRTC] Provider peer error:', err);
      setStatus('Error');
      setErrorMsg(err.message);
      if (onError) onError(err.message);
    });

    // Listen for the user's SDP answer from main process
    const removeAnswerListener = window.c3.onAnswerReceived(({ sessionId: ansSessionId, answer }) => {
      if (ansSessionId === sessionId && peerRef.current && !peerRef.current.destroyed) {
        console.log('[WebRTC] User answer received! Connecting...');
        setStatus('Connecting to user...');
        try {
          peerRef.current.signal(JSON.parse(answer));
        } catch (e) {
          console.error('[WebRTC] Signal error:', e);
        }
      }
    });

    // Listen for PTY stdout data from docker exec stream
    const removePtyListener = window.c3.onPtyData(data => {
      if (peerRef.current && peerRef.current.connected) {
        peerRef.current.send(JSON.stringify({ t: 'd', d: data }));
      }
    });

    return () => {
      console.log('[WebRTC] ProviderWebRTC unmounting, destroying peer...');
      if (peerRef.current) {
        peerRef.current.destroy();
      }
      if (removeAnswerListener) removeAnswerListener();
      if (removePtyListener) removePtyListener();
    };
  }, [sessionId]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px' }}>
      {status === 'Connected via WebRTC (P2P encrypted)' ? (
        <>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#34d399', boxShadow: '0 0 8px rgba(52,211,153,0.6)' }} />
          <div style={{ color: '#34d399', fontSize: 13, fontWeight: 600 }}>{status}</div>
        </>
      ) : status === 'Error' ? (
        <>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#f87171', boxShadow: '0 0 8px rgba(248,113,113,0.6)' }} />
          <div style={{ color: '#f87171', fontSize: 13, fontWeight: 600 }}>{errorMsg}</div>
        </>
      ) : (
        <>
          <div style={{ width: 14, height: 14, border: '2px solid rgba(96,165,250,0.3)', borderTopColor: '#60a5fa', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          <div style={{ color: '#60a5fa', fontSize: 13, fontWeight: 600 }}>{status}</div>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </>
      )}
    </div>
  );
}

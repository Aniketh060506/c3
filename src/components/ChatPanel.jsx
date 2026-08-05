import React, { useState, useEffect, useRef } from 'react';

/**
 * ChatPanel – full-featured slide-in drawer
 * Props:
 *   myId       – current user's userId
 *   myEmail    – current user's email
 *   toUserId   – the other party's userId
 *   toName     – display name of the other party
 *   onClose    – close handler
 */
export default function ChatPanel({ myId, myEmail, toUserId, toName, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput]       = useState('');
  const [sending, setSending]   = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  const chatId = [myId, toUserId].sort().join('#');

  useEffect(() => {
    if (!window.c3) return;

    // Start the server-side poll for this chat
    window.c3.startChatPoll(chatId).catch(() => {});

    // Listen for incoming messages from IPC
    window.c3.onChatMessages((msgs) => {
      if (!Array.isArray(msgs)) return;
      setMessages(prev => {
        // De-duplicate by timestamp+senderId
        const existing = new Set(prev.map(m => `${m.senderId}::${m.timestamp}`));
        const fresh = msgs.filter(m => !existing.has(`${m.senderId}::${m.timestamp}`));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
    });

    return () => {
      window.c3.stopChatPoll().catch(() => {});
      window.c3.removeListeners('chat:messages');
    };
  }, [chatId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSend = async (e) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');

    // Optimistic UI
    const optimistic = { senderId: myId, message: text, timestamp: Date.now() / 1000, _optimistic: true };
    setMessages(prev => [...prev, optimistic]);

    try {
      if (window.c3?.sendChat) await window.c3.sendChat(toUserId, text);
    } catch (err) { console.error('[C3 Chat] send error:', err); }
    finally { setSending(false); }
  };

  const fmtTime = (ts) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Key handler – Enter to send
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const initial = (toName || toUserId || '?').charAt(0).toUpperCase();

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }} />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 400,
        zIndex: 41, display: 'flex', flexDirection: 'column',
        background: '#0e0e12', borderLeft: '1px solid rgba(255,255,255,0.1)',
        animation: 'slideInRight 0.25s cubic-bezier(.16,1,.3,1)',
      }}>

        {/* Header */}
        <div style={{ padding: '18px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16, flexShrink: 0 }}>
            {initial}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{toName || toUserId}</div>
            <div style={{ fontSize: 11, color: '#71717a', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} /> Provider
            </div>
          </div>
          <button onClick={onClose}
            style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            ×
          </button>
        </div>

        {/* No c3 warning */}
        {!window.c3 && (
          <div style={{ padding: '8px 16px', background: 'rgba(245,158,11,0.08)', borderBottom: '1px solid rgba(245,158,11,0.15)', fontSize: 12, color: '#f59e0b', textAlign: 'center' }}>
            ⚠️ Chat requires the Electron desktop app
          </div>
        )}

        {/* Messages area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 36 }}>💬</div>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#a1a1aa' }}>Start a conversation</div>
              <div style={{ fontSize: 12, color: '#52525b', textAlign: 'center', maxWidth: 260 }}>
                Message {toName || 'this provider'} to discuss workload requirements before requesting a session.
              </div>
            </div>
          ) : (
            messages.map((m, i) => {
              const isMe = m.senderId === myId;
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '80%', padding: '10px 14px', borderRadius: isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    background: isMe ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${isMe ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.07)'}`,
                    fontSize: 13, lineHeight: 1.5, color: '#e2e8f0', wordBreak: 'break-word',
                    opacity: m._optimistic ? 0.7 : 1,
                  }}>
                    {m.message}
                  </div>
                  <div style={{ fontSize: 10, color: '#52525b', marginTop: 3, paddingLeft: 4, paddingRight: 4 }}>
                    {fmtTime(m.timestamp)} {isMe ? '· You' : `· ${toName || 'Them'}`}
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Type a message... (Enter to send)"
              rows={1}
              style={{
                flex: 1, resize: 'none', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12, padding: '10px 14px', fontFamily: 'inherit', fontSize: 13, color: '#f8fafc',
                outline: 'none', lineHeight: 1.5, maxHeight: 100, overflowY: 'auto',
              }}
            />
            <button onClick={handleSend} disabled={!input.trim() || sending}
              style={{ width: 40, height: 40, borderRadius: '50%', border: 'none', background: input.trim() && !sending ? '#fff' : 'rgba(255,255,255,0.1)', color: input.trim() && !sending ? '#000' : '#52525b', cursor: input.trim() && !sending ? 'pointer' : 'not-allowed', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', flexShrink: 0 }}>
              {sending ? <div style={{ width: 14, height: 14, border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#000', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> : '↑'}
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#52525b', marginTop: 6, textAlign: 'center' }}>Enter to send · Shift+Enter for new line</div>
        </div>
      </div>

      <style>{`
        @keyframes slideInRight { from{transform:translateX(100%)} to{transform:translateX(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
      `}</style>
    </>
  );
}

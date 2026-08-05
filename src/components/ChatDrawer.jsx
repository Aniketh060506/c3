import React, { useState, useEffect, useRef } from 'react';

export default function ChatDrawer({ provider, onClose }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    let cleanup = () => {};
    if (window.c3) {
      if (window.c3.startChatPolling) window.c3.startChatPolling(provider.userId);
      if (window.c3.onChatMessages) {
        cleanup = window.c3.onChatMessages((msgs) => {
          setMessages(msgs || []);
        });
      }
    }
    return () => {
      cleanup();
      if (window.c3?.stopChatPolling) window.c3.stopChatPolling();
    };
  }, [provider.userId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const msgText = text;
    setText('');
    
    if (window.c3?.sendChatMessage) {
      try {
        await window.c3.sendChatMessage(provider.userId, msgText);
      } catch (e) {
        console.error(e);
      }
    } else {
      setMessages(prev => [...prev, { id: Date.now(), senderId: 'me', text: msgText }]);
    }
  };

  return (
    <>
      <div className="overlay" style={{ background: 'transparent' }} onClick={onClose}></div>
      <div className="drawer">
        <div className="flex ac jsb" style={{ padding: '16px 20px', borderBottom: '1px solid var(--br)' }}>
          <div className="flex ac g2">
            <div className="dot dot-g"></div>
            <div style={{ fontWeight: 600 }}>Chat: {provider.displayName}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
        
        {!window.c3 && (
          <div style={{ padding: '10px', background: 'var(--ad)', color: 'var(--amber)', fontSize: '12px', textAlign: 'center' }}>
            Chat unavailable in browser mode. Using mock chat.
          </div>
        )}

        <div className="f1 scroll fcol g3" style={{ padding: '20px' }} ref={scrollRef}>
          {messages.length === 0 && (
            <div className="text-center text-color-tertiary font-sm" style={{ marginTop: '40px' }}>
              No messages yet. Send a message to {provider.displayName}.
            </div>
          )}
          {messages.map((m, i) => {
            const isMe = m.senderId === 'me' || !m.senderId;
            return (
              <div key={m.id || i} className={`chat-bubble ${isMe ? 'me' : 'them'}`}>
                {m.text}
              </div>
            );
          })}
        </div>
        
        <form onSubmit={handleSend} className="flex g2" style={{ padding: '16px', borderTop: '1px solid var(--br)', background: 'var(--card)' }}>
          <input 
            className="input f1" 
            placeholder="Type a message..." 
            value={text}
            onChange={e => setText(e.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-icon">→</button>
        </form>
      </div>
    </>
  );
}

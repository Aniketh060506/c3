import { useState, useEffect, useRef } from 'react';

const LEVEL_STYLE = {
  step:  { color: '#60a5fa', icon: '⏳' },
  ok:    { color: '#34d399', icon: '✅' },
  info:  { color: '#94a3b8', icon: '  ' },
  warn:  { color: '#fbbf24', icon: '⚠️' },
  error: { color: '#f87171', icon: '❌' },
};

export default function DebugPanel({ show, onClose }) {
  const [logs, setLogs]       = useState([]);
  const [paused, setPaused]   = useState(false);
  const [filter, setFilter]   = useState('all');
  const bottomRef             = useRef(null);
  const pausedRef             = useRef(false);

  pausedRef.current = paused;

  useEffect(() => {
    if (!window.c3?.onDebugLog) return;
    const handler = (line) => {
      if (pausedRef.current) return;
      setLogs(prev => [...prev.slice(-400), { ...line, id: Date.now() + Math.random() }]);
    };
    window.c3.onDebugLog(handler);
    return () => window.c3.removeListeners('debug:log');
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, paused]);

  const visible = filter === 'all'
    ? logs
    : logs.filter(l => filter === 'errors'
        ? l.level === 'error' || l.level === 'warn'
        : l.level === filter);

  if (!show) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '90vw', maxWidth: 900, height: '80vh',
        background: '#0a0a14', border: '1px solid #1e293b',
        borderRadius: 18, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', boxShadow: '0 0 80px #000a',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 20px', borderBottom: '1px solid #1e293b',
          background: '#0d0d1f',
        }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: '#e2e8f0', letterSpacing: -0.5 }}>
            🐛 Live Debug Log
          </span>
          <span style={{
            background: '#1e293b', borderRadius: 100, padding: '2px 10px',
            fontSize: 11, color: '#64748b', fontFamily: 'monospace',
          }}>
            {logs.length} lines
          </span>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Filter buttons */}
            {['all', 'errors', 'ok', 'step'].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                padding: '4px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 11, fontWeight: 700,
                background: filter === f ? '#3b82f6' : '#1e293b',
                color: filter === f ? '#fff' : '#64748b',
              }}>{f}</button>
            ))}

            <button onClick={() => setPaused(p => !p)} style={{
              padding: '4px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontSize: 11, fontWeight: 700,
              background: paused ? '#f59e0b20' : '#1e293b',
              color: paused ? '#f59e0b' : '#64748b',
            }}>{paused ? '▶ Resume' : '⏸ Pause'}</button>

            <button onClick={() => setLogs([])} style={{
              padding: '4px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontSize: 11, fontWeight: 700, background: '#1e293b', color: '#64748b',
            }}>Clear</button>

            <button onClick={onClose} style={{
              padding: '4px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 800, background: '#ef444420', color: '#f87171',
            }}>✕</button>
          </div>
        </div>

        {/* Log list */}
        <div style={{
          flex: 1, overflowY: 'auto', fontFamily: 'monospace',
          fontSize: 12, lineHeight: 1.7, padding: '12px 0',
        }}>
          {visible.length === 0 && (
            <div style={{ color: '#334155', textAlign: 'center', marginTop: 60 }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
              No log entries yet. Press Accept Session on the provider to start.
            </div>
          )}
          {visible.map(line => {
            const s = LEVEL_STYLE[line.level] || LEVEL_STYLE.info;
            return (
              <div key={line.id} style={{
                display: 'flex', gap: 10, padding: '2px 20px',
                background: line.level === 'error' ? '#ef444408'
                  : line.level === 'ok'   ? '#22c55e06' : 'transparent',
                borderLeft: `2px solid ${line.level === 'error' ? '#ef4444'
                  : line.level === 'ok' ? '#22c55e' : 'transparent'}`,
              }}>
                <span style={{ color: '#334155', flexShrink: 0, userSelect: 'none' }}>
                  {line.ts}
                </span>
                <span style={{ flexShrink: 0 }}>{s.icon}</span>
                <span style={{ color: s.color, flex: 1, wordBreak: 'break-all' }}>
                  {line.msg}
                  {line.detail && (
                    <span style={{ color: '#475569', marginLeft: 8 }}>
                      {line.detail}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Footer status */}
        <div style={{
          borderTop: '1px solid #1e293b', padding: '8px 20px',
          background: '#0d0d1f', display: 'flex', gap: 20,
        }}>
          {['ok', 'warn', 'error'].map(lvl => {
            const count = logs.filter(l => l.level === lvl).length;
            const s = LEVEL_STYLE[lvl];
            return (
              <span key={lvl} style={{ fontSize: 11, color: count > 0 ? s.color : '#334155' }}>
                {s.icon} {lvl}: {count}
              </span>
            );
          })}
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#334155' }}>
            {paused ? '⏸ PAUSED' : '● LIVE'}
          </span>
        </div>
      </div>
    </div>
  );
}

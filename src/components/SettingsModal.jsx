import React, { useState } from 'react';

export default function SettingsModal({ user, credits, onLogout, onClose }) {
  const [loggingOut, setLoggingOut] = useState(false);

  const initial  = (user?.email || 'U').charAt(0).toUpperCase();
  const email    = user?.email    || '—';
  const userId   = user?.userId   || '—';
  const username = user?.username || email.split('@')[0];

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      if (window.c3?.signOut) await window.c3.signOut();
    } catch (_) {}
    onLogout();
  };

  const sections = [
    { icon: '📧', label: 'Email',   value: email },
    { icon: '🆔', label: 'User ID', value: userId.length > 20 ? userId.slice(0, 20) + '…' : userId },
    { icon: '⚡', label: 'Credits', value: `${credits ?? 0} C3 credits` },
  ];

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }} />

      {/* Modal */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        zIndex: 51, width: 420,
        background: '#0e0e12', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 24,
        overflow: 'hidden', animation: 'scaleIn 0.2s cubic-bezier(.16,1,.3,1)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.8)',
      }}>

        {/* Header */}
        <div style={{ padding: '24px 28px 20px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: '-0.5px' }}>Account Settings</div>
            <button onClick={onClose}
              style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#a1a1aa', cursor: 'pointer', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              ×
            </button>
          </div>

          {/* Avatar + name */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 20 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', border: '2px solid rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 22, color: '#f8fafc' }}>
              {initial}
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: '-0.4px' }}>{username}</div>
              <div style={{ fontSize: 12, color: '#71717a', marginTop: 3 }}>C3 Community Member</div>
            </div>
          </div>
        </div>

        {/* Info rows */}
        <div style={{ padding: '16px 28px' }}>
          {sections.map(s => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16 }}>{s.icon}</span>
                <span style={{ fontSize: 13, color: '#a1a1aa', fontWeight: 600 }}>{s.label}</span>
              </div>
              <span style={{ fontSize: s.label === 'User ID' ? 11 : 13, color: '#f8fafc', fontFamily: s.label === 'User ID' ? 'monospace' : 'inherit' }}>
                {s.value}
              </span>
            </div>
          ))}
        </div>

        {/* Version */}
        <div style={{ padding: '0 28px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16 }}>🚀</span>
              <span style={{ fontSize: 13, color: '#a1a1aa', fontWeight: 600 }}>App Version</span>
            </div>
            <span style={{ fontSize: 13, color: '#52525b' }}>C3 v2.0 — Electron</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16 }}>☁️</span>
              <span style={{ fontSize: 13, color: '#a1a1aa', fontWeight: 600 }}>Backend</span>
            </div>
            <span style={{ fontSize: 13, color: '#52525b' }}>AWS Cognito · DynamoDB</span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ padding: '0 28px 28px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={handleLogout} disabled={loggingOut}
            style={{ width: '100%', padding: '12px', borderRadius: 12, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: loggingOut ? '#71717a' : '#fca5a5', fontFamily: 'inherit', fontSize: 14, fontWeight: 700, cursor: loggingOut ? 'not-allowed' : 'pointer', transition: 'all 0.15s', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
            onMouseEnter={e => { if (!loggingOut) { e.currentTarget.style.background = 'rgba(239,68,68,0.15)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.5)'; } }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; }}>
            {loggingOut
              ? <><div style={{ width: 16, height: 16, border: '2px solid rgba(239,68,68,0.3)', borderTopColor: '#fca5a5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> Signing out…</>
              : '↪ Sign Out'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes scaleIn { from{opacity:0;transform:translate(-50%,-50%) scale(0.92)} to{opacity:1;transform:translate(-50%,-50%) scale(1)} }
        @keyframes spin { to{transform:rotate(360deg)} }
      `}</style>
    </>
  );
}

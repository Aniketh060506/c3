import React, { useState, useEffect, useRef } from 'react';
import AuthScreen from './components/AuthScreen';
import UserTab from './components/UserTab';
import ProviderTab from './components/ProviderTab';
import SettingsModal from './components/SettingsModal';
import DebugPanel from './components/DebugPanel';
import './index.css';



/* ── Error Boundary ── */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('[C3 Render Error]', e, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: '#fca5a5' }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>⚠️ {this.state.error.message}</div>
          <pre style={{ fontSize: 11, background: '#111', padding: 16, borderRadius: 8, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#71717a' }}>{this.state.error.stack}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: '8px 16px', background: '#fff', color: '#000', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [user, setUser]           = useState(null);
  const [activeTab, setActiveTab] = useState('user');
  const [credits, setCredits]     = useState(0);
  const [booting, setBooting]     = useState(true);
  // ── Provider active state: lifted here so tab-switching never resets it ──
  const [providerActive, setProviderActive] = useState(() => {
    try { return JSON.parse(localStorage.getItem('c3_provider_active') || 'false'); }
    catch { return false; }
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showDebug,    setShowDebug]    = useState(false);


  const setProviderActiveAndPersist = (val) => {
    setProviderActive(val);
    localStorage.setItem('c3_provider_active', JSON.stringify(val));
  };

  /* Restore session on launch */
  useEffect(() => {
    const saved = localStorage.getItem('c3_user');
    if (saved) {
      try {
        const u = JSON.parse(saved);
        if (u?.userId) { setUser(u); setCredits(u.credits ?? 0); }
      } catch (_) {}
    }
    // Also try live session if in Electron
    if (window.c3?.getUser) {
      window.c3.getUser()
        .then(u => { if (u?.userId) { setUser(u); setCredits(u.credits ?? 0); localStorage.setItem('c3_user', JSON.stringify(u)); } })
        .catch(() => {})
        .finally(() => setBooting(false));
    } else {
      setBooting(false);
    }
  }, []);

  /* Poll credits every 60s */
  useEffect(() => {
    if (!user || !window.c3?.getCredits) return;
    const t = setInterval(() => {
      window.c3.getCredits().then(c => setCredits(c)).catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
  }, [user]);

  const handleLogin = (u) => {
    setUser(u);
    setCredits(u?.credits ?? 0);
    localStorage.setItem('c3_user', JSON.stringify(u));
  };

  const handleLogout = () => {
    if (window.c3?.signOut) window.c3.signOut().catch(() => {});
    localStorage.removeItem('c3_user');
    setUser(null);
  };

  if (booting) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#09090c' }}>
        <div style={{ width: 32, height: 32, border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (!user) return <AuthScreen onLogin={handleLogin} />;

  const initial = (user.email || user.username || 'U').charAt(0).toUpperCase();

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#09090c', color: '#f8fafc', overflow: 'hidden', position: 'relative' }}>

      {/* Orbs always behind everything */}
      <div className="orb-bg">
        <div className="orb orb-1" /><div className="orb orb-2" />
        <div className="orb orb-3" /><div className="orb orb-4" />
      </div>

      {/* ── Navbar ── */}
      <nav style={{
        height: 62, flexShrink: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', padding: '0 28px',
        background: 'rgba(9,9,12,0.88)', backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        position: 'relative', zIndex: 10,
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ position: 'relative', width: 36, height: 36 }}>
            <div style={{ width: 36, height: 36, background: '#fff', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, color: '#000', fontSize: 15, position: 'relative', zIndex: 1 }}>C3</div>
            <div style={{ position: 'absolute', inset: -3, border: '1.5px solid rgba(255,255,255,0.2)', borderRadius: 13, animation: 'spin 5s linear infinite' }} />
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '-0.3px', lineHeight: 1.1 }}>Community Compute</div>
            <div style={{ fontSize: 10, color: '#52525b', letterSpacing: '0.5px' }}>v2.0 • {user.email || user.username}</div>
          </div>
        </div>

        {/* Center pill tabs */}
        <div style={{ display: 'inline-flex', gap: 3, background: 'rgba(255,255,255,0.05)', padding: 4, borderRadius: 100, border: '1px solid rgba(255,255,255,0.07)' }}>
          {[['user', '⚡ Use Compute'], ['provider', '🖥️ Share Resources']].map(([id, label]) => (
            <button key={id} onClick={() => setActiveTab(id)}
              style={{ padding: '8px 22px', borderRadius: 100, border: 'none', fontFamily: 'inherit', fontSize: 13, fontWeight: activeTab === id ? 700 : 500, cursor: 'pointer', userSelect: 'none', transition: 'all 0.2s ease', background: activeTab === id ? '#fff' : 'transparent', color: activeTab === id ? '#000' : '#71717a' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Right: credits + debug + avatar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ padding: '6px 14px', borderRadius: 100, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', fontSize: 13, color: '#f59e0b', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            ⚡ <span>{credits}</span> <span style={{ fontWeight: 400, color: '#71717a' }}>credits</span>
          </div>
          {/* Debug button */}
          <button onClick={() => setShowDebug(true)} title="Debug Log (Ctrl+Shift+D)"
            style={{ padding: '6px 12px', borderRadius: 100, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', fontSize: 12, color: '#f87171', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
            🐛 Debug
          </button>
          <div onClick={() => setShowSettings(true)} title="Account Settings"
            style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.07)', border: '2px solid rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, cursor: 'pointer', transition: 'all 0.15s', letterSpacing: '-0.5px' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.13)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; }}>
            {initial}
          </div>
        </div>
      </nav>

      {/* Main — both tabs always mounted, just hidden via display to preserve state */}
      <main style={{ flex: 1, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
        <ErrorBoundary>
          <div style={{ width: '100%', height: '100%', display: activeTab === 'user' ? 'block' : 'none', overflowY: 'auto' }}>
            <UserTab user={user} />
          </div>
          <div style={{ width: '100%', height: '100%', display: activeTab === 'provider' ? 'block' : 'none', overflowY: 'auto' }}>
            <ProviderTab
              user={user}
              active={providerActive}
              setActive={setProviderActiveAndPersist}
            />
          </div>
        </ErrorBoundary>
      </main>

      {showSettings && (
        <SettingsModal
          user={user}
          credits={credits}
          onLogout={handleLogout}
          onClose={() => setShowSettings(false)}
        />
      )}
      <DebugPanel show={showDebug} onClose={() => setShowDebug(false)} />

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

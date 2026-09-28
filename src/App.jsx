import React, { useState, useEffect } from 'react';
import AuthScreen from './components/AuthScreen';
import ConsumerTab from './components/ConsumerTab';
import ProviderTab from './components/ProviderTab';

export default function App() {
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('consumer');
  const [credits, setCredits] = useState(100);
  const [booting, setBooting] = useState(true);
  const [providerActive, setProviderActive] = useState(() => {
    try { return JSON.parse(localStorage.getItem('c3_provider_active') || 'false'); }
    catch { return false; }
  });

  useEffect(() => {
    const saved = localStorage.getItem('c3_user');
    if (saved) {
      try {
        const u = JSON.parse(saved);
        if (u?.userId) { setUser(u); setCredits(u.credits ?? 100); }
      } catch (_) {}
    }
    if (window.c3?.getUser) {
      window.c3.getUser()
        .then(u => { if (u?.userId) { setUser(u); setCredits(u.credits ?? 100); localStorage.setItem('c3_user', JSON.stringify(u)); } })
        .catch(() => {})
        .finally(() => setBooting(false));
    } else {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    if (!user || !window.c3?.getCredits) return;
    const updateCredits = () => {
      window.c3.getCredits()
        .then(c => {
          const val = typeof c === 'object' && c !== null ? (c.credits ?? 100) : c;
          setCredits(Number(val) || 100);
        })
        .catch(() => {});
    };
    updateCredits();
    const t = setInterval(updateCredits, 60_000);
    return () => clearInterval(t);
  }, [user]);

  const handleLogin = u => {
    setUser(u);
    const cr = typeof u?.credits === 'object' ? (u.credits.credits ?? 100) : (u?.credits ?? 100);
    setCredits(Number(cr) || 100);
    localStorage.setItem('c3_user', JSON.stringify(u));
  };

  const handleLogout = () => {
    if (window.c3?.signOut) window.c3.signOut().catch(() => {});
    localStorage.removeItem('c3_user');
    localStorage.removeItem('c3_provider_active');
    setUser(null);
  };

  const setProviderActiveAndPersist = val => {
    setProviderActive(val);
    localStorage.setItem('c3_provider_active', JSON.stringify(val));
  };

  if (booting || !user) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-50 text-slate-800">
        <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4" />
        <div className="text-base font-black text-slate-800">Connecting to AWS Cognito...</div>
        <p className="text-xs text-slate-400 mt-1">Opening secure login</p>
      </div>
    );
  }

  const initial = (user.email || 'U').charAt(0).toUpperCase();

  return (
    <div className="w-full h-full flex flex-col text-slate-800 overflow-hidden bg-white select-none">
      {/* ── Header: Seamless White Frameless Header ── */}
      <header
        className="flex-shrink-0 h-16 flex items-center justify-between px-6 bg-white border-b border-slate-200/80 shadow-sm z-20 select-none"
        style={{ WebkitAppRegion: 'drag' }}
        onDoubleClick={() => window.c3?.maximizeWindow?.()}
      >
        {/* Brand */}
        <div className="flex items-center gap-3.5" style={{ WebkitAppRegion: 'no-drag' }}>
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-700 shadow-sm flex items-center justify-center text-sm font-black text-white">
            C3
          </div>
          <div>
            <div className="text-sm font-bold text-slate-900 leading-tight">Community Compute</div>
            <div className="text-[11px] text-slate-500 leading-tight font-mono">{user.email}</div>
          </div>
        </div>

        {/* Tab Switcher — exactly 2 tabs */}
        <div className="flex bg-slate-100/90 border border-slate-200/70 p-1 rounded-xl" style={{ WebkitAppRegion: 'no-drag' }}>
          <button
            onClick={() => setActiveTab('consumer')}
            className={`px-5 py-2 text-xs font-bold rounded-lg transition ${
              activeTab === 'consumer'
                ? 'bg-white text-blue-700 shadow-sm border border-slate-200/60'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            ⚡ Consumer
          </button>
          <button
            onClick={() => setActiveTab('provider')}
            className={`px-5 py-2 text-xs font-bold rounded-lg transition ${
              activeTab === 'provider'
                ? 'bg-white text-blue-700 shadow-sm border border-slate-200/60'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            🖥 Provider
          </button>
        </div>

        {/* Right controls — padded 144px (pr-36) for seamless Windows Minimize/Maximize/Close overlay */}
        <div className="flex items-center gap-3 pr-36" style={{ WebkitAppRegion: 'no-drag' }}>
          <div className="px-3.5 py-1.5 rounded-xl bg-amber-50 border border-amber-200/80 text-xs font-bold text-amber-800 flex items-center gap-1.5 shadow-sm">
            <span>⚡</span><span>{credits}</span><span className="text-amber-600/70 font-normal">cr</span>
          </div>
          <button
            onClick={handleLogout}
            className="px-3.5 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition"
          >
            Sign Out
          </button>
          <div className="w-8 h-8 rounded-full bg-blue-100 border border-blue-200 flex items-center justify-center text-xs font-bold text-blue-700">
            {initial}
          </div>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="flex-1 overflow-hidden">
        <div className={`w-full h-full overflow-y-auto ${activeTab === 'consumer' ? '' : 'hidden'}`}>
          <ConsumerTab user={user} />
        </div>
        <div className={`w-full h-full overflow-y-auto ${activeTab === 'provider' ? '' : 'hidden'}`}>
          <ProviderTab user={user} active={providerActive} setActive={setProviderActiveAndPersist} />
        </div>
      </main>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import AuthScreen from './components/AuthScreen';
import NameSetupModal from './components/NameSetupModal';
import ConsumerTab from './components/ConsumerTab';
import ProviderTab from './components/ProviderTab';
import iconImg from './assets/icon.png';

export default function App() {
  const [user, setUser] = useState(null);
  const [showNameModal, setShowNameModal] = useState(false);
  const [activeTab, setActiveTab] = useState('consumer');
  const [booting, setBooting] = useState(true);
  const [providerActive, setProviderActive] = useState(() => {
    try { return JSON.parse(localStorage.getItem('c3_provider_active') || 'false'); }
    catch { return false; }
  });
  // Issue 4: subscribe at App level so requests aren't lost when on Consumer tab
  const [incomingRequest, setIncomingRequest] = useState(null);

  useEffect(() => {
    if (window.c3?.getUser) {
      window.c3.getUser()
        .then(u => {
          if (u && (u.userId || u.email)) {
            setUser(u);
            if (!u.displayName) setShowNameModal(true);
          } else {
            setUser(null);
          }
        })
        .catch(() => setUser(null))
        .finally(() => setBooting(false));
    } else {
      setBooting(false);
    }
  }, []);

  // Issue 4: global cluster request subscription — never misses a request
  useEffect(() => {
    if (!window.c3?.onClusterRequest) return;
    const unsub = window.c3.onClusterRequest(req => setIncomingRequest(req));
    return () => { if (typeof unsub === 'function') unsub(); };
  }, []);

  const handleLogin = (authenticatedUser) => {
    setUser(authenticatedUser);
    if (!authenticatedUser?.displayName) {
      setShowNameModal(true);
    }
  };

  const handleNameSaved = (updatedUser) => {
    setUser(prev => ({ ...(prev || {}), ...updatedUser }));
    setShowNameModal(false);
  };

  const handleSignOut = async () => {
    try {
      if (window.c3?.signOut) await window.c3.signOut();
    } catch (_) {}
    setUser(null);
    setShowNameModal(false);
    setProviderActive(false);
    localStorage.removeItem('c3_provider_active');
  };

  const setProviderActiveAndPersist = val => {
    setProviderActive(val);
    localStorage.setItem('c3_provider_active', JSON.stringify(val));
  };

  if (booting) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-white text-slate-800">
        <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4" />
        <div className="text-sm font-bold text-slate-900">Connecting to C3 Cloud...</div>
      </div>
    );
  }

  // 1. MUST FIRST LOGIN (AWS Cognito Hosted UI or credentials or demo)
  if (!user) {
    return <AuthScreen onLogin={handleLogin} />;
  }

  // 2. AFTER LOGIN: If machine name is not set for this account on this machine, prompt for name!
  if (!user.displayName || showNameModal) {
    return (
      <div className="w-full h-full relative">
        <NameSetupModal
          userEmail={user.email}
          defaultName={user.displayName || user.suggestedName || ''}
          onSave={handleNameSaved}
        />
      </div>
    );
  }

  // 3. User authenticated AND machine named -> Launch full application!
  const initial = ((user?.displayName || user?.email || 'C').charAt(0)).toUpperCase();

  return (
    <div className="w-full h-full flex flex-col text-slate-800 overflow-hidden bg-white select-none">
      {/* ── Header: Seamless White Frameless Header ── */}
      <header
        className="flex-shrink-0 h-16 flex items-center justify-between px-6 bg-white border-b border-slate-200/80 shadow-sm z-20 select-none"
        style={{ WebkitAppRegion: 'drag' }}
        onDoubleClick={() => window.c3?.maximizeWindow?.()}
      >
        {/* Brand & Machine Name */}
        <div className="flex items-center gap-3.5" style={{ WebkitAppRegion: 'no-drag' }}>
          <img src={iconImg} alt="C3 Cloud" className="w-10 h-10 object-contain drop-shadow-sm" />
          <div>
            <div className="text-sm font-black text-slate-900 leading-tight">Community Compute Cloud</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] text-slate-700 font-mono font-bold flex items-center gap-1">
                <span>💻</span> {user?.displayName}
              </span>
              <span className="text-[10px] text-slate-400 font-mono">({user?.email})</span>
              <button
                onClick={() => setShowNameModal(true)}
                className="text-[10px] text-blue-600 hover:text-blue-800 font-bold hover:underline ml-0.5 cursor-pointer"
              >
                Rename
              </button>
            </div>
          </div>
        </div>

        {/* Tab Switcher — Consumer & Provider */}
        <div className="flex bg-slate-100/90 border border-slate-200/70 p-1 rounded-xl" style={{ WebkitAppRegion: 'no-drag' }}>
          <button
            onClick={() => setActiveTab('consumer')}
            className={`px-5 py-2 text-xs font-bold rounded-lg transition cursor-pointer ${
              activeTab === 'consumer'
                ? 'bg-white text-blue-700 shadow-sm border border-slate-200/60'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            ⚡ Consumer
          </button>
          <button
            onClick={() => setActiveTab('provider')}
            className={`px-5 py-2 text-xs font-bold rounded-lg transition cursor-pointer ${
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
          <div className="px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200/80 text-[11px] font-bold text-emerald-800 flex items-center gap-1.5 shadow-sm font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>P2P MESH ACTIVE</span>
          </div>
          <div className="w-8 h-8 rounded-full bg-indigo-50 border border-indigo-200 flex items-center justify-center text-xs font-black text-indigo-700" title={user?.email}>
            {initial}
          </div>
          <button
            onClick={handleSignOut}
            className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition border border-slate-200 cursor-pointer"
            title="Sign out of AWS"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="flex-1 overflow-hidden">
        <div className={`w-full h-full overflow-y-auto ${activeTab === 'consumer' ? '' : 'hidden'}`}>
          <ConsumerTab user={user} />
        </div>
        <div className={`w-full h-full overflow-y-auto ${activeTab === 'provider' ? '' : 'hidden'}`}>
          <ProviderTab
            user={user}
            active={providerActive}
            setActive={setProviderActiveAndPersist}
            incomingRequest={incomingRequest}
            onRequestHandled={() => setIncomingRequest(null)}
          />
        </div>
      </main>
    </div>
  );
}

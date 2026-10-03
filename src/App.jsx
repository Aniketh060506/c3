import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import OverviewTab from './components/OverviewTab';
import ConsumerTab from './components/ConsumerTab';
import ProviderTab from './components/ProviderTab';
import RayShell from './components/RayShell';
import SettingsTab from './components/SettingsTab';
import NameModal from './components/NameModal';
import HealthReportModal from './components/HealthReportModal';
import AuthScreen from './components/AuthScreen';
import { Sparkles, Terminal, Server, Zap, Wrench } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [user, setUser] = useState(null);
  const [specs, setSpecs] = useState(null);
  const [liveStats, setLiveStats] = useState(null);
  const [showNameModal, setShowNameModal] = useState(false);
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [dockerRunning, setDockerRunning] = useState(null);
  const [dockerCapacity, setDockerCapacity] = useState(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  // 1. Initial Load: Hardware Specs & User Session
  useEffect(() => {
    let isMounted = true;
    const loadWithTimeout = async (label, load) => {
      if (typeof load !== 'function') return null;
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(load),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), 6000);
          }),
        ]);
      } catch (err) {
        console.warn(`[init] ${label} unavailable:`, err.message);
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    async function init() {
      try {
        const [u, s, stats, diag] = await Promise.all([
          loadWithTimeout('user session', window.c3?.getUser && (() => window.c3.getUser())),
          loadWithTimeout('hardware specs', window.c3?.getHardwareSpecs && (() => window.c3.getHardwareSpecs())),
          loadWithTimeout('live system stats', window.c3?.getLiveStats && (() => window.c3.getLiveStats())),
          loadWithTimeout('Docker status', window.c3?.checkSetup && (() => window.c3.checkSetup())),
        ]);
        if (isMounted) {
          if (u) setUser(u);
          if (s) setSpecs(s);
          if (stats) setLiveStats(stats);
          if (diag?.docker) {
            setDockerRunning(diag.docker.running);
            setDockerCapacity(diag.docker);
          }
        }
      } catch (err) {
        console.error('[init] Startup error:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    init();
    return () => {
      isMounted = false;
    };
  }, []);

  // 2. Continuous Real-Time Dynamic Stream: Every 1 Second (1000ms)
  useEffect(() => {
    let interval = null;
    let isPolling = false;

    const poll = async () => {
      if (document.hidden || isPolling) return;
      isPolling = true;
      try {
        if (window.c3?.getLiveStats) {
          const stats = await window.c3.getLiveStats();
          setLiveStats(stats);
        }
      } catch (_) {} finally {
        isPolling = false;
      }
    };

    poll();
    interval = setInterval(poll, 1000); // Exact 1-second dynamic streaming!
    return () => clearInterval(interval);
  }, []);

  // 3. Periodic Docker check (every 8 seconds)
  useEffect(() => {
    const checkDockerHealth = async () => {
      try {
        if (window.c3?.checkSetup) {
          const diag = await window.c3.checkSetup();
          if (diag?.docker) {
            setDockerRunning(diag.docker.running);
            setDockerCapacity(diag.docker);
          }
        }
      } catch (_) {}
    };

    const t = setInterval(checkDockerHealth, 8000);
    return () => clearInterval(t);
  }, []);

  // 4. Manual Live Refresh
  const handleLiveRefresh = async () => {
    setManualRefreshing(true);
    try {
      if (window.c3?.getHardwareSpecs) {
        const freshSpecs = await window.c3.getHardwareSpecs(true);
        setSpecs(freshSpecs);
      }
      if (window.c3?.getLiveStats) {
        const freshStats = await window.c3.getLiveStats();
        setLiveStats(freshStats);
      }
      if (window.c3?.checkSetup) {
        const diag = await window.c3.checkSetup();
        if (diag?.docker) {
          setDockerRunning(diag.docker.running);
          setDockerCapacity(diag.docker);
        }
      }
    } finally {
      setTimeout(() => setManualRefreshing(false), 350);
    }
  };

  const handleNameSaved = (newName) => {
    setUser((prev) => ({ ...prev, displayName: newName }));
    setShowNameModal(false);
  };

  const handleStartDocker = async () => {
    try {
      if (window.c3?.startDocker) {
        await window.c3.startDocker();
        setTimeout(async () => {
          if (window.c3?.checkSetup) {
            const diag = await window.c3.checkSetup();
            if (diag?.docker) {
              setDockerRunning(diag.docker.running);
              setDockerCapacity(diag.docker);
            }
          }
        }, 5000);
      }
    } catch (_) {}
  };

  const handleSignOut = async () => {
    try {
      if (window.c3?.signOut) await window.c3.signOut();
    } catch (_) {}
    setUser(null);
  };

  if (loading && !specs) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-canvas-light text-slate-800">
        <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mb-4" />
        <div className="text-sm font-bold text-slate-800 font-display">
          Initializing C3 Cloud Engine...
        </div>
      </div>
    );
  }

  // If not authenticated, render AuthScreen
  if (!user) {
    return (
      <AuthScreen
        onAuthSuccess={(authUser) => setUser(authUser)}
      />
    );
  }

  return (
    <div className="w-full h-full flex flex-col bg-canvas-light text-slate-800 overflow-hidden font-sans">
      {/* ── Top Header Bar ── */}
      <Header
        user={user}
        currentTab={activeTab}
        onRenameMachine={() => setShowNameModal(true)}
        onSignOut={handleSignOut}
      />

      {/* ── Main Frame: Left Sidebar + Center Body ── */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          onSignOut={handleSignOut}
          dockerRunning={dockerRunning}
        />

        <main className="flex-1 overflow-hidden relative">
          {activeTab === 'overview' && (
            <OverviewTab
              specs={specs}
              liveStats={liveStats}
              dockerRunning={dockerRunning}
              onStartDocker={handleStartDocker}
              onOpenHealthReport={() => setShowHealthModal(true)}
              onLiveRefresh={handleLiveRefresh}
              refreshing={manualRefreshing}
              onSwitchTab={(tab) => setActiveTab(tab)}
            />
          )}

          {activeTab === 'consumer' && (
            <ConsumerTab
              specs={specs}
              dockerCapacity={dockerCapacity}
              user={user}
              onSwitchTab={(tab) => setActiveTab(tab)}
            />
          )}

          {activeTab === 'provider' && (
            <ProviderTab
              specs={specs}
              dockerCapacity={dockerCapacity}
              user={user}
              onSwitchTab={(tab) => setActiveTab(tab)}
            />
          )}

          {activeTab === 'ray' && (
            <RayShell specs={specs} onSwitchTab={(tab) => setActiveTab(tab)} />
          )}

          {activeTab === 'settings' && (
            <SettingsTab
              user={user}
              onUpdateUser={(updated) => setUser(updated)}
              specs={specs}
              onOpenHealthReport={() => setShowHealthModal(true)}
              onRenameMachine={() => setShowNameModal(true)}
              onSignOut={handleSignOut}
            />
          )}
        </main>
      </div>

      {/* ── Name Modal ── */}
      {showNameModal && (
        <NameModal
          currentName={user?.displayName}
          onSave={handleNameSaved}
          onClose={() => setShowNameModal(false)}
        />
      )}

      {/* ── Health & 1-Click Dependency Installer Modal ── */}
      {showHealthModal && (
        <HealthReportModal
          specs={specs}
          onClose={() => setShowHealthModal(false)}
        />
      )}
    </div>
  );
}

import React, { useState } from 'react';
import { Cloud, Search, ChevronDown, Laptop, LoaderCircle } from 'lucide-react';

export default function Header({ user, currentTab, onRenameMachine }) {
  const [searchIp, setSearchIp] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('');
  const [checkingConnection, setCheckingConnection] = useState(false);
  const handleSearchSubmit = async (e) => {
    if (e.key !== 'Enter' || !searchIp.trim() || checkingConnection) return;
    setCheckingConnection(true);
    setConnectionStatus('Checking provider RPC port 44344…');
    try {
      const result = await window.c3?.testP2PConnectivity?.(searchIp.trim(), 44344);
      setConnectionStatus(result?.ok
        ? `${searchIp.trim()} is reachable on provider port 44344. Select it from Consumer → Scan Nodes to send a request.`
        : result?.message || `${searchIp.trim()} did not answer on port 44344. Check the address, VPN, firewall, and Provider sharing state.`);
    } catch (error) {
      setConnectionStatus(error.message || 'Could not check provider connectivity.');
    } finally {
      setCheckingConnection(false);
    }
  };

  const getBreadcrumb = () => {
    switch (currentTab) {
      case 'consumer':
        return 'Workspace / Consumer Studio';
      case 'provider':
        return 'Workspace / Hardware Sharing Hub';
      case 'ray':
        return 'Workspace / Ray Distributed Shell';
      case 'settings':
        return 'Manage / System Configuration';
      default:
        return 'Workspace / Pool overview';
    }
  };

  return (
    <header
      className="flex-shrink-0 h-16 px-5 md:px-7 flex items-center justify-between bg-white/75 backdrop-blur-md border-b border-slate-200/80 z-30 select-none"
      style={{ WebkitAppRegion: 'drag' }}
    >
      {/* Brand & Breadcrumb */}
      <div className="flex items-center gap-5 min-w-0" style={{ WebkitAppRegion: 'no-drag' }}>
        <div className="flex items-center gap-3">
          <div className="brand-mark w-9 h-9 rounded-2xl text-white flex items-center justify-center shadow-sm">
            <Cloud className="w-5 h-5 text-indigo-300 stroke-[2.2]" />
          </div>
          <div>
            <div className="text-sm font-extrabold text-slate-900 tracking-tight font-display">
              C3 Cloud
            </div>
            <div className="text-[9px] font-bold text-slate-400 tracking-widest uppercase font-mono">
              Compute, composed.
            </div>
          </div>
        </div>

        <div className="h-4 w-px bg-slate-300/60" />

        <div className="hidden sm:block text-xs font-semibold text-slate-500 font-mono tracking-tight truncate">
          {getBreadcrumb()}
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-2.5 pr-32" style={{ WebkitAppRegion: 'no-drag' }}>
        {/* Connect Search Bar */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchIp}
            onChange={(e) => setSearchIp(e.target.value)}
            onKeyDown={handleSearchSubmit}
            placeholder="Test provider IP:44344"
            className="w-48 lg:w-56 bg-slate-50 hover:bg-white focus:bg-white text-xs font-medium text-slate-800 placeholder-slate-400 pl-9 pr-4 py-2 rounded-full border border-slate-200 focus:border-indigo-400 transition"
          />
          {checkingConnection && <LoaderCircle className="w-3.5 h-3.5 text-indigo-600 absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin" />}
          {connectionStatus && <div role="status" className="absolute z-50 right-0 top-11 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-xl text-xs text-slate-700">{connectionStatus}</div>}
        </div>

        {/* User / Machine Profile Pill */}
        <button
          type="button"
          onClick={onRenameMachine}
          className="machine-pill flex items-center gap-2.5 bg-white hover:bg-slate-50 border border-slate-200 pl-1.5 pr-3 py-1 rounded-full cursor-pointer transition"
          title="Click to rename this machine"
        >
          <div className="w-7 h-7 rounded-full bg-indigo-50 border border-indigo-200/60 flex items-center justify-center text-indigo-700 font-bold text-xs">
            <Laptop className="w-3.5 h-3.5" />
          </div>
          <div className="text-left">
            <div className="text-xs font-bold text-slate-800 leading-tight">
              {user?.displayName || 'Primary-Node'}
            </div>
            <div className={`flex items-center gap-1 text-[10px] font-bold ${user?.email ? 'text-emerald-600' : 'text-slate-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${user?.email ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              <span>{user?.email ? 'Signed in' : 'Local mode'}</span>
            </div>
          </div>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 ml-0.5" />
        </button>
      </div>
    </header>
  );
}

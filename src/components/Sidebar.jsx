import React from 'react';
import { LayoutGrid, Zap, Server, Terminal, Settings, LogOut } from 'lucide-react';

export default function Sidebar({ activeTab, setActiveTab, onSignOut, dockerRunning }) {
  const workspaceItems = [
    { id: 'overview', label: 'Overview', icon: LayoutGrid },
    { id: 'consumer', label: 'Use compute', icon: Zap },
    { id: 'provider', label: 'Share hardware', icon: Server },
    { id: 'ray', label: 'Ray & terminal', icon: Terminal },
  ];

  const manageItems = [
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <aside className="w-64 flex-shrink-0 bg-canvas-light/95 border-r border-slate-200/60 flex flex-col justify-between p-6 select-none">
      <div className="space-y-7">
        {/* Workspace Section */}
        <div className="space-y-2">
          <div className="text-[10px] font-extrabold text-slate-400 tracking-wider uppercase px-3 font-mono">
            Workspace
          </div>
          <nav className="space-y-1">
            {workspaceItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-2xl text-xs font-bold transition-all cursor-pointer ${
                    isActive
                      ? 'bg-white text-slate-900 shadow-soft border border-slate-200/70'
                      : 'text-slate-500 hover:text-slate-800 hover:bg-white/50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-600 stroke-[2.2]' : 'text-slate-400'}`} />
                    <span>{item.label}</span>
                  </div>
                  {isActive && (
                    <span className="w-1.5 h-4 bg-indigo-600 rounded-full" />
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Manage Section */}
        <div className="space-y-2">
          <div className="text-[10px] font-extrabold text-slate-400 tracking-wider uppercase px-3 font-mono">
            Manage
          </div>
          <nav className="space-y-1">
            {manageItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-2xl text-xs font-bold transition-all cursor-pointer ${
                    isActive
                      ? 'bg-white text-slate-900 shadow-soft border border-slate-200/70'
                      : 'text-slate-500 hover:text-slate-800 hover:bg-white/50'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-600 stroke-[2.2]' : 'text-slate-400'}`} />
                  <span>{item.label}</span>
                </button>
              );
            })}

            <button
              onClick={onSignOut}
              className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-2xl text-xs font-bold text-rose-600 hover:bg-rose-50 transition-all cursor-pointer"
            >
              <LogOut className="w-4 h-4 text-rose-500" />
              <span>Log out</span>
            </button>
          </nav>
        </div>
      </div>

      {/* Footer System Status */}
      <div className="pt-4 border-t border-slate-200/60">
        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 px-1">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full inline-block ${dockerRunning === true ? 'bg-emerald-500' : dockerRunning === false ? 'bg-rose-500' : 'bg-amber-400 animate-pulse'}`} />
            <span className="font-semibold text-slate-600">{dockerRunning === true ? 'Docker engine online' : dockerRunning === false ? 'Docker engine offline' : 'Checking Docker…'}</span>
          </div>
          <span className="text-[10px] font-bold text-slate-400">v3.1</span>
        </div>
      </div>
    </aside>
  );
}

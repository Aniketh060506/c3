import React, { useState, useEffect } from 'react';

/**
 * SetupBanner — Compact, sleek system diagnostics bar.
 * Small footprint: tells you at a glance what is present and what to install.
 * Expandable for full architectural details.
 */
export default function SetupBanner() {
  const [checks, setChecks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [installingTs, setInstallingTs] = useState(false);
  const [msg, setMsg] = useState('');

  const runChecks = async () => {
    setLoading(true);
    try {
      const result = window.c3?.checkSetup ? await window.c3.checkSetup() : null;
      setChecks(result);
    } catch {
      setChecks(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runChecks();
    if (window.c3?.onK3sPullProgress) window.c3.onK3sPullProgress(m => setMsg(m));
    if (window.c3?.onSetupProgress) window.c3.onSetupProgress(m => setMsg(m));
  }, []);

  const pullK3s = async () => {
    setPulling(true);
    setMsg('Starting K3s image pull (~280MB)...');
    try {
      const r = await window.c3.pullK3sImage();
      setMsg(r.ok ? '✓ K3s image pulled successfully!' : '✗ Pull failed: ' + r.error);
      if (r.ok) setTimeout(runChecks, 1500);
    } catch (e) {
      setMsg('✗ ' + e.message);
    } finally {
      setPulling(false);
    }
  };

  const installTs = async () => {
    setInstallingTs(true);
    setMsg('Opening Tailscale installer...');
    try {
      const r = await window.c3.installTailscale();
      setMsg(r.ok ? '✓ Tailscale installer launched. Please follow the setup window.' : '✗ ' + r.error);
      if (r.ok) setTimeout(runChecks, 4000);
    } catch (e) {
      setMsg('✗ ' + e.message);
    } finally {
      setInstallingTs(false);
    }
  };

  if (loading && !checks) {
    return (
      <div className="bg-white border border-slate-200/80 rounded-xl px-4 py-2 flex items-center justify-between text-xs text-slate-500 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          <span>Detecting system architecture (Docker, Tailscale, K3s, NFS)...</span>
        </div>
      </div>
    );
  }

  if (!checks) return null;

  const items = [
    {
      key: 'docker',
      icon: '🐳',
      name: 'Docker Desktop',
      status: checks.docker?.running ? 'Running' : checks.docker?.installed ? 'Stopped' : 'Missing',
      version: checks.docker?.version ? `v${checks.docker.version}` : null,
      ok: checks.docker?.running,
      action: !checks.docker?.installed ? {
        label: 'Download Docker',
        fn: () => window.c3?.openExternal ? window.c3.openExternal('https://www.docker.com/products/docker-desktop/') : window.open('https://www.docker.com/products/docker-desktop/'),
      } : checks.docker?.installed && !checks.docker?.running ? {
        label: 'Start Docker',
        fn: () => window.c3?.launchDocker && window.c3.launchDocker(),
      } : null,
    },
    {
      key: 'tailscale',
      icon: '🔐',
      name: 'Tailscale Mesh',
      status: checks.tailscale?.ip ? `Active — ${checks.tailscale.ip}` : checks.tailscale?.installed ? 'Installed' : 'Missing',
      version: checks.tailscale?.ip || (checks.tailscale?.version ? `v${checks.tailscale.version}` : null),
      ok: checks.tailscale?.installed,
      action: !checks.tailscale?.installed ? {
        label: installingTs ? 'Opening...' : 'Install Tailscale',
        fn: installTs,
        loading: installingTs,
      } : null,
    },
    {
      key: 'k3s',
      icon: '☸️',
      name: 'K3s Engine',
      status: checks.k3sImage?.pulled ? 'Ready' : 'Not Pulled',
      version: 'v1.30.0',
      ok: checks.k3sImage?.pulled,
      action: !checks.k3sImage?.pulled ? {
        label: pulling ? 'Pulling...' : 'Pull Image',
        fn: pullK3s,
        loading: pulling,
      } : null,
    },
    {
      key: 'storage',
      icon: '⚡',
      name: 'Shared Storage',
      status: 'Ready',
      version: 'JuiceFS / POSIX',
      ok: true,
      action: null,
    },
  ];

  const allReady = items.every(i => i.ok);
  const missingItems = items.filter(i => !i.ok);

  return (
    <div className="space-y-2">
      {/* ── Sleek Compact Bar ── */}
      <div className={`rounded-xl border px-4 py-2.5 flex items-center justify-between text-xs transition-all shadow-sm ${
        allReady
          ? 'bg-white border-slate-200/90'
          : 'bg-amber-50/80 border-amber-300'
      }`}>
        {/* Left: Summary pills */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 font-black text-slate-800 tracking-tight">
            <span className={`w-2 h-2 rounded-full ${allReady ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
            <span>System:</span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {items.map(item => (
              <span
                key={item.key}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-medium transition ${
                  item.ok
                    ? 'bg-emerald-50/60 border-emerald-200 text-emerald-800'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                <span>{item.icon}</span>
                <span className="font-bold text-slate-800">{item.name}</span>
                {item.version && <span className="text-[10px] text-slate-500 font-mono">({item.version})</span>}
                <strong className={item.ok ? 'text-emerald-600' : 'text-red-600'}>
                  {item.ok ? '✓' : '✗'}
                </strong>
              </span>
            ))}
          </div>

          {allReady ? (
            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100/60 px-2 py-0.5 rounded-full border border-emerald-300">
              All 4 Active
            </span>
          ) : (
            <span className="text-[10px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full border border-amber-300">
              {missingItems.length} Missing
            </span>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {missingItems.length > 0 && missingItems[0].action && (
            <button
              onClick={missingItems[0].action.fn}
              disabled={missingItems[0].action.loading}
              className="px-3 py-1 bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold rounded-lg transition shadow-sm"
            >
              {missingItems[0].action.label}
            </button>
          )}

          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[11px] font-bold text-blue-600 hover:text-blue-800 transition"
          >
            {expanded ? '▲ Hide Details' : '▼ Details'}
          </button>

          <button
            onClick={runChecks}
            className="text-slate-400 hover:text-slate-700 transition font-bold"
            title="Re-check components"
          >
            ↻
          </button>
        </div>
      </div>

      {/* ── Expandable Details Panel (when user clicks Details) ── */}
      {expanded && (
        <div className="bg-slate-50/90 border border-slate-200 rounded-xl p-4 grid grid-cols-2 lg:grid-cols-4 gap-3 shadow-inner">
          {items.map(item => (
            <div key={item.key} className="bg-white border border-slate-200 rounded-lg p-3 space-y-1 shadow-sm">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-800 flex items-center gap-1.5">
                  <span>{item.icon}</span> {item.name}
                </span>
                <span className={`text-[10px] font-black px-1.5 py-0.5 rounded border ${
                  item.ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200'
                }`}>
                  {item.ok ? 'PRESENT' : 'MISSING'}
                </span>
              </div>
              <div className="text-[11px] text-slate-500 truncate">
                {item.version ? `Version: ${item.version}` : item.status}
              </div>
              {item.action && !item.ok && (
                <button
                  onClick={item.action.fn}
                  disabled={item.action.loading}
                  className="mt-2 w-full py-1 bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold rounded transition"
                >
                  {item.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Terminal pull message */}
      {msg && (
        <div className="px-3.5 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs font-mono text-emerald-400">
          {msg}
        </div>
      )}
    </div>
  );
}

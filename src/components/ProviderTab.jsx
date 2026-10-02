import React, { useState, useEffect, useRef } from 'react';
import SetupBanner from './SetupBanner';

// ── Progress Bar ───────────────────────────────────────────────────────────────
function ProgressBar({ label, percent, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-600',
    amber: 'bg-amber-500',
    emerald: 'bg-emerald-500',
    indigo: 'bg-indigo-600',
    rose: 'bg-rose-500',
  };
  const textColors = {
    blue: 'text-blue-700',
    amber: 'text-amber-700',
    emerald: 'text-emerald-700',
    indigo: 'text-indigo-700',
    rose: 'text-rose-700',
  };
  return (
    <div>
      <div className="flex justify-between text-sm mb-2 font-medium">
        <span className="text-slate-600 font-mono text-xs">{label}</span>
        <span className={`font-black ${textColors[color]}`}>{Math.round(percent ?? 0)}%</span>
      </div>
      <div className="h-2.5 bg-slate-100 border border-slate-200/60 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${colors[color]}`} style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} />
      </div>
    </div>
  );
}

// ── Spec Card ──────────────────────────────────────────────────────────────────
function SpecCard({ icon, title, value, sub }) {
  return (
    <div className="bg-white border border-slate-200/90 rounded-2xl p-6 shadow-sm flex flex-col gap-1">
      <div className="text-2xl mb-1">{icon}</div>
      <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">{title}</div>
      <div className="text-xl font-black text-slate-900">{value || '—'}</div>
      {sub && <div className="text-xs text-slate-500 truncate">{sub}</div>}
    </div>
  );
}

// ── Provider Tab ───────────────────────────────────────────────────────────────
// Issue 4: incomingRequest and onRequestHandled are lifted to App.jsx
export default function ProviderTab({ user, active, setActive, incomingRequest, onRequestHandled }) {
  const [specs, setSpecs] = useState(null);
  const [liveStats, setLiveStats] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState('');
  const statsInterval = useRef(null);

  useEffect(() => {
    if (window.c3?.getHardwareSpecs) {
      window.c3.getHardwareSpecs()
        .then(s => setSpecs(s))
        .catch(() => setSpecs(null));
    }
  }, []);

  useEffect(() => {
    if (!active) {
      setLiveStats(null);
      if (statsInterval.current) { clearInterval(statsInterval.current); statsInterval.current = null; }
      return;
    }
    const poll = () => {
      if (document.hidden) return; // don't poll when window is minimized
      if (window.c3?.getLiveStats) window.c3.getLiveStats().then(setLiveStats).catch(() => {});
    };
    poll();
    statsInterval.current = setInterval(poll, 5000);
    return () => {
      if (statsInterval.current) { clearInterval(statsInterval.current); statsInterval.current = null; }
    };
  }, [active]);

  // Issue 4: on mount, if active is already true (persisted from last session),
  // re-call toggleProvider so the main process starts the P2P sharing loop.
  const hasSyncedActive = useRef(false);
  useEffect(() => {
    if (active && !hasSyncedActive.current && window.c3?.toggleProvider) {
      hasSyncedActive.current = true;
      window.c3.toggleProvider(true).catch(() => {});
    }
  }, [active]);

  // NOTE: onClusterRequest is now handled in App.jsx (Issue 4)

  const toggleProvider = async () => {
    setToggling(true); setError('');
    try {
      const nextActive = !active;
      if (window.c3?.toggleProvider) await window.c3.toggleProvider(nextActive);
      setActive(nextActive);
      if (!nextActive) {
        setSessionActive(false);
        setSessionId(null);
      }
    } catch (e) {
      setError(e.message || 'Failed to toggle provider status.');
    } finally {
      setToggling(false);
    }
  };

  const acceptRequest = async () => {
    if (!incomingRequest) return;
    try {
      if (window.c3?.acceptClusterRequest) await window.c3.acceptClusterRequest(incomingRequest.sessionId);
      setSessionId(incomingRequest.sessionId);
      setSessionActive(true);
      if (onRequestHandled) onRequestHandled();
    } catch (e) { setError(e.message); }
  };

  const declineRequest = async () => {
    if (!incomingRequest) return;
    try {
      if (window.c3?.declineClusterRequest) await window.c3.declineClusterRequest(incomingRequest.sessionId);
    } catch (_) {}
    if (onRequestHandled) onRequestHandled();
  };

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar ── */}
      <div className="flex-shrink-0 flex items-center justify-between px-10 py-6 border-b border-slate-100">
        <div>
          <h1 className="text-2xl font-black text-slate-900">🖥 Share Your Hardware</h1>
          <p className="text-sm text-slate-500 mt-1">
            {active
              ? '🟢 Your machine is visible to consumers in the marketplace.'
              : 'Enable sharing to appear in the marketplace and earn credits.'}
          </p>
        </div>
        <button
          onClick={toggleProvider}
          disabled={toggling}
          className={`inline-flex items-center gap-2.5 px-8 py-3.5 rounded-2xl text-base font-black transition-colors shadow-sm select-none ${
            active
              ? 'bg-red-50 border border-red-200 text-red-600 hover:bg-red-100'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-500/20'
          } disabled:opacity-60 disabled:cursor-not-allowed`}
        >
          {toggling ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              {active ? 'Stopping...' : 'Starting...'}
            </>
          ) : active ? (
            <>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <rect x="4" y="4" width="12" height="12" rx="2"/>
              </svg>
              Stop Sharing
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M6.3 2.841A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z"/>
              </svg>
              Start Sharing
            </>
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-10 py-8 space-y-6">
        {/* Error */}
        {error && (
          <div className="px-5 py-4 bg-red-50 border border-red-200 rounded-2xl text-sm font-semibold text-red-700 shadow-sm">{error}</div>
        )}

        {/* Setup Banner */}
        <SetupBanner />

        {/* Incoming request */}
        {incomingRequest && (
          <div className="bg-blue-50/90 border border-blue-300 rounded-2xl p-7 shadow-sm">
            <div className="flex items-start justify-between gap-5">
              <div className="flex-1">
                <div className="text-base font-black text-blue-900 flex items-center gap-2 mb-1">
                  <span className="text-xl">📡</span> Cluster Join Request
                </div>
                <div className="text-sm text-blue-700 mt-1">
                  <span className="font-bold text-blue-950">{incomingRequest.consumerEmail || incomingRequest.consumerId}</span> wants to add this machine to a cluster.
                </div>
                <div className="mt-3 flex gap-2 flex-wrap">
                  <span className="px-3 py-1 bg-white border border-blue-200 rounded-lg text-xs text-blue-800 font-medium">
                    Session: <code className="font-mono">{(incomingRequest.sessionId || '').slice(0, 12)}...</code>
                  </span>
                  <span className="px-3 py-1 bg-white border border-blue-200 rounded-lg text-xs text-blue-800 font-medium">
                    {incomingRequest.providerIds?.length || 1} node(s) in pool
                  </span>
                </div>
              </div>
              <div className="flex gap-3 flex-shrink-0">
                <button onClick={acceptRequest}
                  className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-xl shadow-sm transition">
                  ✓ Accept
                </button>
                <button onClick={declineRequest}
                  className="px-6 py-3 bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 text-sm font-bold rounded-xl transition">
                  Decline
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Active session */}
        {sessionActive && (
          <div className="bg-emerald-50 border border-emerald-300 rounded-2xl px-7 py-5 flex items-center gap-4 shadow-sm">
            <div className="w-3.5 h-3.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
            <div>
              <div className="text-sm font-black text-emerald-900">Worker Node Active — Contributing Resources</div>
              <div className="text-xs text-emerald-600 mt-0.5 font-mono">{(sessionId || '').slice(0, 20)}...</div>
            </div>
          </div>
        )}

        {/* Hardware Specs */}
        {specs ? (
          <div className="bg-white border border-slate-200/90 rounded-2xl p-7 shadow-sm space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">Your Machine Hardware Architecture</div>
                <div className="text-xs text-slate-500 mt-0.5">Physical hardware detected directly from your host system</div>
              </div>
              <span className="text-[11px] font-mono font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full">
                ⚡ {specs.gpuModel && specs.gpuModel !== 'None' ? `${specs.gpuModel.split('(')[0].trim()} Verified` : 'Hardware Telemetry Active'}
              </span>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <SpecCard
                icon="⚙️"
                title="Processor"
                value={specs.cpuCores ? `${specs.cpuCores} Cores` : 'Detected'}
                sub={specs.cpuModel || 'CPU'}
              />
              <SpecCard
                icon="🧠"
                title="Memory (RAM)"
                value={`${specs.ramGb || specs.ramUsableGb || '—'} GB${specs.ramType ? ` ${specs.ramType}` : ''}`}
                sub={[specs.ramSpeed, specs.ramManufacturer, specs.ramUsableGb ? `(${specs.ramUsableGb} GB Usable)` : ''].filter(Boolean).join(' · ') || 'System Memory'}
              />
              <SpecCard
                icon="🎮"
                title="Dedicated GPU"
                value={specs.gpuModel && specs.gpuModel !== 'None' ? (specs.gpuVramGb ? `${specs.gpuModel.split('(')[0].trim()} (${specs.gpuVramGb}GB)` : specs.gpuModel) : 'None'}
                sub={specs.gpu && specs.gpu !== 'None' ? specs.gpu : 'No dedicated GPU detected'}
              />
              <SpecCard
                icon="💻"
                title="Operating System"
                value={specs.os ? specs.os.split(' ').slice(0, 2).join(' ') : 'OS'}
                sub={specs.os || 'Host Operating System'}
              />
            </div>

            {/* Detailed RAM & Dedicated GPU Architecture Breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
              {/* Detailed RAM */}
              <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                    <span>🧠</span> Detailed RAM Architecture
                  </div>
                  {specs.ramType && (
                    <span className="text-[10px] font-mono font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                      {specs.ramType} {specs.ramSpeed ? `@ ${specs.ramSpeed}` : 'INSTALLED'}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="bg-white p-2 rounded-lg border border-slate-200/60">
                    <span className="text-slate-400 block text-[10px]">TOTAL INSTALLED</span>
                    <span className="font-bold text-slate-800">{specs.ramGb || specs.ramUsableGb || '—'} GB Physical</span>
                  </div>
                  <div className="bg-white p-2 rounded-lg border border-slate-200/60">
                    <span className="text-slate-400 block text-[10px]">CLOCK SPEED</span>
                    <span className="font-bold text-slate-800">{specs.ramSpeed || 'Standard'}</span>
                  </div>
                  <div className="bg-white p-2 rounded-lg border border-slate-200/60">
                    <span className="text-slate-400 block text-[10px]">MANUFACTURER</span>
                    <span className="font-bold text-slate-800">{specs.ramManufacturer || 'OEM / System'}</span>
                  </div>
                  <div className="bg-white p-2 rounded-lg border border-slate-200/60">
                    <span className="text-slate-400 block text-[10px]">FORM FACTOR</span>
                    <span className="font-bold text-slate-800">{specs.ramFormFactor || 'DIMM'}</span>
                  </div>
                </div>
              </div>

              {/* Detailed GPU */}
              {specs.gpuModel && specs.gpuModel !== 'None' ? (
                <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5 truncate max-w-[200px]" title={specs.gpuModel}>
                      <span>🎮</span> {specs.gpuModel.split('(')[0].trim()}
                    </div>
                    <span className="text-[10px] font-mono font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                      {specs.gpuVendor?.toUpperCase() || 'GPU'} ACCELERATED
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                    <div className="bg-white p-2 rounded-lg border border-slate-200/60">
                      <span className="text-slate-400 block text-[10px]">DISCRETE GPU</span>
                      <span className="font-bold text-slate-800 truncate block" title={specs.gpuModel}>
                        {specs.gpuModel.split('(')[0].trim()}
                      </span>
                    </div>
                    <div className="bg-white p-2 rounded-lg border border-slate-200/60">
                      <span className="text-slate-400 block text-[10px]">DEDICATED VRAM</span>
                      <span className="font-bold text-indigo-700">{specs.gpuVramGb ? `${specs.gpuVramGb} GB` : 'Shared / Dynamic'}</span>
                    </div>
                    <div className="bg-white p-2 rounded-lg border border-slate-200/60">
                      <span className="text-slate-400 block text-[10px]">DRIVER VERSION</span>
                      <span className="font-bold text-slate-800">{specs.gpuDriver || 'Installed'}</span>
                    </div>
                    <div className="bg-white p-2 rounded-lg border border-slate-200/60">
                      <span className="text-slate-400 block text-[10px]">ACCELERATION</span>
                      <span className="font-bold text-emerald-700">{specs.gpuVendor?.toLowerCase().includes('nvidia') ? 'CUDA / Tensor' : 'Hardware Compute'}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-slate-50/80 border border-slate-200/80 rounded-xl p-4 flex flex-col justify-center items-center text-center">
                  <span className="text-xl mb-1">⚙️</span>
                  <div className="text-xs font-bold text-slate-800">Integrated / Host Compute Only</div>
                  <p className="text-[11px] text-slate-500 mt-0.5">Workloads will utilize multi-threaded host CPU cores</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white border border-slate-200/90 rounded-2xl p-10 shadow-sm flex items-center justify-center gap-3">
            <div className="w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-slate-600 font-medium">Detecting hardware specs...</span>
          </div>
        )}

        {/* Live Real-Time Resource Telemetry */}
        {liveStats && (
          <div className="bg-white border border-slate-200/90 rounded-2xl p-7 shadow-sm">
            <div className="flex items-center justify-between mb-5">
              <div>
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">Live Real-Time Resource Usage</div>
                <div className="text-xs text-slate-500 mt-0.5">Dynamic telemetry polled directly from hardware sensors (1.5s live polling)</div>
              </div>
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold font-mono border ${
                active
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-indigo-50 border-indigo-200 text-indigo-700'
              }`}>
                <span className={`w-2 h-2 rounded-full ${active ? 'bg-emerald-500' : 'bg-indigo-500'} animate-pulse`} />
                {active ? 'POOLED TO MESH · STREAMING' : 'LOCAL SENSORS ACTIVE · READY'}
              </span>
            </div>
            <div className="space-y-4">
              <ProgressBar
                label={`CPU Utilization — ${specs?.cpuModel || 'Host CPU'}`}
                percent={liveStats.cpuPercent}
                color="blue"
              />
              <ProgressBar
                label={`System RAM${specs?.ramType ? ` (${specs.ramType})` : ''} — ${liveStats.memUsedGb?.toFixed(1) || '0'} / ${liveStats.memTotalGb?.toFixed(1) || '0'} GB (${liveStats.memFreeGb?.toFixed(1) || '0'} GB Free)`}
                percent={liveStats.memPercent}
                color="amber"
              />
              {liveStats.gpu && (
                <>
                  <ProgressBar
                    label={`${liveStats.gpu.name || 'GPU'} Core Load${liveStats.gpu.temp ? ` (${liveStats.gpu.temp}°C` : ''}${liveStats.gpu.powerDraw ? ` · ${liveStats.gpu.powerDraw}W)` : liveStats.gpu.temp ? ')' : ''}`}
                    percent={liveStats.gpu.gpuPercent}
                    color="indigo"
                  />
                  {liveStats.gpu.memTotalGb > 0 && (
                    <ProgressBar
                      label={`Dedicated VRAM — ${liveStats.gpu.memUsedGb?.toFixed(2) || '0'} / ${liveStats.gpu.memTotalGb?.toFixed(1) || '0'} GB${liveStats.gpu.memUsedMb ? ` (${liveStats.gpu.memUsedMb} MB In Use)` : ''}`}
                      percent={liveStats.gpu.memPercent}
                      color="emerald"
                    />
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Security guarantees */}
        <div className="bg-white border border-slate-200/90 rounded-2xl p-7 shadow-sm">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-5">Security &amp; Isolation Guarantees</div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-blue-50/60 border border-blue-100 rounded-2xl p-5">
              <div className="text-lg mb-2">🐳</div>
              <div className="font-bold text-blue-950 text-sm mb-1.5">Docker Sandbox</div>
              <p className="text-xs text-slate-600 leading-relaxed">All workloads run inside an ephemeral privileged container. No code touches your host files outside the bind-mount.</p>
            </div>
            <div className="bg-purple-50/60 border border-purple-100 rounded-2xl p-5">
              <div className="text-lg mb-2">🔐</div>
              <div className="font-bold text-purple-950 text-sm mb-1.5">WireGuard Mesh</div>
              <p className="text-xs text-slate-600 leading-relaxed">Inter-node traffic is end-to-end encrypted via Tailscale WireGuard, isolated from the public internet at all times.</p>
            </div>
            <div className="bg-emerald-50/60 border border-emerald-100 rounded-2xl p-5">
              <div className="text-lg mb-2">⏹</div>
              <div className="font-bold text-emerald-950 text-sm mb-1.5">Instant Teardown</div>
              <p className="text-xs text-slate-600 leading-relaxed">Stopping sharing immediately kills all containers, severs mesh connections, and leaves zero residual files on your host.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

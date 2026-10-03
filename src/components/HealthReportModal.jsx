import React, { useState, useEffect } from 'react';
import {
  X,
  Activity,
  Play,
  Download,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Terminal,
  Cpu,
  Flame,
  ArrowUpRight,
} from 'lucide-react';

export default function HealthReportModal({ onClose, specs }) {
  const [checks, setChecks] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');
  const [pulling, setPulling] = useState(false);
  const [installingTs, setInstallingTs] = useState(false);

  const runChecks = async () => {
    setLoading(true);
    try {
      if (window.c3?.checkSetup) {
        const res = await window.c3.checkSetup();
        setChecks(res);
      }
    } catch (_) {}
    setLoading(false);
  };

  useEffect(() => {
    runChecks();
    if (window.c3?.onPullProgress) {
      window.c3.onPullProgress((msg) => setActionMsg(msg));
    }
  }, []);

  const handleStartDocker = async () => {
    setActionMsg('Launching Docker Desktop...');
    try {
      if (window.c3?.startDocker) {
        await window.c3.startDocker();
        setActionMsg('Docker Desktop is launching... Please wait a few seconds and click Re-check.');
      }
    } catch (e) {
      setActionMsg('Failed to launch Docker: ' + e.message);
    }
  };

  const handleInstallTailscale = async () => {
    setInstallingTs(true);
    setActionMsg('Downloading official Tailscale installer...');
    try {
      if (window.c3?.installTailscale) {
        const res = await window.c3.installTailscale();
        setActionMsg(res.message || 'Installer launched! Please complete the setup window.');
        setTimeout(runChecks, 5000);
      }
    } catch (e) {
      setActionMsg('Failed: ' + e.message);
    } finally {
      setInstallingTs(false);
    }
  };

  const handlePullImages = async () => {
    setPulling(true);
    setActionMsg('Pulling the pinned K3s image from Docker Hub...');
    try {
      if (window.c3?.pullImage) {
        const res = await window.c3.pullImage('rancher/k3s:v1.36.4-k3s1');
        if (res.ok) {
          setActionMsg('✓ K3s compute image cached successfully!');
          runChecks();
        } else {
          setActionMsg('Pull note: ' + (res.error || 'Failed'));
        }
      }
    } catch (e) {
      setActionMsg('Pull error: ' + e.message);
    } finally {
      setPulling(false);
    }
  };

  const hasGpu = specs?.gpuModel && specs?.gpuModel !== 'None';

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm flex items-center justify-center p-5">
      <div className="diagnostic-dialog bg-white rounded-[28px] p-6 max-w-2xl w-full shadow-2xl border border-slate-200 space-y-5 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-5">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-2xl bg-slate-900 text-teal-300 flex items-center justify-center">
              <Activity className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div>
              <h2 className="text-xl font-extrabold text-slate-900 font-display">
                System Engine Diagnostics
              </h2>
              <p className="text-xs text-slate-500 font-medium mt-0.5">
                Real-time prerequisites check &amp; 1-click dependency manager.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Action / Progress Banner */}
        {actionMsg && (
          <div className="px-4 py-3 bg-slate-900 border border-slate-800 rounded-2xl text-xs font-mono text-emerald-400 flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
            <span className="truncate">{actionMsg}</span>
          </div>
        )}

        {/* 4 Dependency Cards */}
        <div className="space-y-3.5">
          {/* 1. Docker Desktop */}
          <div className="diagnostic-row bg-slate-50/70 border border-slate-200/80 rounded-[20px] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 border border-blue-200/70 flex items-center justify-center font-bold text-lg shadow-soft-sm flex-shrink-0">
                🐳
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-extrabold text-slate-900 font-display">
                    Docker Container Engine
                  </span>
                  {checks?.docker?.running ? (
                    <span className="px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 rounded-full flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Running
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-amber-100 text-amber-800 rounded-full flex items-center gap-1">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      Daemon Stopped
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 font-medium mt-0.5">
                  Required to run containers, mount the workspace, and execute K3s/Ray.
                </div>
              </div>
            </div>

            <div className="flex-shrink-0">
              {checks?.docker?.running ? (
                <div className="px-4 py-2 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold flex items-center gap-1.5 shadow-soft-sm">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Ready</span>
                </div>
              ) : checks?.docker?.installed ? (
                <button
                  onClick={handleStartDocker}
                  className="px-4.5 py-2.5 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-soft flex items-center gap-2 transition cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Start Docker Desktop</span>
                </button>
              ) : (
                <button
                  onClick={() => window.c3?.openExternal('https://www.docker.com/products/docker-desktop/')}
                  className="px-4.5 py-2.5 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-soft flex items-center gap-2 transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download Docker</span>
                </button>
              )}
            </div>
          </div>

          {/* 2. Tailscale connectivity */}
          <div className="diagnostic-row bg-slate-50/70 border border-slate-200/80 rounded-[20px] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-200/70 flex items-center justify-center font-bold text-lg shadow-soft-sm flex-shrink-0">
                🔐
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-extrabold text-slate-900 font-display">
                    Tailscale Connectivity
                  </span>
                  {checks?.tailscale?.running ? (
                    <span className="px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 rounded-full flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Tailnet Connected
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-slate-200 text-slate-700 rounded-full">
                      LAN Mode Only
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 font-mono mt-0.5">
                  {checks?.tailscale?.running
                    ? `${checks.tailscale.ip} · ${checks.tailscale.onlinePeerCount} peer(s) online`
                    : 'No Tailscale address detected. LAN peers must be directly reachable.'}
                </div>
              </div>
            </div>

            <div className="flex-shrink-0">
              {checks?.tailscale?.running ? (
                <div className="px-4 py-2 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold flex items-center gap-1.5 shadow-soft-sm">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>{checks.tailscale.onlinePeerCount ? 'Peer(s) Online' : 'No Peers Online'}</span>
                </div>
              ) : checks?.tailscale?.installed ? (
                <button
                  onClick={() => window.c3?.connectTailscale?.('')}
                  className="px-4.5 py-2.5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-soft flex items-center gap-2 transition cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Connect Mesh</span>
                </button>
              ) : (
                <button
                  onClick={handleInstallTailscale}
                  disabled={installingTs}
                  className="px-4.5 py-2.5 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-soft flex items-center gap-2 transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{installingTs ? 'Installing...' : '1-Click Install'}</span>
                </button>
              )}
            </div>
          </div>

          {/* 3. K3s & Ray Container Images */}
          <div className="diagnostic-row bg-slate-50/70 border border-slate-200/80 rounded-[20px] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-2xl bg-purple-50 text-purple-600 border border-purple-200/70 flex items-center justify-center font-bold text-lg shadow-soft-sm flex-shrink-0">
                ☸️
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-extrabold text-slate-900 font-display">
                    K3s &amp; Ray AI Images
                  </span>
                  {checks?.images?.k3sCached ? (
                    <span className="px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 rounded-full">
                      Pre-Cached
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-slate-200 text-slate-700 rounded-full">
                      Pulls on demand
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 font-medium mt-0.5">
                  Pre-pulling images eliminates startup latency when launching clusters.
                </div>
              </div>
            </div>

            <div className="flex-shrink-0">
              {checks?.images?.k3sCached ? (
                <div className="px-4 py-2 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold flex items-center gap-1.5 shadow-soft-sm">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Ready</span>
                </div>
              ) : (
                <button
                  onClick={handlePullImages}
                  disabled={pulling || !checks?.docker?.running}
                  className="px-4.5 py-2.5 rounded-full bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold shadow-soft flex items-center gap-2 transition cursor-pointer disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{pulling ? 'Pulling...' : 'Pre-pull Images'}</span>
                </button>
              )}
            </div>
          </div>

          {/* 4. GPU & CUDA Acceleration */}
          <div className="diagnostic-row bg-slate-50/70 border border-slate-200/80 rounded-[20px] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 border border-amber-200/70 flex items-center justify-center font-bold text-lg shadow-soft-sm flex-shrink-0">
                🎮
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-extrabold text-slate-900 font-display">
                    NVIDIA Hardware Acceleration
                  </span>
                  {hasGpu ? (
                    <span className="px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 rounded-full">
                      GPU Detected
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider bg-slate-200 text-slate-700 rounded-full">
                      CPU Compute
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 font-mono mt-0.5">
                  {hasGpu
                    ? `${specs.gpuModel} · Driver ${specs.gpuDriver || 'not reported'}`
                    : 'The current Ray workload runs on CPU. GPU scheduling is not configured.'}
                </div>
              </div>
            </div>

            <div className="flex-shrink-0">
              <div className="px-4 py-2 rounded-full bg-white border border-slate-200 text-slate-800 text-xs font-mono font-bold shadow-soft-sm">
                {hasGpu ? 'NVIDIA GPU' : 'Multi-Core CPU'}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-4 border-t border-slate-100">
          <button
            onClick={runChecks}
            disabled={loading}
            className="flex items-center gap-2 text-xs font-bold text-slate-600 hover:text-slate-900 transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Re-run Diagnostics</span>
          </button>

          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-full bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold shadow-soft transition cursor-pointer"
          >
            Close Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import NegotiationChat from './NegotiationChat';
import {
  Server,
  Play,
  Square,
  Cpu,
  HardDrive,
  Flame,
  Coins,
  ShieldCheck,
  CheckCircle2,
  Clock,
  Radio,
  SlidersHorizontal,
  Layers,
  Laptop,
  AlertCircle,
  RotateCw,
  Sparkles,
  Zap,
  Info,
  X,
  Lock,
  ArrowUpRight,
  ExternalLink,
} from 'lucide-react';

export default function ProviderTab({ specs, dockerCapacity, user, onSwitchTab }) {
  const [sharing, setSharing] = useState(false);
  const [providerConfig, setProviderConfig] = useState({
    cores: specs?.cpuCores ? Math.max(1, specs.cpuCores - 2) : 0,
    ramGb: specs?.ramUsableGb ? Math.max(2, Math.floor(specs.ramUsableGb - 4)) : 0,
    gpuEnabled: false,
    pricePerHour: null,
  });

  const [providerState, setProviderState] = useState(null);
  const [networkDiag, setNetworkDiag] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [incomingInvitation, setIncomingInvitation] = useState(null);
  const [negotiatingInvitation, setNegotiatingInvitation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeInfo, setActiveInfo] = useState(null);
  const [actionError, setActionError] = useState('');
  const dockerRamGb = Number(dockerCapacity?.memoryTotal || 0) / (1024 ** 3);
  const maxCores = Math.max(1, Math.min(Number(specs?.cpuCores || 1) - 1, Number(dockerCapacity?.cpus || specs?.cpuCores || 1) - 1));
  const maxRamGb = Math.max(1, Math.floor(Math.min(Number(specs?.ramUsableGb || 1), dockerRamGb > 0 ? dockerRamGb : Number(specs?.ramUsableGb || 1)) - 1));

  // Sync physical hardware specs when loaded
  useEffect(() => {
    if (specs && !sharing) {
      setProviderConfig(prev => ({
        ...prev,
        cores: specs.cpuCores ? Math.max(1, Math.min(maxCores, specs.cpuCores - 2)) : prev.cores,
        ramGb: specs.ramUsableGb ? Math.max(2, Math.min(maxRamGb, Math.floor(Math.min(specs.ramUsableGb, dockerRamGb || specs.ramUsableGb) - 1))) : prev.ramGb,
        // GPU pass-through is intentionally disabled in the UI until Ray's
        // Kubernetes GPU scheduling path is implemented and verified.
        gpuEnabled: false,
      }));
    }
  }, [specs?.cpuCores, specs?.ramUsableGb, specs?.gpuModel, sharing, dockerCapacity?.cpus, dockerCapacity?.memoryTotal]);

  // Sync initial state from backend
  useEffect(() => {
    async function loadState() {
      if (window.c3?.getProviderState) {
        const state = await window.c3.getProviderState();
        if (state) {
          setSharing(state.sharing);
          setProviderState(state);
          setActiveSession(state.activeSession);
          if (state.config) {
            setProviderConfig(prev => ({
              ...prev,
              cores: Math.min(state.config.cores, maxCores),
              ramGb: Math.min(state.config.ramGb, maxRamGb),
              gpuEnabled: false,
              pricePerHour: state.config.pricePerHour,
            }));
          }
        }
      }
      if (window.c3?.getNetworkDiagnostics) {
        const network = await window.c3.getNetworkDiagnostics();
        if (network) setNetworkDiag(network);
      }
    }
    loadState();

    // Listen for incoming invitation events
    let unsubInvite = null;
    let unsubStart = null;
    let unsubEnd = null;

    if (window.c3?.onProviderInvitation) {
      unsubInvite = window.c3.onProviderInvitation((invitation) => {
        setIncomingInvitation(invitation);
      });
    }

    if (window.c3?.onProviderSessionStarted) {
      unsubStart = window.c3.onProviderSessionStarted((sess) => {
        setActiveSession(sess);
        setIncomingInvitation(null);
      });
    }

    if (window.c3?.onProviderSessionEnded) {
      unsubEnd = window.c3.onProviderSessionEnded(() => {
        setActiveSession(null);
      });
    }

    return () => {
      if (unsubInvite) unsubInvite();
      if (unsubStart) unsubStart();
      if (unsubEnd) unsubEnd();
    };
  }, []);

  // Refresh provider state and uptime.
  useEffect(() => {
    if (!sharing) return;
    const interval = setInterval(async () => {
      if (window.c3?.getProviderState) {
        const state = await window.c3.getProviderState();
        if (state) {
          setProviderState(state);
          setActiveSession(state.activeSession);
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [sharing]);

  useEffect(() => {
    const refreshNetwork = async () => {
      if (!window.c3?.getNetworkDiagnostics) return;
      const network = await window.c3.getNetworkDiagnostics();
      if (network) setNetworkDiag(network);
    };
    const timer = setInterval(refreshNetwork, 15000);
    return () => clearInterval(timer);
  }, []);

  const handleToggleSharing = async () => {
    if (!sharing && !specs) {
      alert('Hardware information is not available yet. Refresh system diagnostics before sharing.');
      return;
    }
    setLoading(true);
    setActionError('');
    try {
      if (!sharing) {
        const res = await window.c3?.startProviderSharing(providerConfig);
        setSharing(true);
        setProviderState(res);
      } else {
        const res = await window.c3?.stopProviderSharing();
        setSharing(false);
        setProviderState(res);
        setActiveSession(null);
      }
    } catch (err) {
      console.error('[provider] Toggle error:', err);
      setActionError(err.message || 'Provider sharing could not be changed. Check Docker, network access, and AWS settings.');
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptInvitation = async () => {
    if (!incomingInvitation) return;
    setLoading(true);
    setActionError('');
    try {
      const sess = await window.c3?.acceptProviderSession(incomingInvitation);
      setActiveSession(sess);
      setIncomingInvitation(null);
    } catch (err) {
      console.error('[provider] Accept session error:', err);
      setActionError(err.message || 'The provider could not start this worker session.');
    } finally {
      setLoading(false);
    }
  };

  const handleDeclineInvitation = async () => {
    if (!incomingInvitation) return;
    try {
      await window.c3?.declineProviderSession(incomingInvitation.sessionId);
      setActionError('');
    } catch (err) {
      setActionError(err.message || 'Could not decline this invitation.');
      return;
    }
    setIncomingInvitation(null);
  };

  const formatUptime = (seconds = 0) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const gpuName = specs?.gpuModel && specs.gpuModel !== 'None' ? specs.gpuModel : null;

  return (
    <div className="workspace-page w-full h-full overflow-y-auto px-8 md:px-10 py-7 md:py-8 space-y-6 select-none ambient-canvas">
      {actionError && <div role="alert" className="bg-rose-50 border border-rose-200 text-rose-800 rounded-xl px-4 py-3 text-sm">{actionError}<button type="button" className="float-right font-bold" onClick={() => setActionError('')}>Dismiss</button></div>}
      {/* ── Section 1: Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-white/95 border border-slate-200/90 shadow-soft-sm text-[11px] font-extrabold text-slate-500 font-mono tracking-wider">
              <span className={`w-2 h-2 rounded-full ${sharing ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
              <span>{sharing ? 'SHARING ACTIVE · NO SETTLEMENT' : 'PROVIDER STANDBY'}</span>
            </div>

            {activeSession && (
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-800 text-[10px] font-extrabold font-mono shadow-soft-sm animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />
                <span>Worker container started · waiting for Kubernetes Ready</span>
              </div>
            )}
          </div>

          <h1 className="text-3xl md:text-4xl font-extrabold text-slate-900 tracking-tight font-display flex items-center gap-2.5">
            <span>Provider Mode</span>
            <span className="bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 bg-clip-text text-transparent">
              Hardware Hub
            </span>
          </h1>

          <p className="text-xs md:text-sm font-medium text-slate-500 max-w-xl">
            Share selected CPU and RAM with a consumer you trust. The K3s worker container requires privileged access and is not a security sandbox; GPU scheduling and credit settlement are not implemented.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            onClick={() => onSwitchTab('consumer')}
            className="expand-card flex items-center gap-2 bg-white/95 hover:bg-white text-slate-700 hover:text-slate-900 border border-slate-200/90 px-4.5 py-2.5 rounded-full text-xs font-bold shadow-soft transition cursor-pointer"
          >
            <Zap className="w-4 h-4 text-indigo-500" />
            <span>Switch to Consumer</span>
          </button>
        </div>
      </div>

      {/* ── Section 2: Provider Sharing Status ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left: Giant Toggle & Status Card */}
        <div className={`lg:col-span-7 rounded-[32px] p-7 md:p-8 relative overflow-hidden text-white flex flex-col justify-between min-h-[240px] expand-hero border transition-all duration-500 ${
          sharing
            ? 'bg-gradient-to-br from-slate-950 via-emerald-950/80 to-slate-950 border-emerald-500/30'
            : 'bg-slate-950 border-white/10'
        }`}>
          <div className={`w-72 h-72 rounded-full blur-3xl absolute -right-12 -bottom-12 pointer-events-none transition-all duration-700 ${
            sharing ? 'bg-emerald-500/30 animate-orb-1' : 'bg-indigo-600/20'
          }`} />

          {/* Top Row: Tag + Rates */}
          <div className="relative z-10 flex items-center justify-between">
            <span className="text-[10px] font-black tracking-widest text-emerald-300 font-mono uppercase flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${sharing ? 'bg-emerald-400 animate-ping' : 'bg-slate-500'}`} />
              {sharing ? 'DAEMON BROADCASTING' : 'DAEMON IDLE'}
            </span>

            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold bg-white/10 border border-white/15 text-emerald-200 shadow-soft-sm backdrop-blur-md">
                <Coins className="w-3.5 h-3.5 text-amber-300" />
                <span>{providerConfig.pricePerHour ? `${providerConfig.pricePerHour} Credits / Hr Offer` : 'Credit rate not configured'}</span>
              </span>
            </div>
          </div>

          {/* Middle: Live Earnings & Uptime */}
          <div className="relative z-10 my-4">
            <div className="text-xs font-mono uppercase tracking-wider text-emerald-300 font-bold mb-1">
              PROVIDER PAYMENTS
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-5xl md:text-6xl font-black font-display tracking-tight text-white drop-shadow-md">
                Payments disabled
              </span>
              <span className="text-xl font-extrabold text-emerald-300 font-display">
                
              </span>
            </div>
            <p className="text-xs text-slate-300 mt-2 font-mono flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 text-teal-300" />
              <span>Sharing uptime: {formatUptime(providerState?.uptimeSec || 0)} · this build does not charge consumers or pay providers</span>
            </p>
          </div>

          {/* Bottom: Big Action Button */}
          <div className="relative z-10 pt-4 border-t border-white/10 flex items-center justify-between gap-4">
            <div className="text-xs text-slate-300 font-medium">
              {sharing
                ? 'Provider service is active. LAN discovery and cloud registration can still fail independently.'
                : dockerCapacity?.running === false
                  ? 'Start Docker Desktop’s Linux engine before sharing compute.'
                  : maxRamGb < 2
                    ? 'The Docker engine needs at least 3 GB RAM to safely run a K3s worker.'
                    : 'Start the provider service to advertise this machine and accept invitations.'}
            </div>

            <button
              onClick={handleToggleSharing}
              disabled={loading || (!sharing && (!dockerCapacity?.running || maxRamGb < 2))}
              className={`expand-card px-6 py-3 rounded-full text-xs font-black shadow-lg flex items-center gap-2 transition cursor-pointer disabled:opacity-50 ${
                sharing
                  ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/40'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-900/40'
              }`}
            >
              {sharing ? (
                <>
                  <Square className="w-4 h-4 fill-current" />
                  <span>{loading ? 'Stopping...' : 'Stop Sharing'}</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                  <span>{loading ? 'Starting...' : 'Start Sharing'}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right: Worker Container Status */}
        <div className="lg:col-span-5 bg-white hover:bg-slate-50/50 border border-slate-200/90 hover:border-emerald-300 rounded-[32px] p-6 shadow-card expand-card flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-extrabold text-slate-400 font-mono tracking-widest uppercase">
                WORKER CONTAINER STATUS
              </div>
              <h2 className="text-lg font-extrabold text-slate-900 font-display">
                {activeSession ? 'Session Accepted · Worker Starting' : 'Awaiting Invitations'}
              </h2>
            </div>
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center shadow-soft-sm ${
              activeSession ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
            }`}>
              <Server className="w-4 h-4" />
            </div>
          </div>

          {activeSession ? (
            <div className="bg-emerald-50/80 border border-emerald-200/80 rounded-2.5xl p-4.5 space-y-2.5 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500">Consumer:</span>
                <span className="font-bold text-slate-900">{activeSession.consumerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Master IP:</span>
                <span className="font-bold text-indigo-700">{activeSession.masterIp}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Container:</span>
                <span className="font-bold text-emerald-800">c3-k3s-worker (rancher/k3s)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Docker GPU flag:</span>
                <span className="font-bold text-rose-700">{activeSession.gpuEnabled ? 'Requested (--gpus all); Ray GPU scheduling unavailable' : 'Not requested'}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-emerald-200/60">
                <span className="text-slate-500">Rate:</span>
                <span className="font-bold text-slate-900">{activeSession.rate ? `${activeSession.rate} credits/hr offer` : 'Not configured'}</span>
              </div>
            </div>
          ) : (
            <div className="p-6 rounded-2.5xl border border-dashed border-slate-200 text-center space-y-2">
              <div className="text-sm font-bold text-slate-700">No Active Worker Session</div>
              <p className="text-xs text-slate-500 max-w-xs mx-auto">
                {sharing
                  ? 'Provider service is running. Cloud registration status is shown below; local peers must discover the LAN beacon.'
                  : 'Start sharing above to allow nearby peers or cloud consumers to dispatch jobs.'}
              </p>
            </div>
          )}

          <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-2xl flex items-center justify-between text-xs font-mono">
            <span className="text-slate-500">Local Daemon:</span>
            <span className="font-bold text-slate-800 flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${sharing ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
              <span>{sharing ? 'Port 44344 (RPC) & 44345 (UDP)' : 'Offline'}</span>
            </span>
          </div>
        </div>
      </div>

      {/* ── Section 3: Hardware Allocation Sliders ── */}
      <div className="bg-white border border-slate-200/90 rounded-[32px] p-6 shadow-card expand-card space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-extrabold text-slate-400 font-mono tracking-widest uppercase">
              RESOURCE ALLOCATION
            </div>
            <h2 className="text-lg font-extrabold text-slate-900 font-display">
              Worker Container Resource Limits
            </h2>
          </div>
          <span className="text-xs text-slate-500 font-medium">
            CPU and memory caps constrain the container; privileged access still grants broad host control.
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Slider 1: CPU Cores */}
      <div className="space-y-2 p-4 bg-slate-50 rounded-2.5xl border border-slate-200/80">
            <div className="flex justify-between items-center text-xs">
              <span className="font-bold text-slate-700 flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-indigo-600" />
                <span>CPU Cores</span>
              </span>
              <span className="px-2.5 py-0.5 bg-indigo-100 text-indigo-800 rounded-full font-bold font-mono">
                {providerConfig.cores} / {maxCores} Cores
              </span>
            </div>
            <input
              type="range"
              min="1"
              max={maxCores}
              value={providerConfig.cores}
              disabled={sharing}
              onChange={(e) => setProviderConfig({ ...providerConfig, cores: parseInt(e.target.value, 10) })}
              className="w-full accent-indigo-600 cursor-pointer"
            />
            <div className="text-[11px] text-slate-400 flex justify-between font-mono">
              <span>1 Core</span>
              <span>Reserve {Math.max(0, Number(specs?.cpuCores || 0) - providerConfig.cores)} host threads</span>
            </div>
          </div>

          {/* Slider 2: RAM */}
          <div className="space-y-2 p-4 bg-slate-50 rounded-2.5xl border border-slate-200/80">
            <div className="flex justify-between items-center text-xs">
              <span className="font-bold text-slate-700 flex items-center gap-1.5">
                <HardDrive className="w-4 h-4 text-emerald-600" />
                <span>RAM Allocation</span>
              </span>
              <span className="px-2.5 py-0.5 bg-emerald-100 text-emerald-800 rounded-full font-bold font-mono">
                {providerConfig.ramGb} / {maxRamGb} GB
              </span>
            </div>
            <input
              type="range"
              min="2"
              max={Math.max(2, maxRamGb)}
              value={providerConfig.ramGb}
              disabled={sharing || maxRamGb < 2}
              onChange={(e) => setProviderConfig({ ...providerConfig, ramGb: parseInt(e.target.value, 10) })}
              className="w-full accent-emerald-600 cursor-pointer"
            />
            <div className="text-[11px] text-slate-400 flex justify-between font-mono">
              <span>2 GB min</span>
              <span>Reserve {Math.max(0, Math.floor(dockerRamGb) - providerConfig.ramGb)} Docker GB</span>
            </div>
          </div>

          <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-amber-950">
              <Flame className="h-4 w-4 text-amber-700" /> GPU compute is unavailable
            </div>
            <p className="text-xs leading-5 text-amber-900">{gpuName ? `${gpuName}${specs?.gpuVramGb ? ` (${specs.gpuVramGb} GB VRAM)` : ''} is detected, but this app cannot schedule GPU jobs yet.` : 'No supported GPU was detected.'} GPU sharing controls are hidden until the Kubernetes/Ray device plugin is implemented.</p>
          </div>
        </div>
      </div>

      {/* ── Section 4: Network & Discovery Matrix ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4.5">
        <div className="bg-white border border-slate-200/90 rounded-[28px] p-5.5 shadow-card expand-card space-y-2">
          <div className="flex items-center justify-between text-xs font-mono text-slate-400">
            <span>DISCOVERY CHANNEL</span>
            <Radio className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="text-lg font-black text-slate-900 font-display">P2P LAN Broadcast</div>
          <div className="text-xs text-slate-500 font-mono">
            UDP 44345 · LAN broadcast only; receipt is verified during discovery
          </div>
        </div>

        <div className="bg-white border border-slate-200/90 rounded-[28px] p-5.5 shadow-card expand-card space-y-2">
          <div className="flex items-center justify-between text-xs font-mono text-slate-400">
            <span>CLOUD REGISTRY</span>
            <ShieldCheck className={`w-4 h-4 ${providerState?.cloudRegistered ? 'text-emerald-600' : 'text-slate-400'}`} />
          </div>
          <div className="text-lg font-black text-slate-900 font-display">
            {providerState?.cloudRegistered ? 'AWS DynamoDB Connected' : 'Cloud registry unavailable'}
          </div>
          <div className="text-xs text-slate-500 font-mono">
            {providerState?.cloudRegistered ? 'Provider registration was accepted by c3_providers.' : 'Local LAN discovery can still work; cloud discovery is not confirmed.'}
          </div>
        </div>

        <div className="bg-white border border-slate-200/90 rounded-[28px] p-5.5 shadow-card expand-card space-y-2">
          <div className="flex items-center justify-between text-xs font-mono text-slate-400">
            <span>PROVIDER CONNECTIVITY</span>
            <Lock className="w-4 h-4 text-purple-600" />
          </div>
          <div className="text-lg font-black text-slate-900 font-display">Direct provider connection</div>
          <div className="text-xs text-slate-500 font-mono truncate">
            {networkDiag?.tailscaleRunning
              ? `${networkDiag.tailscaleIp} · ${networkDiag.onlinePeerCount} peer(s) online`
              : 'Tailscale not connected · cloud invitation queue required for session credentials'}
          </div>
        </div>
      </div>

      {/* Inline invitation card leaves the workspace accessible while responding. */}
      {incomingInvitation && (
        <section className="animate-fadeIn rounded-2xl border border-indigo-200 bg-white p-5 shadow-sm space-y-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
                  <Sparkles className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-slate-900 font-display">
                    Incoming Cluster Invitation
                  </h3>
                  <div className="text-xs text-slate-500">
                    A consumer wants to pool this computer for distributed training.
                  </div>
                </div>
              </div>
              <button
                onClick={handleDeclineInvitation}
                className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="bg-slate-50 rounded-2.5xl p-4.5 space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500">Consumer:</span>
                <span className="font-bold text-slate-900">{incomingInvitation.consumerName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Master IP:</span>
                <span className="font-bold text-indigo-700">{incomingInvitation.masterIp}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Requested Cores:</span>
                <span className="font-bold text-slate-900">{incomingInvitation.cores} vCPUs</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Requested RAM:</span>
                <span className="font-bold text-slate-900">{incomingInvitation.ramGb} GB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">NVIDIA GPU:</span>
                <span className="font-bold text-rose-700">{incomingInvitation.gpuEnabled ? `Requested (${gpuName || 'GPU'})` : 'Not requested'}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-slate-200">
                <span className="text-slate-500">Provider Offer:</span>
                <span className="font-bold text-emerald-700">{incomingInvitation.rate ? `${incomingInvitation.rate} C3 Credits / Hr offer` : 'Credit settlement not configured'}</span>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setNegotiatingInvitation(incomingInvitation)}
                className="px-4 py-3 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 text-xs font-bold rounded-2xl transition cursor-pointer"
              >
                Open chat tab
              </button>
              <button
                onClick={handleAcceptInvitation}
                disabled={loading}
                className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-2xl shadow-soft transition cursor-pointer flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>{loading ? 'Attaching Worker...' : 'Accept & Launch Worker'}</span>
              </button>
              <button
                onClick={handleDeclineInvitation}
                className="px-5 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-2xl transition cursor-pointer"
              >
                Decline
              </button>
            </div>
        </section>
      )}
      {negotiatingInvitation && (
        <section className="space-y-3" aria-label="Provider request chat">
          <div role="tablist" aria-label="Incoming request views" className="flex gap-2 border-b border-slate-200 pb-2">
            <button type="button" role="tab" aria-selected="false" onClick={() => setNegotiatingInvitation(null)} className="rounded-lg px-3 py-2 text-xs font-bold text-slate-500 hover:bg-white">Request</button>
            <button type="button" role="tab" aria-selected="true" className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700">Chat</button>
          </div>
          <NegotiationChat
            sessionId={negotiatingInvitation.sessionId}
            counterpartyName={negotiatingInvitation.consumerName || 'Consumer'}
            onClose={() => setNegotiatingInvitation(null)}
          />
        </section>
      )}
    </div>
  );
}

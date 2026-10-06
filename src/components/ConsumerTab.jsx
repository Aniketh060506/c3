import React, { useState, useEffect, useRef } from 'react';
import NegotiationChat from './NegotiationChat';
import {
  Folder,
  FolderOpen,
  Play,
  Square,
  CheckCircle2,
  Cpu,
  HardDrive,
  Layers,
  Sparkles,
  Server,
  ArrowUpRight,
  Terminal,
  RotateCw,
  FileCode,
  ShieldCheck,
  Clock,
  Laptop,
  Check,
  AlertCircle,
  X,
  ExternalLink,
} from 'lucide-react';

export default function ConsumerTab({ specs, dockerCapacity, user, onSwitchTab }) {
  const [nodes, setNodes] = useState([]);
  // The local machine is configured in its own resource section and is never
  // part of the remote-provider selection list.
  const [selectedNodeIds, setSelectedNodeIds] = useState(new Set());
  const [workspace, setWorkspace] = useState(null);
  const [clusterStatus, setClusterStatus] = useState({ status: 'INACTIVE' });
  const [scanning, setScanning] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchStep, setLaunchStep] = useState(null);
  const [activeInfo, setActiveInfo] = useState(null);
  const [requestSessions, setRequestSessions] = useState({});
  const [negotiatingRequest, setNegotiatingRequest] = useState(null);
  const [localAllocation, setLocalAllocation] = useState({ cores: 1, ramGb: 1 });
  const discoveryBusy = useRef(false);
  const maxLocalCores = Math.max(1, Math.min(Number(specs?.cpuCores || 1) - 1, Number(dockerCapacity?.cpus || specs?.cpuCores || 1) - 1));
  const dockerRamGb = Number(dockerCapacity?.memoryTotal || 0) / (1024 ** 3);
  const maxLocalRamGb = Math.max(1, Math.floor(Math.min(Number(specs?.ramUsableGb || 1), dockerRamGb > 0 ? dockerRamGb : Number(specs?.ramUsableGb || 1)) - 1));

  useEffect(() => {
    if (!specs) return;
    setLocalAllocation({
      cores: Math.max(1, Math.min(maxLocalCores, Number(specs.cpuCores || 1) - 2)),
      ramGb: Math.max(2, Math.min(maxLocalRamGb, Math.floor(Number(specs.ramUsableGb || 1) - 4))),
    });
  }, [specs?.cpuCores, specs?.ramUsableGb, dockerCapacity?.cpus, dockerCapacity?.memoryTotal]);

  // 1. Initial Node Discovery & Cluster State
  useEffect(() => {
    handleDiscoverNodes();

    async function checkCluster() {
      if (window.c3?.getClusterStatus) {
        const status = await window.c3.getClusterStatus();
        if (status) setClusterStatus(status);
      }
    }
    checkCluster();

    // Listen for status updates during deployment
    let unsubStatus = null;
    if (window.c3?.onClusterStatusUpdate) {
      unsubStatus = window.c3.onClusterStatusUpdate((update) => {
        if (update.step === 'INACTIVE') {
          setLaunching(false);
          setLaunchStep(null);
          checkCluster();
          return;
        }
        setLaunchStep(update);
        if (update.step === 'ACTIVE') {
          setLaunching(false);
          checkCluster();
        }
      });
    }

    return () => {
      if (unsubStatus) unsubStatus();
    };
  }, []);

  // Keep the provider list current while Consumer Studio is open. The ref
  // prevents a slow AWS query/UDP scan from overlapping the next refresh.
  useEffect(() => {
    const timer = setInterval(() => handleDiscoverNodes(), 10000);
    return () => clearInterval(timer);
  }, []);

  // Keep polling while a cluster instance exists, including transient API
  // errors, so the UI can recover when Docker/K3s comes back.
  useEffect(() => {
    if (clusterStatus.status === 'INACTIVE' || !clusterStatus.startTime) return;
    const t = setInterval(async () => {
      if (window.c3?.getClusterStatus) {
        const s = await window.c3.getClusterStatus();
        if (s) setClusterStatus(s);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [clusterStatus.status]);

  const providerRequests = clusterStatus.invitationResults || [];
  const requestIds = providerRequests.map(request => request.sessionId).filter(Boolean).join(',');
  useEffect(() => {
    if (!requestIds || !window.c3?.getNegotiationSession) return;
    let mounted = true;
    const refresh = async () => {
      const rows = await Promise.all(providerRequests.map(async request => {
        if (!request.sessionId || !request.chatAvailable) return [request.sessionId, null];
        try { return [request.sessionId, await window.c3.getNegotiationSession(request.sessionId)]; }
        catch (_) { return [request.sessionId, null]; }
      }));
      if (mounted) setRequestSessions(Object.fromEntries(rows.filter(([id]) => id)));
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { mounted = false; clearInterval(timer); };
  }, [requestIds]);

  const handleDiscoverNodes = async () => {
    if (discoveryBusy.current) return;
    discoveryBusy.current = true;
    setScanning(true);
    try {
      if (window.c3?.discoverNodes) {
        const list = await window.c3.discoverNodes();
        const remoteProviders = (list || []).filter(node => !node.isSelf && node.id !== 'self-node');
        setNodes(remoteProviders);
        setSelectedNodeIds(previous => new Set([...previous].filter(id => remoteProviders.some(node =>
          node.id === id && node.status !== 'UNREACHABLE' && Number.isFinite(node.latencyMs)
        ))));
      }
    } catch (err) {
      console.error('[consumer] Node discovery error:', err);
    } finally {
      discoveryBusy.current = false;
      setScanning(false);
    }
  };

  const handleToggleNode = (nodeId) => {
    const provider = nodes.find(node => node.id === nodeId);
    if (!provider || provider.status === 'UNREACHABLE' || !Number.isFinite(provider.latencyMs)) return;
    const next = new Set(selectedNodeIds);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    setSelectedNodeIds(next);
  };

  const handlePickWorkspace = async () => {
    try {
      if (window.c3?.pickWorkspaceFolder) {
        const res = await window.c3.pickWorkspaceFolder();
        if (res) setWorkspace(res);
      }
    } catch (err) {
      console.error('[consumer] Folder pick error:', err);
    }
  };

  const handleLaunchCluster = async () => {
    if (!workspace) {
      alert('Please select a local workspace directory before launching the cluster.');
      return;
    }
    const unavailableSelected = nodes.filter(node => selectedNodeIds.has(node.id)
      && (node.status === 'UNREACHABLE' || !Number.isFinite(node.latencyMs)));
    if (unavailableSelected.length) {
      alert(`These selected providers are offline or unreachable: ${unavailableSelected.map(node => node.hostname).join(', ')}. Rescan after the provider is online.`);
      return;
    }

    setLaunching(true);
    setLaunchStep({ step: 'STARTING', message: 'Initializing distributed supercomputer...' });

    try {
      const localHost = {
        id: 'self-node',
        isSelf: true,
        hostname: specs?.hostname || 'Local host',
        cores: localAllocation.cores,
        ramGb: localAllocation.ramGb,
        gpu: specs?.gpuModel && specs.gpuModel !== 'None' ? specs.gpuModel : null,
      };
      const selectedNodes = [localHost, ...nodes.filter(node => selectedNodeIds.has(node.id))];
      const res = await window.c3?.startCluster({
        selectedNodes,
        workspacePath: workspace.folderPath,
      });
      setClusterStatus(res);
    } catch (err) {
      alert(`Cluster launch failed: ${err.message}`);
    } finally {
      setLaunching(false);
      setLaunchStep(null);
    }
  };

  const handleStopCluster = async () => {
    try {
      await window.c3?.stopCluster();
      setClusterStatus({ status: 'INACTIVE' });
    } catch (err) {
      console.error('[consumer] Stop cluster error:', err);
    }
  };

  // Local capacity is always part of the cluster, separately from optional providers.
  const selectedNodes = nodes.filter(n => selectedNodeIds.has(n.id));

  const isClusterActive = clusterStatus.status === 'ACTIVE';

  return (
    <div className="workspace-page w-full h-full overflow-y-auto px-8 md:px-10 py-7 md:py-8 space-y-6 select-none ambient-canvas">
      {/* ── Section 1: Command Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-white/95 border border-slate-200/90 shadow-soft-sm text-[11px] font-extrabold text-slate-500 font-mono tracking-wider">
              <span className={`w-2 h-2 rounded-full ${isClusterActive ? (clusterStatus.mode === 'POOLED_CLUSTER' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500 animate-pulse') : 'bg-indigo-500'}`} />
              <span>
                {isClusterActive
                  ? (clusterStatus.mode === 'POOLED_CLUSTER'
                      ? `CLUSTER POOLED · ${clusterStatus.joinedWorkerCount || 1} WORKER(S) JOINED`
                      : (clusterStatus.mode === 'STANDALONE_MASTER'
                          ? 'CLUSTER ONLINE · STANDALONE MASTER (0 WORKERS JOINED)'
                          : 'CLUSTER ONLINE · LOCAL MASTER'))
                  : 'CONSUMER STUDIO · READY TO POOL'}
              </span>
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-800 text-[10px] font-extrabold font-mono shadow-soft-sm">
              <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
              <span>{selectedNodeIds.size} Remote Provider(s) Selected</span>
            </div>
          </div>

          <h1 className="text-3xl md:text-4xl font-extrabold text-slate-900 tracking-tight font-display flex items-center gap-2.5">
            <span>Consumer</span>
            <span className="bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-700 bg-clip-text text-transparent">
              Studio
            </span>
          </h1>

          <p className="text-xs md:text-sm font-medium text-slate-500 max-w-xl">
            Pool local and cloud machines into a unified distributed supercomputer with zero cloud lock-in.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            onClick={handleDiscoverNodes}
            disabled={scanning}
            className="expand-card flex items-center gap-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200/90 px-4.5 py-2.5 rounded-full text-xs font-bold shadow-soft-sm transition cursor-pointer disabled:opacity-50"
            title="Scan Wi-Fi and DynamoDB for active hardware providers"
          >
            <RotateCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin text-indigo-600' : ''}`} />
            <span>{scanning ? 'Discovering...' : 'Scan Nodes'}</span>
          </button>

          {isClusterActive ? (
            <button
              onClick={() => onSwitchTab('ray')}
              className="expand-card group flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-5 py-2.5 rounded-full text-xs font-bold shadow-soft transition cursor-pointer"
            >
              <Terminal className="w-4 h-4" />
              <span>Open Ray Shell</span>
              <ArrowUpRight className="w-4 h-4 stroke-[2.5]" />
            </button>
          ) : (
            <button
              onClick={handleLaunchCluster}
              disabled={launching || maxLocalRamGb < 2 || dockerCapacity?.running === false}
              className="expand-card group flex items-center gap-2 bg-slate-950 hover:bg-indigo-950 text-white px-5 py-2.5 rounded-full text-xs font-bold shadow-soft transition cursor-pointer disabled:opacity-50"
            >
              <Play className="w-4 h-4 text-emerald-400 fill-current" />
              <span>{launching ? 'Deploying...' : 'Launch Supercomputer'}</span>
            </button>
          )}
        </div>
      </div>

      {user?.cloudIdentityReady === false && (
        <div role="status" className="px-4 py-3 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-900">
          AWS cloud identity is unavailable. LAN discovery can still find reachable providers, but cloud discovery, persisted negotiation chat, and test-credit features need working Cognito Identity Pool credentials.
        </div>
      )}

      {providerRequests.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">Provider Requests</div>
              <h2 className="text-base font-bold text-slate-900">Acceptance and price negotiation</h2>
            </div>
            <span className="text-xs text-slate-500">{providerRequests.length} request(s)</span>
          </div>
          {negotiatingRequest ? (
            <>
              <div role="tablist" aria-label="Provider request views" className="flex gap-2 border-b border-slate-100 pb-3">
                <button type="button" role="tab" aria-selected="false" onClick={() => setNegotiatingRequest(null)} className="rounded-lg px-3 py-2 text-xs font-bold text-slate-500 hover:bg-slate-50">Requests</button>
                <button type="button" role="tab" aria-selected="true" className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700">Chat · {negotiatingRequest.hostname || 'Provider'}</button>
              </div>
              <div role="tabpanel">
                <NegotiationChat
                  sessionId={negotiatingRequest.sessionId}
                  counterpartyName={negotiatingRequest.hostname || 'Provider'}
                  onClose={() => setNegotiatingRequest(null)}
                />
              </div>
            </>
          ) : (
            <div className="divide-y divide-slate-100">
              {providerRequests.map(request => {
                const session = requestSessions[request.sessionId];
                const status = session?.status || (request.ok ? 'SENT' : 'FAILED');
                return (
                  <div key={request.sessionId || request.nodeId} className="py-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-slate-800">{request.hostname || request.nodeId || 'Provider'}</div>
                      <div className="text-xs text-slate-500">{status.replaceAll('_', ' ')} · {request.channel === 'tailscale' ? 'Direct Tailscale' : request.channel === 'cloud' ? 'AWS request queue' : 'No delivery channel'}</div>
                      {session?.agreedPriceCreditsPerHour != null && <div className="text-xs text-emerald-700 font-semibold mt-1">Quote agreed: {session.agreedPriceCreditsPerHour} test credits/hour · no settlement</div>}
                    </div>
                    <button
                      type="button"
                      disabled={!request.chatAvailable}
                      onClick={() => setNegotiatingRequest(request)}
                      className="px-3.5 py-2 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-700 text-xs font-bold disabled:opacity-40"
                      title={request.chatAvailable ? 'Open the persisted DynamoDB request chat' : 'Chat requires the AWS request record to be available'}
                    >
                      Open chat tab
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* The local host is configured here, independently of provider selection. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-stretch">
      <section className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">Local host allocation</div>
            <h2 className="text-base font-bold text-slate-900">Reserve your own resources</h2>
          </div>
          <span className="text-xs text-slate-500">Docker engine capacity: {dockerCapacity?.cpus || '—'} CPU · {dockerRamGb ? dockerRamGb.toFixed(1) : '—'} GB RAM</span>
        </div>
        <div className="grid md:grid-cols-2 gap-5">
          <label className="text-sm font-semibold text-slate-700">Cluster CPU: {localAllocation.cores} / {maxLocalCores} threads
            <input aria-label="Local host CPU allocation" className="block w-full mt-2 accent-indigo-600" type="range" min="1" max={maxLocalCores} value={Math.min(localAllocation.cores, maxLocalCores)} onChange={event => setLocalAllocation(prev => ({ ...prev, cores: Number(event.target.value) }))} />
          </label>
          <label className="text-sm font-semibold text-slate-700">Cluster RAM: {localAllocation.ramGb} / {maxLocalRamGb} GB
            <input aria-label="Local host RAM allocation" className="block w-full mt-2 accent-indigo-600" type="range" min="2" max={Math.max(2, maxLocalRamGb)} value={Math.max(2, Math.min(localAllocation.ramGb, maxLocalRamGb))} disabled={maxLocalRamGb < 2} onChange={event => setLocalAllocation(prev => ({ ...prev, ramGb: Number(event.target.value) }))} />
          </label>
        </div>
        <p className="text-xs text-slate-500">The maximum uses the Docker engine’s capacity, not the larger Windows hardware reading. These limits apply to local K3s and Ray; remote nodes use their provider’s configured limits. A local K3s node needs at least 2 GB allocated RAM.</p>
      </section>

      <section className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-bold tracking-widest text-slate-400 uppercase">Workspace</div>
            <h2 className="text-base font-bold text-slate-900">Project folder</h2>
          </div>

          <button
            onClick={handlePickWorkspace}
            className="expand-card px-4 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-full text-xs font-bold transition cursor-pointer flex items-center gap-2"
          >
            <FolderOpen className="w-4 h-4" />
            <span>{workspace ? 'Change Folder' : 'Select Folder'}</span>
          </button>
        </div>

        {workspace ? (
          <div className="p-4 bg-slate-50 border border-slate-200/80 rounded-2.5xl space-y-2 text-xs font-mono">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-900 truncate flex items-center gap-2">
                <Folder className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                <span>{workspace.folderPath}</span>
              </span>
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold flex-shrink-0">
                Validated
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-slate-500 pt-1">
              <span>{workspace.fileCount} total files</span>
              <span>·</span>
              <span className="text-indigo-700 font-bold">{workspace.pyFiles.length} Python script(s):</span>
              {workspace.pyFiles.slice(0, 4).map((f) => (
                <span key={f} className="px-2 py-0.5 bg-white border border-slate-200 rounded-md text-[11px] text-slate-700 font-mono">
                  {f}
                </span>
              ))}
              {workspace.pyFiles.length > 4 && <span>+{workspace.pyFiles.length - 4} more</span>}
            </div>
          </div>
        ) : (
          <div className="p-4 border border-dashed border-slate-300 rounded-xl text-sm text-slate-500">
            Choose a folder to mount at <code>/workspace</code>. The built-in benchmark currently uses synthetic data and does not run these files.
          </div>
        )}
      </section>
      </div>

      {/* ── Section 4: Discovered Nodes Matrix ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <div className="text-[11px] font-extrabold text-slate-400 font-mono tracking-widest uppercase flex items-center gap-2">
            <span>AVAILABLE PROVIDERS</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          </div>
          <span className="text-xs text-slate-500 font-medium">
            Select remote machines to request. Your local host is configured separately above.
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4.5">
          {nodes.length === 0 ? (
            <div className="md:col-span-2 bg-white border border-dashed border-slate-300 rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="font-semibold text-slate-900">No remote providers found</h3>
                <p className="text-sm text-slate-500 mt-1">Start Provider Mode on another computer, then scan again. Your local resources stay available separately.</p>
              </div>
              <div className="flex gap-2 shrink-0">
                <button type="button" onClick={handleDiscoverNodes} disabled={scanning} className="px-3.5 py-2 rounded-xl border border-slate-200 text-slate-700 text-xs font-semibold disabled:opacity-50">Scan again</button>
                <button type="button" onClick={() => onSwitchTab('provider')} className="px-3.5 py-2 rounded-xl bg-indigo-600 text-white text-xs font-semibold">Provider settings</button>
              </div>
            </div>
          ) : nodes.map((node) => {
            const isSelected = selectedNodeIds.has(node.id);
            const isReachable = node.status !== 'UNREACHABLE' && Number.isFinite(node.latencyMs);

            return (
              <div
                key={node.id}
                onClick={() => handleToggleNode(node.id)}
                aria-disabled={!isReachable}
                title={!isReachable ? 'Provider is offline or cannot be reached. Start sharing on that PC, then rescan.' : 'Select this reachable provider'}
                className={`p-5 rounded-[28px] border transition-all expand-card space-y-3 ${!isReachable ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'} ${
                  isSelected
                    ? 'bg-white border-indigo-500/80 shadow-soft ring-2 ring-indigo-500/20'
                    : 'bg-white/80 border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-6 h-6 rounded-lg flex items-center justify-center border transition-colors ${
                      isSelected ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-300 bg-white'
                    }`}>
                      {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-extrabold text-slate-900 font-display">
                          {node.hostname}
                        </span>
                        <span className="px-2 py-0.5 text-[9px] font-mono uppercase bg-slate-100 text-slate-600 rounded-full">
                          {node.source}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 font-medium truncate max-w-xs">
                        {node.cpuModel}
                      </div>
                    </div>
                  </div>

                  <div className="text-right font-mono text-xs">
                    <span className={`font-bold ${isReachable ? 'text-emerald-700' : 'text-rose-700'}`}>{isReachable ? `Reachable · ${node.latencyMs}ms` : 'OFFLINE / UNREACHABLE'}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 text-xs font-mono">
                  <span className="bg-slate-50 px-2.5 py-1 rounded-full border border-slate-200 font-bold text-slate-700">
                    ⚙️ {node.cores} Cores
                  </span>
                  <span className="bg-slate-50 px-2.5 py-1 rounded-full border border-slate-200 font-bold text-slate-700">
                    🧠 {node.ramGb} GB {node.ramType || 'RAM'}
                  </span>
                  {node.gpu && (
                    <span className="bg-rose-50 px-2.5 py-1 rounded-full border border-rose-200 font-bold text-rose-700">
                      🎮 {node.gpu}
                    </span>
                  )}
                  <span className="bg-slate-50 px-2.5 py-1 rounded-full border border-slate-200 text-slate-500">
                    IP: {node.meshIp || node.ip}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Section 5: Active Cluster Control Card (If Active) ── */}
      {isClusterActive && (
        <div className="bg-white border border-emerald-300 rounded-[32px] p-6 shadow-card space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-extrabold text-slate-900 font-display">
                  Cluster Online &amp; Running
                </h2>
                <div className="text-xs text-slate-500 font-mono">
                  K3s Master: {clusterStatus.masterIp}:6443 · Volume: /workspace
                </div>
                {clusterStatus.rayStatus?.status === 'ERROR' && (
                  <div role="status" className="mt-2 text-xs text-amber-800">
                    K3s is running, but Ray did not become ready: {clusterStatus.rayStatus.error} Open Ray Shell and retry Start Ray Cluster after provider nodes join.
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => onSwitchTab('ray')}
                className="px-5 py-2.5 rounded-full bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold shadow-soft flex items-center gap-1.5 transition cursor-pointer"
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Open Ray Terminal</span>
              </button>

              <button
                onClick={handleStopCluster}
                className="px-4 py-2.5 rounded-full bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold transition cursor-pointer"
              >
                Terminate Cluster
              </button>
            </div>
          </div>
          {clusterStatus.workerJoinStatus && !clusterStatus.workerJoinStatus.confirmed && (
            <div role="status" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              <div className="font-bold">Remote cluster is incomplete</div>
              <p className="mt-1">{clusterStatus.workerJoinStatus.message}</p>
              {providerRequests.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {providerRequests.map((request) => (
                    <li key={request.sessionId}>
                      <span className="font-semibold">{request.hostname || request.nodeId || 'Provider'}:</span>{' '}
                      {request.error || request.message || (request.ok ? `Invitation sent via ${request.channel}; waiting for provider acceptance.` : 'Invitation was not delivered.')}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Non-blocking launch status keeps the workspace and request chat usable. */}
      {launching && launchStep && (
        <div className="fixed bottom-5 right-5 z-[70] w-[min(22rem,calc(100vw-2rem))] pointer-events-none animate-fadeIn">
          <div role="status" aria-live="polite" className="pointer-events-auto rounded-2xl border border-indigo-200 bg-white/95 p-4 shadow-2xl backdrop-blur">
            <div className="flex items-start gap-3">
              <RotateCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-indigo-600" />
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-slate-900">Starting cluster</h3>
                <p className="mt-1 text-xs leading-5 text-slate-600">{launchStep.message}</p>
                <p className="mt-2 text-[10px] text-slate-400">You can keep using other tabs while this runs.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

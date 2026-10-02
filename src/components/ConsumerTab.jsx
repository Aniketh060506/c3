import React, { useState, useEffect } from 'react';
import ClusterWorkspace from './ClusterWorkspace';
import SetupBanner from './SetupBanner';

// ── Node Card — Spacious, full-bleed design ────────────────────────────────────
function NodeCard({ node, selected, onToggle }) {
  const hasGpu = node.gpu && node.gpu !== 'None' && node.gpu !== 'undefined';
  return (
    <div
      onClick={onToggle}
      className={`bg-white border-2 rounded-2xl p-6 cursor-pointer transition-all duration-150 select-none shadow-sm ${
        selected
          ? 'border-blue-600 shadow-xl shadow-blue-500/10 ring-2 ring-blue-500/20 bg-blue-50/20'
          : 'border-slate-200/90 hover:border-slate-300 hover:shadow-md'
      }`}
    >
      {/* Top row */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start gap-3.5">
          <div className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition ${
            selected ? 'bg-blue-600 border-blue-600' : 'border-slate-300'
          }`}>
            {selected && (
              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth="3" viewBox="0 0 14 14">
                <polyline points="2,7 6,11 12,3" />
              </svg>
            )}
          </div>
          <div>
            <div className="font-black text-slate-900 text-lg leading-tight flex items-center gap-2">
              <span>{node.displayName || 'Compute Node'}</span>
              {node.isSelf && (
                <span className="px-2 py-0.5 rounded-md text-[10px] font-black bg-blue-100 text-blue-700 uppercase tracking-wider">
                  This Machine
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 mt-1 font-mono">
              ID: {node.userId ? `${node.userId.slice(0, 18)}...` : 'online'}
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 border border-emerald-200 text-emerald-700 shadow-sm">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-pulse" />
          ONLINE
        </span>
      </div>

      {/* Hardware spec tiles */}
      <div className="grid grid-cols-3 gap-3 pt-2">
        <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">CPU Topology</div>
          <div className="text-base font-black text-slate-900 leading-tight">
            {node.cpuCores ? `${node.cpuCores} Cores` : '—'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 truncate" title={node.cpuModel}>
            {node.cpuModel || 'Processor'}
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Memory (RAM)</div>
          <div className="text-base font-black text-slate-900 leading-tight">
            {node.ramGb ? `${node.ramGb} GB${node.ramType ? ` ${node.ramType}` : ''}` : '—'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 truncate">
            {[node.ramSpeed, node.ramManufacturer].filter(Boolean).join(' · ') || 'System Memory'}
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-100 rounded-xl p-3.5">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Accelerator (GPU)</div>
          <div className={`text-base font-black leading-tight truncate ${
            hasGpu ? 'text-indigo-700' : 'text-slate-400'
          }`}>
            {hasGpu ? (node.gpuModel ? node.gpuModel.split('(')[0].trim() : 'Discrete GPU') : 'CPU only'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 truncate" title={hasGpu ? node.gpu : 'No dedicated GPU'}>
            {hasGpu ? node.gpu : 'None'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Consumer Tab ──────────────────────────────────────────────────────────
export default function ConsumerTab({ user, onSwitchToProvider }) {
  const [providers, setProviders] = useState([]);
  const [selected, setSelected] = useState([]);
  const [workspacePath, setWorkspacePath] = useState('C:\\Users\\Aniketh\\Downloads');
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState('info');
  const [loading, setLoading] = useState(false);
  const [activeSession, setActiveSession] = useState(null);
  const [peerIp, setPeerIp] = useState('');
  const [connectingPeer, setConnectingPeer] = useState(false);

  // Load real active providers from P2P coordinator (fast 2s polling)
  const loadProviders = async (isManual = false) => {
    if (isManual) setLoading(true);
    try {
      if (window.c3?.getProviders) {
        const list = await window.c3.getProviders();
        setProviders(Array.isArray(list) ? list : []);
      } else {
        setProviders([]);
      }
    } catch (e) {
      setProviders([]);
    } finally {
      if (isManual) setLoading(false);
    }
  };

  const connectPeer = async () => {
    const ip = peerIp.trim();
    if (!ip) return;
    setConnectingPeer(true);
    setStatusMsg(`Pinging remote node at ${ip}...`);
    setStatusType('info');
    try {
      if (window.c3?.addPeerIp) {
        const res = await window.c3.addPeerIp(ip);
        if (res.ok && res.peer) {
          setStatusMsg(`✓ Connected to "${res.peer.displayName}" (${ip})!`);
          setStatusType('info');
          setPeerIp('');
          loadProviders(true);
        } else {
          setStatusMsg(`Node at ${ip} responded, but Provider sharing is not active on that machine.`);
          setStatusType('error');
        }
      }
    } catch (err) {
      setStatusMsg(`Could not connect to node at ${ip}: ${err.message}`);
      setStatusType('error');
    } finally {
      setConnectingPeer(false);
    }
  };

  useEffect(() => {
    loadProviders(true);
    const interval = setInterval(() => loadProviders(false), 10000);
    return () => clearInterval(interval);
  }, []);

  // Cluster lifecycle notifications
  useEffect(() => {
    if (!window.c3?.onClusterStatus) return;
    window.c3.onClusterStatus(data => {
      if (data.status === 'BOOTSTRAPPING') {
        setStatusMsg('All providers accepted! Bootstrapping K3s cluster & WireGuard mesh...');
        setStatusType('info');
      } else if (data.status === 'ACTIVE') {
        setStatusMsg('');
        setActiveSession(prev => ({ ...(prev || {}), ...data, workspacePath }));
      } else if (data.status === 'DECLINED') {
        setStatusMsg('A provider machine declined the cluster connection request.');
        setStatusType('error');
        setActiveSession(null);
      } else if (data.status === 'TIMEOUT') {
        setStatusMsg('Cluster negotiation timed out — providers did not respond in time.');
        setStatusType('error');
        setActiveSession(null);
      }
    });
  }, [workspacePath]);

  const toggleNode = id => setSelected(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
  );

  const pickFolder = async () => {
    if (window.c3?.selectWorkspaceFolder) {
      const p = await window.c3.selectWorkspaceFolder();
      if (p) setWorkspacePath(p);
    }
  };

  const selectedNodes = providers.filter(p => p && selected.includes(p.userId));
  const pooledCores = selectedNodes.reduce((a, n) => a + (parseInt(n?.cpuCores) || 0), 0);
  const pooledRam = selectedNodes.reduce((a, n) => a + (parseInt(n?.ramGb) || 0), 0);
  const pooledGpus = selectedNodes.filter(n => n?.gpu && n.gpu !== 'None' && n.gpu !== 'undefined').length;

  const launchCluster = async () => {
    const trimmedPath = (workspacePath || '').trim();
    if (!selected.length) {
      setStatusMsg('Please select at least one online provider node.');
      setStatusType('error');
      return;
    }
    if (!trimmedPath) {
      setStatusMsg('Please enter or browse to a local workspace folder.');
      setStatusType('error');
      return;
    }

    setStatusMsg(`Sending cluster invitation to ${selected.length} provider machine(s)...`);
    setStatusType('info');

    try {
      if (window.c3?.createClusterSession) {
        await window.c3.createClusterSession({ providerIds: selected, workspacePath: trimmedPath });
      }
    } catch (err) {
      setStatusMsg('Cluster launch failed: ' + err.message);
      setStatusType('error');
    }
  };

  const endSession = async () => {
    if (window.c3?.stopCluster) await window.c3.stopCluster().catch(() => {});
    setActiveSession(null);
    setStatusMsg('');
  };

  if (activeSession) {
    return <ClusterWorkspace session={{ ...activeSession, workspacePath }} onEnd={endSession} />;
  }

  return (
    <div className="w-full h-full flex flex-col bg-slate-50/50">
      {/* ── Main 2-Column Full Screen Workspace ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── LEFT CONTROL SIDEBAR (380px) ── */}
        <div className="w-[380px] flex-shrink-0 bg-white border-r border-slate-200/90 flex flex-col shadow-sm z-10">
          <div className="p-6 border-b border-slate-100">
            <h1 className="text-xl font-black text-slate-900 flex items-center gap-2.5">
              <span>⚡</span> Cluster Control
            </h1>
            <p className="text-xs text-slate-500 mt-1">Configure your local workspace and launch pooled supercomputing.</p>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Step 1: Workspace Folder */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  1. Local Workspace
                </span>
                <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                  Zero Cloud Uploads
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={workspacePath}
                    onChange={e => setWorkspacePath(e.target.value)}
                    placeholder="C:\Users\YourName\Project"
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs font-mono text-slate-900 placeholder-slate-400 focus:outline-none focus:bg-white focus:border-blue-500 shadow-inner transition"
                  />
                  <button
                    onClick={pickFolder}
                    className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 border border-slate-200 text-xs font-bold text-slate-700 rounded-xl transition whitespace-nowrap shadow-sm"
                  >
                    Browse...
                  </button>
                </div>

                {/* Preset folder chips for quick selection */}
                <div className="flex gap-1.5 flex-wrap text-[11px]">
                  <button
                    type="button"
                    onClick={() => setWorkspacePath('C:\\Users\\Aniketh\\Downloads')}
                    className="px-2.5 py-1 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-slate-600 font-medium transition"
                  >
                    📁 Downloads
                  </button>
                  <button
                    type="button"
                    onClick={() => setWorkspacePath('C:\\Users\\Aniketh\\Desktop')}
                    className="px-2.5 py-1 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-slate-600 font-medium transition"
                  >
                    📁 Desktop
                  </button>
                  <button
                    type="button"
                    onClick={() => setWorkspacePath('C:\\Users\\Aniketh\\Desktop\\projects')}
                    className="px-2.5 py-1 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-slate-600 font-medium transition"
                  >
                    📁 Projects
                  </button>
                </div>
              </div>

              <p className="text-[11px] text-slate-500 leading-relaxed">
                Mounted as <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-700 font-mono">/workspace</code> inside all worker pods. Code executes directly against your local hard drive.
              </p>
            </div>

            {/* Pooled Resource Summary Card */}
            <div className="bg-slate-50/80 border border-slate-200 rounded-2xl p-5 space-y-4">
              <div className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Aggregated Supercomputer Pool
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm">
                  <div className="text-[10px] font-bold text-slate-400 uppercase">Pooled Cores</div>
                  <div className="text-2xl font-black text-slate-900 mt-0.5">{pooledCores}</div>
                  <div className="text-[10px] text-slate-500">vCPU Threads</div>
                </div>

                <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm">
                  <div className="text-[10px] font-bold text-slate-400 uppercase">Unified RAM</div>
                  <div className="text-2xl font-black text-slate-900 mt-0.5">{pooledRam} GB</div>
                  <div className="text-[10px] text-slate-500">Memory Pool</div>
                </div>

                <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm">
                  <div className="text-[10px] font-bold text-slate-400 uppercase">Accelerators</div>
                  <div className={`text-2xl font-black mt-0.5 ${pooledGpus ? 'text-indigo-700' : 'text-slate-400'}`}>
                    {pooledGpus}
                  </div>
                  <div className="text-[10px] text-slate-500">CUDA / GPUs</div>
                </div>

                <div className="bg-white border border-slate-200/80 rounded-xl p-3 shadow-sm">
                  <div className="text-[10px] font-bold text-slate-400 uppercase">Pooled Nodes</div>
                  <div className="text-2xl font-black text-blue-600 mt-0.5">{selectedNodes.length}</div>
                  <div className="text-[10px] text-slate-500">Machines</div>
                </div>
              </div>
            </div>

            {/* Status alerts */}
            {statusMsg && (
              <div className={`rounded-xl p-4 text-xs font-semibold leading-relaxed border shadow-sm ${
                statusType === 'error'
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-blue-50 border-blue-200 text-blue-800'
              }`}>
                {statusMsg}
              </div>
            )}
          </div>

          {/* Launch Cluster Button at Bottom of Sidebar */}
          <div className="p-6 border-t border-slate-100 bg-white">
            <button
              onClick={launchCluster}
              disabled={!selected.length || !(workspacePath || '').trim() || (statusMsg && statusType === 'info')}
              className={`w-full py-4 rounded-2xl text-sm font-black transition-all shadow-lg flex items-center justify-center gap-2 ${
                selected.length && (workspacePath || '').trim() && !(statusMsg && statusType === 'info')
                  ? 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-blue-500/25 cursor-pointer'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
              }`}
            >
              {selected.length === 0 ? (
                'Select Provider Nodes to Pool →'
              ) : !(workspacePath || '').trim() ? (
                'Choose a Workspace Folder →'
              ) : (
                `🚀 Launch Cluster (${selectedNodes.length} Nodes · ${pooledCores} Cores)`
              )}
            </button>
          </div>
        </div>

        {/* ── RIGHT MAIN PANEL (Marketplace & Health) ── */}
        <div className="flex-1 overflow-y-auto p-10 space-y-8">
          {/* Real System Prerequisites Diagnostics Banner */}
          <SetupBanner />

          {/* Provider Nodes Marketplace */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-black text-slate-900">
                  2. Select Provider Nodes to Pool
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Real physical machines online in your community compute network.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-slate-500 bg-white border border-slate-200 px-3 py-1.5 rounded-xl shadow-sm">
                  {providers.length} provider{providers.length !== 1 ? 's' : ''} online
                </span>
                <button
                  onClick={() => loadProviders(true)}
                  disabled={loading}
                  className="px-4 py-2 bg-white border border-slate-200 hover:border-slate-300 text-xs font-bold text-slate-700 rounded-xl shadow-sm transition"
                >
                  {loading ? 'Refreshing...' : '↻ Refresh'}
                </button>
              </div>
            </div>

            {/* Direct Connect by IP Bar */}
            <div className="flex items-center gap-3 bg-white p-3.5 rounded-2xl border border-slate-200/90 shadow-sm">
              <span className="text-base pl-1">🌐</span>
              <input
                type="text"
                value={peerIp}
                onChange={e => setPeerIp(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') connectPeer(); }}
                placeholder="Connect node by Tailscale or LAN IP (e.g. 100.73.113.54 or 192.168.1.15)..."
                className="flex-1 text-xs font-mono text-slate-800 placeholder-slate-400 outline-none bg-transparent"
              />
              <button
                onClick={connectPeer}
                disabled={connectingPeer || !peerIp.trim()}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 active:bg-black text-white rounded-xl text-xs font-bold transition disabled:opacity-40 whitespace-nowrap"
              >
                {connectingPeer ? 'Pinging...' : '+ Connect Node'}
              </button>
            </div>

            {/* Zero Fake Data — Honest Real State */}
            {providers.length === 0 ? (
              <div className="bg-white border-2 border-dashed border-slate-200/90 rounded-3xl p-16 text-center shadow-sm flex flex-col items-center justify-center">
                <div className="w-16 h-16 rounded-2xl bg-blue-50 border border-blue-200/70 flex items-center justify-center text-3xl mb-4 text-blue-600">
                  🖥️
                </div>
                <h3 className="text-xl font-black text-slate-800">No External Provider Nodes Online</h3>
                <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto leading-relaxed">
                  There are currently no other computers sharing their hardware on your local network or Tailscale mesh.
                </p>

                <div className="mt-6 bg-slate-50 border border-slate-200 rounded-2xl p-6 text-left max-w-lg w-full space-y-2.5 text-xs text-slate-600">
                  <div className="font-bold text-slate-800 mb-1">To connect a second laptop or desktop:</div>
                  <div className="flex items-start gap-2">
                    <span className="font-bold text-blue-600">1.</span>
                    <span>Install or run C3 on the second computer and enter its machine name (e.g. "Laptop-2").</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-bold text-blue-600">2.</span>
                    <span>On that laptop, switch to the <strong>Provider tab</strong> and click <strong>"▶ Start Sharing"</strong>.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-bold text-blue-600">3.</span>
                    <span>If both laptops are on the same Wi-Fi, it will appear here automatically via P2P LAN broadcast!</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="font-bold text-blue-600">4.</span>
                    <span>If on different Wi-Fi networks, sign into Tailscale on both laptops or type its Tailscale IP into the connect bar above.</span>
                  </div>
                </div>

                <div className="mt-8 flex gap-3">
                  <button
                    onClick={() => loadProviders(true)}
                    className="px-6 py-3 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-bold rounded-xl shadow-sm transition"
                  >
                    ↻ Check Again
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                {providers.map(node => (
                  <NodeCard
                    key={node.userId}
                    node={node}
                    selected={selected.includes(node.userId)}
                    onToggle={() => toggleNode(node.userId)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

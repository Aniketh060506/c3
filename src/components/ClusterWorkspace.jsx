import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── Mini progress bar — light theme ──────────────────────────────────────────
function MiniMeter({ label, percent, valueText, color = 'blue' }) {
  const bars = { blue: 'bg-blue-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', indigo: 'bg-indigo-500', rose: 'bg-rose-500' };
  const texts = { blue: 'text-blue-700', emerald: 'text-emerald-700', amber: 'text-amber-700', indigo: 'text-indigo-700', rose: 'text-rose-700' };
  const pct = Math.min(100, Math.max(0, Math.round(percent || 0)));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-500 font-medium">{label}</span>
        <span className={`font-black ${texts[color]}`}>{valueText || `${pct}%`}</span>
      </div>
      <div className="h-1.5 bg-slate-100 border border-slate-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${bars[color]}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Node metric card — light theme ───────────────────────────────────────────
function NodeMetricCard({ node }) {
  const isMaster = node.isMaster;
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">{isMaster ? '👑' : '⚡'}</span>
          <div>
            <div className="text-xs font-black text-slate-900 font-mono">{node.displayName || node.name}</div>
            <div className="text-[10px] text-slate-500 font-mono">IP: {node.ip} · {node.cores || 0} Cores</div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-50 border border-emerald-200 text-emerald-700">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />
          READY
        </span>
      </div>
      <div className="space-y-2 pt-2 border-t border-slate-100">
        <MiniMeter label="CPU Load" percent={node.cpuPercent} valueText={`${node.cpuPercent?.toFixed(1) || 0}%`}
          color={node.cpuPercent > 80 ? 'rose' : node.cpuPercent > 40 ? 'amber' : 'blue'} />
        <MiniMeter label="Memory Usage" percent={node.memPercent}
          valueText={node.memUsage || (node.ramGb ? `${node.ramGb} GB` : '—')}
          color={node.memPercent > 85 ? 'rose' : 'emerald'} />
        {node.gpu && node.gpu !== 'None' && (
          <MiniMeter label={node.gpu.split('(')[0].trim()} percent={node.gpuPercent || 0}
            valueText={`${node.gpuPercent || 0}%${node.gpuTemp ? ` · ${node.gpuTemp}°C` : ''}`}
            color="indigo" />
        )}
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-0.5">
        <span>Role: <strong className="text-slate-600 font-bold">{node.role}</strong></span>
        <span>{node.netIo || 'Mesh'}</span>
      </div>
    </div>
  );
}

// ── Status dot ────────────────────────────────────────────────────────────────
function Dot({ ok, pulse }) {
  return (
    <span className={`w-2 h-2 rounded-full inline-block flex-shrink-0 ${
      ok === null ? 'bg-slate-300' :
      ok ? 'bg-emerald-500' : 'bg-red-500'
    } ${pulse && ok ? 'animate-pulse' : ''}`} />
  );
}

// ── Network Debug Panel ───────────────────────────────────────────────────────
function NetworkDebugPanel() {
  const [net, setNet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = window.c3?.getNetworkDebug ? await window.c3.getNetworkDebug() : null;
      setNet(res);
      setLastChecked(new Date().toLocaleTimeString());
    } catch (_) {}
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000); // refresh every 15s
    return () => clearInterval(t);
  }, []);

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <span className="text-sm">🔗</span>
          <span className="text-[11px] font-black text-slate-700 uppercase tracking-wider">Network Debug</span>
        </div>
        <button onClick={refresh} className="text-[10px] text-slate-400 hover:text-slate-700 font-bold transition" title="Refresh now">
          {loading ? <span className="inline-block w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" /> : '↻'}
        </button>
      </div>

      {loading && !net ? (
        <div className="px-4 py-5 text-center text-xs text-slate-400">Running diagnostics...</div>
      ) : !net ? (
        <div className="px-4 py-4 text-xs text-red-500">Debug unavailable</div>
      ) : (
        <div className="p-4 space-y-4">
          {/* Tailscale */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Dot ok={net.tailscale?.connected} pulse />
              <span className="text-[11px] font-black text-slate-700">Tailscale Mesh</span>
              {net.tailscale?.ip && (
                <span className="ml-auto text-[10px] font-mono font-bold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">
                  {net.tailscale.ip}
                </span>
              )}
            </div>
            {net.tailscale?.peers?.length > 0 ? (
              <div className="space-y-1">
                {net.tailscale.peers.map((peer, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] font-mono bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5">
                    <Dot ok={peer.online} />
                    <span className="font-bold text-slate-800 truncate">{peer.name}</span>
                    <span className="text-slate-400">{peer.ip}</span>
                    <span className={`ml-auto font-bold ${peer.online ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {peer.online ? (peer.relay === 'direct' ? '⚡ direct' : `via ${peer.relay}`) : 'offline'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-slate-400 font-mono px-1">
                {net.tailscale?.connected ? 'No other peers online' : 'Tailscale not connected'}
              </div>
            )}
          </div>

          {/* JuiceFS */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Dot ok={net.juicefs?.mounted || !!session?.workspacePath} />
              <span className="text-[11px] font-black text-slate-700">Shared Storage</span>
              {net.juicefs?.backend && (
                <span className="ml-auto text-[10px] font-mono font-bold text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded border border-purple-200">
                  {net.juicefs.backend}
                </span>
              )}
            </div>
            {net.juicefs?.mounted ? (
              <div className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 text-[10px] font-mono space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Mount:</span>
                  <span className="font-bold text-emerald-700">{net.juicefs.mountPoint} ✓</span>
                </div>
                {net.juicefs.usage && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Used:</span>
                      <span className="font-bold text-slate-800">{net.juicefs.usage.used} / {net.juicefs.usage.size} ({net.juicefs.usage.percent})</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Free:</span>
                      <span className="font-bold text-blue-700">{net.juicefs.usage.avail}</span>
                    </div>
                  </>
                )}
              </div>
            ) : session?.workspacePath ? (
              <div className="bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 text-[10px] font-mono space-y-1">
                <div className="flex justify-between items-center">
                  <span className="text-emerald-700 font-bold">Mount: /workspace ✓</span>
                  <span className="text-emerald-700 text-[9px] font-bold bg-emerald-100/70 px-1.5 py-0.5 rounded">DIRECT NVMe</span>
                </div>
                <div className="text-[10px] text-slate-600 truncate font-mono">
                  {session.workspacePath}
                </div>
              </div>
            ) : (
              <div className="text-[10px] text-amber-600 font-mono bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                No workspace mounted
              </div>
            )}
          </div>

          {/* Docker containers */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Dot ok={net.containers?.length > 0} />
              <span className="text-[11px] font-black text-slate-700">C3 Containers</span>
              <span className="ml-auto text-[10px] font-mono text-slate-500">{net.containers?.length || 0} running</span>
            </div>
            {net.containers?.length > 0 ? (
              <div className="space-y-1">
                {net.containers.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] font-mono bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5">
                    <Dot ok={c.ok} />
                    <span className="font-bold text-slate-800 truncate">{c.name}</span>
                    <span className={`ml-auto font-bold ${c.ok ? 'text-emerald-600' : 'text-red-500'}`}>{c.status?.split(' ').slice(0,2).join(' ')}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-red-500 font-mono px-1">No C3 containers running</div>
            )}
          </div>

          {/* K3s API */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Dot ok={net.k3sApi?.reachable} />
              <span className="text-[11px] font-black text-slate-700">K3s API Server</span>
              <span className="ml-auto text-[10px] font-mono text-slate-500">
                {net.k3sApi?.reachable ? `${net.k3sApi.nodeCount} node${net.k3sApi.nodeCount !== 1 ? 's' : ''} registered` : 'unreachable'}
              </span>
            </div>
            {net.k3sApi?.nodes?.length > 0 && (
              <div className="space-y-1">
                {net.k3sApi.nodes.map((n, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] font-mono bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5">
                    <Dot ok={true} />
                    <span className="font-bold text-slate-800">{n}</span>
                    <span className="ml-auto text-emerald-600 font-bold">Ready</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {lastChecked && (
            <div className="text-[10px] text-slate-300 text-right font-mono">Last checked: {lastChecked}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Quick command chip ────────────────────────────────────────────────────────
function QuickCmd({ label, onClick, color = 'slate' }) {
  const colors = {
    slate: 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200',
    blue: 'bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200',
    amber: 'bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-200',
    red: 'bg-red-50 hover:bg-red-100 text-red-600 border-red-200',
  };
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-lg border text-[11px] font-mono font-bold transition-colors ${colors[color]}`}>
      {label}
    </button>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ClusterWorkspace({ session, onEnd }) {
  const [command, setCommand] = useState('');
  const [executing, setExecuting] = useState(false);
  const [history, setHistory] = useState([]);
  const [histIndex, setHistIndex] = useState(-1);
  const [target, setTarget] = useState('node-1'); // default to master
  const [cwd, setCwd] = useState('/workspace');
  const [telemetry, setTelemetry] = useState(null);
  const [lines, setLines] = useState([{
    type: 'banner',
    text: `C3 Community Compute Cloud [Version 3.0.0]
Control Plane: Active on ${session?.tailscaleIp || '100.73.x.x'}:6443 (WireGuard Mesh)
Workspace: Mounted at /workspace (${session?.workspacePath || 'local'})
Interactive cluster shell ready. Use 'cd' to navigate or click quick buttons.\n`,
  }]);

  const terminalEndRef = useRef(null);
  const inputRef = useRef(null);

  const getTargetNodeLabel = useCallback((t) => {
    if (t === 'pod' || t === 'runner') return 'c3-worker-runner';
    if (t === 'node-2' || t === 'worker') return 'c3-worker';
    if (t === 'both' || t === 'all') return 'cluster-all';
    return 'control-plane';
  }, []);

  const currentPrompt = `root@${getTargetNodeLabel(target)}:${cwd}# `;

  useEffect(() => { terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines]);

  const push = useCallback(text => setLines(prev => [...prev, { type: 'out', text }]), []);

  const handleTargetChange = (newTarget) => {
    setTarget(newTarget);
    push(`[c3] Shifted active target to: ${getTargetNodeLabel(newTarget)}`);
  };

  useEffect(() => {
    if (!window.c3?.onClusterLog) return;
    const unsub = window.c3.onClusterLog(push);
    return () => unsub?.();
  }, [push]);

  useEffect(() => {
    const poll = async () => {
      try {
        if (window.c3?.getClusterTelemetry) {
          const t = await window.c3.getClusterTelemetry();
          setTelemetry(t);
        }
      } catch (_) {}
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, []);

  // Build dynamic node options from REAL telemetry (Control Plane ALWAYS Node 1, Worker ALWAYS Node 2, Pod available)
  const nodeOptions = React.useMemo(() => {
    const opts = [
      { value: 'both', label: 'All Nodes (Parallel)' },
      { value: 'pod', label: '📦 Workload Pod (c3-worker-runner — Python 3.10)' },
    ];
    if (telemetry?.nodes?.length > 0) {
      const sorted = [...telemetry.nodes].sort((a, b) => (b.isMaster ? 1 : 0) - (a.isMaster ? 1 : 0));
      sorted.forEach((node) => {
        if (node.isMaster) {
          opts.push({
            value: 'node-1',
            label: 'Node 1 — Control Plane (Master)',
          });
        } else {
          opts.push({
            value: 'node-2',
            label: `Node 2 — Compute Worker (${node.name || 'c3-self-worker'})`,
          });
        }
      });
    } else {
      opts.push({ value: 'node-1', label: 'Node 1 — Control Plane (Master)' });
    }
    return opts;
  }, [telemetry]);

  const runCommand = async (cmdString) => {
    const toRun = (cmdString || command).trim();
    if (!toRun || executing) return;
    if (toRun === 'clear' || toRun === 'cls') { setLines([]); setCommand(''); return; }
    setExecuting(true);
    setHistory(prev => [...prev, toRun]);
    setHistIndex(-1);
    const promptAtExec = `root@${getTargetNodeLabel(target)}:${cwd}# `;
    setLines(prev => [...prev, { type: 'cmd', text: toRun, prompt: promptAtExec }]);
    setCommand('');
    try {
      if (window.c3?.dispatchWorkload) {
        const res = await window.c3.dispatchWorkload({ target, command: toRun });
        if (res && res.cwd) {
          setCwd(res.cwd);
        }
        if (res && res.switchTarget) {
          setTarget(res.switchTarget);
        }
      } else {
        push('[ERROR] dispatchWorkload not available');
      }
    } catch (err) {
      push(`[ERROR] ${err.message}`);
    } finally {
      setExecuting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runCommand(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!history.length) return;
      const i = histIndex === -1 ? history.length - 1 : Math.max(0, histIndex - 1);
      setHistIndex(i); setCommand(history[i]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIndex === -1) return;
      const i = histIndex + 1;
      if (i >= history.length) { setHistIndex(-1); setCommand(''); }
      else { setHistIndex(i); setCommand(history[i]); }
    } else if (e.key === 'c' && e.ctrlKey) {
      setLines(prev => [...prev, { type: 'cmd', text: `${command} ^C` }]);
      setCommand(''); setExecuting(false);
    }
  };

  const telem = telemetry || { totalCores: 0, totalRamGb: 0, totalGpus: 0, nodeCount: 0, hostSystem: null, nodes: [] };
  const realNodeCount = telem.nodes?.length || 0;

  return (
    <div className="flex h-full w-full bg-white overflow-hidden">
      {/* ── LEFT SIDEBAR ────────────────────────────────────────────────── */}
      <div className="w-[340px] flex-shrink-0 bg-slate-50 border-r border-slate-200 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
            <div>
              <div className="text-xs font-black text-slate-900 uppercase tracking-wider">Supercomputer Pool</div>
              <div className="text-[11px] text-slate-500 font-mono">
                {realNodeCount} K3s Node{realNodeCount !== 1 ? 's' : ''} · {telem.totalCores || 0} Cores Pooled
              </div>
            </div>
          </div>
          <button onClick={onEnd}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 border border-red-200 text-red-600 text-xs font-black rounded-lg transition">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="2"/></svg>
            End
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Target selector — AT TOP FOR INSTANT VISIBILITY */}
          <div className="bg-white border-2 border-blue-200 rounded-xl p-4 shadow-sm space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-black text-blue-900 uppercase tracking-wider">Target Execution Engine</span>
              <span className="text-[10px] font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                Active: {getTargetNodeLabel(target)}
              </span>
            </div>
            <select value={target} onChange={e => handleTargetChange(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 font-bold focus:outline-none focus:border-blue-500 cursor-pointer">
              {nodeOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <div className="text-[10px] text-slate-500 font-mono">
              {target === 'node-1' ? 'Commands execute on Control Plane (c3-k3s-master)' :
               target === 'node-2' ? 'Commands execute on Compute Worker (c3-self-worker)' :
               'Commands execute in parallel across all cluster nodes'}
            </div>
          </div>

          {/* Host system */}
          {telem.hostSystem && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-black text-slate-500 uppercase tracking-wider">Host Physical System</span>
                <span className="text-[10px] font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-lg border border-blue-200">
                  {session?.tailscaleIp || telem.hostSystem?.ip || '100.73.x.x'}
                </span>
              </div>
              <div className="space-y-2">
                <MiniMeter label="Host CPU Load" percent={telem.hostSystem.cpuPercent}
                  valueText={`${telem.hostSystem.cpuPercent || 0}% Total`} color="indigo" />
                <MiniMeter label="Host Physical RAM" percent={telem.hostSystem.memPercent}
                  valueText={telem.hostSystem.memTotalGb ? `${telem.hostSystem.memUsedGb} / ${telem.hostSystem.memTotalGb} GB` : '—'}
                  color="amber" />
                {telem.hostSystem.gpuName && telem.hostSystem.gpuName !== 'None' && (
                  <MiniMeter label={telem.hostSystem.gpuName.split('(')[0].trim()}
                    percent={telem.hostSystem.gpuPercent || 0}
                    valueText={`${telem.hostSystem.gpuPercent || 0}%${telem.hostSystem.gpuTemp ? ` · ${telem.hostSystem.gpuTemp}°C` : ''}`}
                    color="emerald" />
                )}
                {telem.hostSystem.gpuName && telem.hostSystem.gpuName !== 'None' && telem.hostSystem.gpuMemPercent !== undefined && (
                  <MiniMeter label="Dedicated VRAM" percent={telem.hostSystem.gpuMemPercent || 0}
                    valueText={`${telem.hostSystem.gpuMemPercent || 0}% Used`} color="blue" />
                )}
              </div>
              <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>Workspace:</span>
                <span className="text-emerald-600 font-bold truncate max-w-[160px]">
                  {session?.workspacePath?.split('\\').pop() || session?.workspacePath?.split('/').pop() || '/workspace'}
                </span>
              </div>
            </div>
          )}

          {/* Live K3s nodes — REAL COUNT ONLY */}
          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[11px] font-black text-slate-500 uppercase tracking-wider">
                Live K3s Nodes ({realNodeCount})
              </span>
              <span className="text-[10px] text-emerald-600 font-mono font-bold">Real-Time (5s)</span>
            </div>
            {realNodeCount > 0 ? (
              telem.nodes.map((node, i) => <NodeMetricCard key={node.name || i} node={node} />)
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-5 text-center">
                <div className="w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin mx-auto mb-2" />
                <div className="text-xs text-slate-500">Querying K3s cluster nodes...</div>
              </div>
            )}
          </div>

          {/* Network Debug Panel */}
          <NetworkDebugPanel />
        </div>
      </div>

      {/* ── RIGHT — TERMINAL ────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Quick buttons toolbar */}
        <div className="flex-shrink-0 px-5 py-3 border-b border-slate-200 bg-white flex items-center gap-2 flex-wrap">
          {/* Prominent Node Switcher Buttons */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200 mr-2">
            <button
              onClick={() => handleTargetChange('node-1')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-black transition ${
                target === 'node-1' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/80'
              }`}>
              👑 Node 1 (Master)
            </button>
            <button
              onClick={() => handleTargetChange('node-2')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-black transition ${
                target === 'node-2' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/80'
              }`}>
              ⚡ Node 2 (Worker)
            </button>
            <button
              onClick={() => handleTargetChange('pod')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-black transition ${
                target === 'pod' ? 'bg-purple-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/80'
              }`}>
              📦 Workload Pod
            </button>
            <button
              onClick={() => handleTargetChange('both')}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-black transition ${
                target === 'both' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-white/80'
              }`}>
              🌐 All Nodes
            </button>
          </div>

          <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider mr-1">Quick:</span>
          <QuickCmd label="cd .." color="amber" onClick={() => runCommand('cd ..')} />
          <QuickCmd label="cd /workspace" color="amber" onClick={() => runCommand('cd /workspace')} />
          <QuickCmd label="ls -F" color="amber" onClick={() => runCommand('ls -F')} />
          <QuickCmd label="python train_model" color="purple" onClick={() => runCommand('python3 /workspace/train_distributed_model.py')} />
          <QuickCmd label="kubectl get nodes" color="blue" onClick={() => runCommand('kubectl get nodes -o wide')} />
          <QuickCmd label="kubectl get pods" color="blue" onClick={() => runCommand('kubectl get pods -A')} />
          <QuickCmd label="df -h" color="slate" onClick={() => runCommand('df -h')} />
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] font-mono text-slate-400">
              <strong className="text-slate-600">Enter</strong> to run · <strong className="text-slate-600">Ctrl+C</strong> to cancel
            </span>
            <QuickCmd label="clear" color="red" onClick={() => setLines([])} />
          </div>
        </div>

        {/* Terminal */}
        <div className="flex-1 overflow-y-auto bg-[#13151a] flex flex-col cursor-text"
          onClick={() => inputRef.current?.focus()}>
          {/* Tab strip */}
          <div className="flex-shrink-0 bg-[#0e1016] border-b border-[#1e2330] px-4 py-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 px-3 py-1 bg-[#13151a] border border-[#1e2330] rounded-lg">
              <span className="text-[11px] font-mono font-bold text-cyan-400">sh</span>
              <span className="text-[11px] font-mono text-slate-200">root@{getTargetNodeLabel(target)}:{cwd}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
            </div>
            <span className="text-[10px] font-mono text-slate-500 mr-2">
              Active Node: <strong className="text-cyan-400">{getTargetNodeLabel(target)}</strong>
            </span>
          </div>

          {/* Output */}
          <div className="flex-1 p-5 font-mono text-sm leading-relaxed space-y-0.5">
            {lines.map((item, idx) => {
              if (item.type === 'banner') return (
                <div key={idx} className="text-slate-500 whitespace-pre-wrap text-xs mb-4">{item.text}</div>
              );
              if (item.type === 'cmd') return (
                <div key={idx} className="flex items-start gap-2 text-slate-100 font-bold mt-3">
                  <span className="text-cyan-400 select-none whitespace-nowrap">{item.prompt || currentPrompt}</span>
                  <span className="break-all">{item.text}</span>
                </div>
              );
              const isErr = item.text.startsWith('[ERROR]') || item.text.includes('Error invoking');
              const isOk = item.text.startsWith('✓');
              const isDisp = item.text.startsWith('[dispatcher]');
              const isNode = item.text.startsWith('[node:');
              return (
                <div key={idx} className={`whitespace-pre-wrap break-all text-sm ${
                  isErr ? 'text-rose-400 font-semibold' :
                  isOk ? 'text-emerald-400 font-semibold' :
                  isDisp ? 'text-blue-400' :
                  isNode ? 'text-amber-300' : 'text-slate-300'
                }`}>{item.text}</div>
              );
            })}

            {/* Active prompt */}
            <div className="flex items-center gap-2 text-slate-100 font-bold pt-3 font-mono text-sm">
              <span className="text-cyan-400 whitespace-nowrap select-none">
                {currentPrompt}
              </span>
              <div className="flex-1 flex items-center">
                <input ref={inputRef} type="text" value={command}
                  onChange={e => setCommand(e.target.value)}
                  onKeyDown={handleKeyDown} disabled={executing}
                  className="w-full bg-transparent text-slate-100 font-mono text-sm outline-none border-none p-0 caret-cyan-400"
                  autoFocus spellCheck="false" autoComplete="off" />
              </div>
              {executing && (
                <span className="flex items-center gap-1.5 text-xs font-mono text-amber-400 animate-pulse">
                  <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                  running...
                </span>
              )}
            </div>
            <div ref={terminalEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

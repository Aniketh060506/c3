import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── Live Progress Mini-Bar ──────────────────────────────────────────────────
function MiniMeter({ label, percent, valueText, color = 'blue' }) {
  const barColors = {
    blue: 'bg-blue-500',
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    indigo: 'bg-indigo-500',
    rose: 'bg-rose-500',
  };
  const textColors = {
    blue: 'text-blue-400',
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    indigo: 'text-indigo-400',
    rose: 'text-rose-400',
  };

  const safePct = Math.min(100, Math.max(0, Math.round(percent || 0)));

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] font-mono">
        <span className="text-slate-400 font-medium">{label}</span>
        <span className={`font-bold ${textColors[color]}`}>
          {valueText || `${safePct}%`}
        </span>
      </div>
      <div className="h-1.5 bg-slate-800/80 rounded-full overflow-hidden border border-slate-700/50">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColors[color]}`}
          style={{ width: `${safePct}%` }}
        />
      </div>
    </div>
  );
}

// ── Live Node Provider Card ──────────────────────────────────────────────────
function NodeMetricCard({ node }) {
  const isMaster = node.isMaster;
  return (
    <div className="bg-[#131922] border border-slate-800/90 rounded-2xl p-4 shadow-md space-y-3 transition hover:border-slate-700">
      {/* Node Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">{isMaster ? '👑' : '⚡'}</span>
          <div>
            <div className="text-xs font-bold text-slate-200 tracking-tight font-mono">
              {node.displayName || node.name}
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              IP: {node.ip || '100.73.113.54'} · {node.cores || 32} Cores
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950/60 border border-emerald-700/60 text-emerald-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          READY
        </span>
      </div>

      {/* Live Node CPU, RAM & RTX 5050 GPU Meters */}
      <div className="space-y-2 pt-1 border-t border-slate-800/60">
        <MiniMeter
          label="CPU Load"
          percent={node.cpuPercent}
          valueText={`${node.cpuPercent?.toFixed(1) || 0}%`}
          color={node.cpuPercent > 80 ? 'rose' : node.cpuPercent > 40 ? 'amber' : 'blue'}
        />
        <MiniMeter
          label="Memory Usage"
          percent={node.memPercent}
          valueText={node.memUsage || `${node.ramGb || 7.4} GB DDR5`}
          color={node.memPercent > 85 ? 'rose' : 'emerald'}
        />
        <MiniMeter
          label="RTX 5050 GPU"
          percent={node.gpuPercent || 0}
          valueText={`${node.gpuPercent || 0}% · ${node.gpuTemp || 55}°C`}
          color="indigo"
        />
      </div>

      {/* Network & Role info */}
      <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 pt-0.5">
        <span>Role: <strong className="text-slate-300 font-semibold">{node.role}</strong></span>
        <span>{node.netIo || 'Live Mesh'}</span>
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function ClusterWorkspace({ session, onEnd }) {
  const [command, setCommand] = useState('');
  const [executing, setExecuting] = useState(false);
  const [history, setHistory] = useState([]);
  const [histIndex, setHistIndex] = useState(-1);
  const [target, setTarget] = useState('both');
  const [telemetry, setTelemetry] = useState(null);

  // Terminal history entries: array of { type: 'cmd'|'out'|'banner', text: string }
  const [lines, setLines] = useState([
    {
      type: 'banner',
      text: `Google DeepMind C3 Supercomputing Cluster [Version 3.0.0]\n(c) 2026 C3 Community Compute Cloud. All rights reserved.\n\nControl Plane: Active on 100.73.113.54:6443 (WireGuard Mesh)\nWorkspace: Mounted at /workspace (${session?.workspacePath || 'local'})\nNodes: 2 Active (Control Plane + Worker) · 64 Cores Pooled\n`,
    },
  ]);

  const terminalEndRef = useRef(null);
  const inlineInputRef = useRef(null);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, command]);

  // Focus inline terminal input when clicking anywhere in the terminal
  const focusTerminal = () => {
    inlineInputRef.current?.focus();
  };

  const pushTerminalOutput = useCallback(text => {
    setLines(prev => [...prev, { type: 'out', text }]);
  }, []);

  useEffect(() => {
    if (!window.c3?.onClusterLog) return;
    const unsub = window.c3.onClusterLog(line => pushTerminalOutput(line));
    return () => unsub?.();
  }, [pushTerminalOutput]);

  // Poll live telemetry every 2.5 seconds
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
    const timer = setInterval(poll, 2500);
    return () => clearInterval(timer);
  }, []);

  const runCommand = async (cmdString) => {
    const toRun = (cmdString || command).trim();
    if (!toRun || executing) return;

    if (toRun === 'clear' || toRun === 'cls') {
      setLines([]);
      setCommand('');
      return;
    }

    setExecuting(true);
    setHistory(prev => [...prev, toRun]);
    setHistIndex(-1);

    // Freeze prompt line with command
    setLines(prev => [...prev, { type: 'cmd', text: toRun }]);
    setCommand('');

    try {
      if (window.c3?.dispatchWorkload) {
        await window.c3.dispatchWorkload({ target, command: toRun });
      } else {
        pushTerminalOutput('[ERROR] dispatchWorkload API not available');
      }
    } catch (err) {
      pushTerminalOutput(`[ERROR] ${err.message}`);
    } finally {
      setExecuting(false);
      setTimeout(() => inlineInputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIdx = histIndex === -1 ? history.length - 1 : Math.max(0, histIndex - 1);
      setHistIndex(nextIdx);
      setCommand(history[nextIdx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIndex === -1) return;
      const nextIdx = histIndex + 1;
      if (nextIdx >= history.length) {
        setHistIndex(-1);
        setCommand('');
      } else {
        setHistIndex(nextIdx);
        setCommand(history[nextIdx]);
      }
    } else if (e.key === 'c' && e.ctrlKey) {
      // Ctrl+C
      setLines(prev => [...prev, { type: 'cmd', text: `${command} ^C` }]);
      setCommand('');
      setExecuting(false);
    }
  };

  const telem = telemetry || {
    totalCores: 64,
    totalRamGb: 14.8,
    totalGpus: 0,
    nodeCount: 2,
    hostSystem: {
      cpuPercent: 24,
      memUsedGb: 14.2,
      memTotalGb: 15.2,
      memPercent: 93,
    },
    nodes: [
      {
        name: 'b3a7a5751152',
        displayName: 'Control Plane (Master)',
        role: 'Master Node',
        isMaster: true,
        status: 'Ready',
        ip: '100.73.113.54',
        cores: 32,
        ramGb: 7.4,
        cpuPercent: 12,
        memPercent: 6,
        memUsage: '422MB / 7.4GB',
        netIo: '21.8MB In / 1.8MB Out',
      },
      {
        name: 'docker-desktop',
        displayName: 'Worker Node (docker-desktop)',
        role: 'Compute Worker',
        isMaster: false,
        status: 'Ready',
        ip: '192.168.65.3',
        cores: 32,
        ramGb: 7.4,
        cpuPercent: 4,
        memPercent: 3,
        memUsage: '178MB / 7.4GB',
        netIo: 'Live Mesh',
      },
    ],
  };

  return (
    <div className="flex h-full w-full bg-[#0a0d13] text-slate-100 overflow-hidden font-sans">
      {/* ═══════════════════════════════════════════════════════════════════════
          LEFT SIDEBAR: LIVE SYSTEM & ALL PROVIDER METRICS (~360px)
      ═══════════════════════════════════════════════════════════════════════ */}
      <div className="w-[380px] flex-shrink-0 bg-[#0e131b] border-r border-slate-800 flex flex-col overflow-hidden">
        {/* Top Header */}
        <div className="p-5 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
            <div>
              <div className="text-sm font-black text-slate-100 uppercase tracking-wider font-mono">
                Supercomputer Pool
              </div>
              <div className="text-[11px] text-slate-400 font-mono">
                {telem.nodeCount || 2} Nodes · {telem.totalCores || 64} Cores Pooled
              </div>
            </div>
          </div>
          <button
            onClick={onEnd}
            className="px-3.5 py-1.5 bg-red-950/60 hover:bg-red-900 border border-red-700/60 text-red-300 text-xs font-bold rounded-xl transition"
          >
            ⏹ End
          </button>
        </div>

        {/* Scrollable Metrics Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Host Machine Overview Card */}
          <div className="bg-[#131922] border border-slate-800/90 rounded-2xl p-4 shadow-md space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider font-mono">
                Host Physical System
              </span>
              <span className="text-[10px] text-blue-400 font-mono font-bold bg-blue-950/60 px-2 py-0.5 rounded border border-blue-800">
                100.73.113.54
              </span>
            </div>

            <div className="space-y-2.5">
              <MiniMeter
                label="Host CPU Load"
                percent={telem.hostSystem?.cpuPercent}
                valueText={`${telem.hostSystem?.cpuPercent || 0}% Total`}
                color="indigo"
              />
              <MiniMeter
                label="Host Physical RAM"
                percent={telem.hostSystem?.memPercent}
                valueText={`${telem.hostSystem?.memUsedGb || 13.9} / ${telem.hostSystem?.memTotalGb || 15.2} GB DDR5`}
                color="amber"
              />
              <MiniMeter
                label="Host RTX 5050 GPU"
                percent={telem.hostSystem?.gpuPercent || 0}
                valueText={`${telem.hostSystem?.gpuPercent || 0}% · ${telem.hostSystem?.gpuTemp || 55}°C`}
                color="emerald"
              />
              <MiniMeter
                label="Dedicated VRAM"
                percent={telem.hostSystem?.gpuMemPercent || 3}
                valueText="8 GB GDDR6"
                color="blue"
              />
            </div>

            <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] font-mono text-slate-400">
              <span>Workspace:</span>
              <span className="text-emerald-400 font-bold truncate max-w-[180px]">
                {session?.workspacePath?.split('\\').pop() || session?.workspacePath?.split('/').pop() || '/workspace'}
              </span>
            </div>
          </div>

          {/* Section: Live Nodes / Providers */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between px-1">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider font-mono">
                Live Compute Nodes ({telem.nodes?.length || 2})
              </span>
              <span className="text-[10px] text-emerald-400 font-mono">Real-Time (2.5s)</span>
            </div>

            {telem.nodes?.map((node, i) => (
              <NodeMetricCard key={node.name || i} node={node} />
            ))}
          </div>

          {/* Target Dispatch Selector */}
          <div className="bg-[#131922] border border-slate-800/90 rounded-2xl p-4 shadow-md space-y-2">
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider font-mono">
              Target Execution Engine
            </div>
            <select
              value={target}
              onChange={e => setTarget(e.target.value)}
              className="w-full bg-[#1b2230] border border-slate-700/80 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="both">All Nodes (Parallel Distribution)</option>
              <option value="node-1">Node 1 — Control Plane (Master)</option>
              <option value="node-2">Node 2 — Compute Worker</option>
            </select>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          RIGHT: NORMAL LIVE TERMINAL (LIKE WINDOWS TERMINAL / IMAGE 2)
          No bottom box! Prompt is directly at the current active line.
      ═══════════════════════════════════════════════════════════════════════ */}
      <div
        className="flex-1 flex flex-col bg-[#0c0f16] overflow-hidden select-text cursor-text"
        onClick={focusTerminal}
      >
        {/* Terminal Tab Bar (Windows Terminal Style like Image 2) */}
        <div className="flex-shrink-0 h-10 bg-[#090b10] border-b border-slate-800 flex items-center px-2 select-none justify-between">
          <div className="flex items-center h-full">
            {/* Active Tab */}
            <div className="h-full px-4 bg-[#0c0f16] border-t-2 border-t-blue-500 border-x border-x-slate-800/80 flex items-center gap-2.5 text-xs font-mono text-slate-200">
              <span className="text-blue-400 font-bold">PS</span>
              <span className="font-semibold truncate max-w-[200px]">c3@control-plane:/workspace</span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 ml-1" />
            </div>

            {/* Quick Helper Actions */}
            <div className="flex items-center gap-1.5 ml-4">
              <button
                onClick={(e) => { e.stopPropagation(); runCommand('kubectl get nodes -o wide'); }}
                className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800/60 hover:bg-slate-700 text-cyan-400 border border-slate-700/50 transition"
              >
                get nodes
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); runCommand('kubectl get pods -A'); }}
                className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800/60 hover:bg-slate-700 text-cyan-400 border border-slate-700/50 transition"
              >
                get pods
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); runCommand('ls -lh'); }}
                className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800/60 hover:bg-slate-700 text-amber-300 border border-slate-700/50 transition"
              >
                ls workspace
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setLines([]); }}
                className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800/60 hover:bg-slate-700 text-slate-400 border border-slate-700/50 transition"
              >
                cls
              </button>
            </div>
          </div>

          <div className="text-[11px] font-mono text-slate-500 pr-3">
            Press <strong className="text-slate-400">Enter</strong> to run · <strong className="text-slate-400">Ctrl+C</strong> to cancel
          </div>
        </div>

        {/* ── Terminal Content Canvas ── */}
        <div className="flex-1 overflow-y-auto p-5 font-mono text-sm leading-relaxed text-slate-300 space-y-1">
          {lines.map((item, idx) => {
            if (item.type === 'banner') {
              return (
                <div key={idx} className="text-slate-400 whitespace-pre-wrap select-text mb-4 text-xs font-mono">
                  {item.text}
                </div>
              );
            }
            if (item.type === 'cmd') {
              return (
                <div key={idx} className="flex items-center gap-2 text-slate-100 font-bold select-text mt-2">
                  <span className="text-cyan-400 select-none">PS C:\Users\Aniketh&gt;</span>
                  <span>{item.text}</span>
                </div>
              );
            }
            return (
              <div
                key={idx}
                className={`whitespace-pre-wrap break-all ${
                  item.text.startsWith('[ERROR]') || item.text.includes('Error')
                    ? 'text-rose-400 font-semibold'
                    : item.text.startsWith('✓')
                    ? 'text-emerald-400 font-semibold'
                    : item.text.startsWith('[dispatcher]')
                    ? 'text-blue-400'
                    : item.text.startsWith('[node:')
                    ? 'text-amber-300 font-semibold'
                    : 'text-slate-300'
                }`}
              >
                {item.text}
              </div>
            );
          })}

          {/* ── Active Inline Prompt (Just like Windows Terminal / Image 2) ── */}
          <div className="flex items-center gap-2 text-slate-100 font-bold pt-1 select-none">
            <span className="text-cyan-400 whitespace-nowrap select-none font-bold">
              PS C:\Users\Aniketh&gt;
            </span>

            {/* Invisible native input with inline text and caret */}
            <div className="flex-1 relative flex items-center">
              <input
                ref={inlineInputRef}
                type="text"
                value={command}
                onChange={e => setCommand(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={executing}
                className="w-full bg-transparent text-slate-100 font-mono text-sm outline-none border-none p-0 focus:ring-0 focus:outline-none"
                autoFocus
                spellCheck="false"
                autoComplete="off"
              />
              {/* Blinking cursor if empty */}
              {!command && !executing && (
                <span className="w-2.5 h-4 bg-slate-300 inline-block animate-pulse -ml-full select-none pointer-events-none" />
              )}
            </div>

            {executing && (
              <span className="flex items-center gap-2 text-xs font-mono text-amber-400 select-none animate-pulse">
                <div className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                running...
              </span>
            )}
          </div>

          <div ref={terminalEndRef} />
        </div>
      </div>
    </div>
  );
}

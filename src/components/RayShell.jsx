import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import ClusterExplorer from './ClusterExplorer';
import {
  Terminal as TerminalIcon,
  Play,
  RotateCw,
  Sparkles,
  Layers,
  Cpu,
  Trash2,
  Maximize2,
  Copy,
  Check,
  Brain,
  Activity,
  Zap,
  Globe,
  Square,
  BarChart3,
  Server,
  ArrowUpRight,
  ShieldCheck,
  Clock,
  ChevronRight,
  TrendingDown,
  FolderOpen,
} from 'lucide-react';

export default function RayShell({ specs, onSwitchTab }) {
  const [activeSubTab, setActiveSubTab] = useState('studio'); // 'studio' | 'terminal' | 'dashboard'
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('ray_synthetic_classification');
  const [jobMode, setJobMode] = useState('benchmark');
  const [projectEntrypoint, setProjectEntrypoint] = useState('main.py');
  const [projectArgs, setProjectArgs] = useState('');
  const [epochs, setEpochs] = useState(10);
  const [batchSize, setBatchSize] = useState(128);
  const [activeJob, setActiveJob] = useState(null);
  const [clusterStatus, setClusterStatus] = useState(null);
  const [k3sStatus, setK3sStatus] = useState(null);
  const [startingJob, setStartingJob] = useState(false);
  const [startingRay, setStartingRay] = useState(false);
  const [stoppingJob, setStoppingJob] = useState(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [terminalTarget, setTerminalTarget] = useState('Connecting…');
  const [terminalTargetSpec, setTerminalTargetSpec] = useState(null);
  const [terminalKind, setTerminalKind] = useState('cluster');

  // Terminal refs
  const terminalRef = useRef(null);
  const termInstance = useRef(null);
  const fitAddon = useRef(null);
  const logsEndRef = useRef(null);

  const quickCommands = [
    { label: 'Cluster Nodes', cmd: 'kubectl get nodes -o wide\r\n', requiresCluster: true },
    { label: 'All Pods', cmd: 'kubectl get pods -A -o wide\r\n', requiresCluster: true },
    { label: 'Services', cmd: 'kubectl get services -A\r\n', requiresCluster: true },
    { label: 'Ray Nodes', cmd: 'kubectl exec -n c3-ray c3-ray-head -- python -c "import ray; ray.init(address=\'auto\'); print(ray.nodes())"\r\n', requiresCluster: true },
    { label: 'Clear Screen', cmd: null },
  ];

  // 1. Load initial Ray templates & status
  useEffect(() => {
    async function loadRayData() {
      try {
        if (window.c3?.getRayTemplates) {
          const tpls = await window.c3.getRayTemplates();
          if (tpls && tpls.length > 0) {
            setTemplates(tpls);
            setSelectedTemplateId(tpls[0].id);
            setEpochs(tpls[0].defaultEpochs);
            setBatchSize(tpls[0].batchSize);
          }
        }
        if (window.c3?.getRayJob) {
          const job = await window.c3.getRayJob();
          if (job) setActiveJob(job);
        }
        if (window.c3?.getRayStatus) {
          const st = await window.c3.getRayStatus();
          if (st) setClusterStatus(st);
        }
        if (window.c3?.getClusterStatus) {
          const k3s = await window.c3.getClusterStatus();
          if (k3s) setK3sStatus(k3s);
        }
      } catch (err) {
        console.error('[Ray] Failed to load initial Ray data:', err);
      }
    }
    loadRayData();
  }, []);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const [ray, k3s] = await Promise.all([
          window.c3?.getRayStatus?.(),
          window.c3?.getClusterStatus?.(),
        ]);
        if (ray) setClusterStatus(ray);
        if (k3s) setK3sStatus(k3s);
      } catch (_) {}
    }, 8000);
    return () => clearInterval(timer);
  }, []);

  // 2. Subscribe to live Ray Job events from main process
  useEffect(() => {
    const unsubs = [];

    if (window.c3?.onRayJobProgress) {
      unsubs.push(
        window.c3.onRayJobProgress((job) => {
          setActiveJob({ ...job });
        })
      );
    }

    if (window.c3?.onRayJobCompleted) {
      unsubs.push(
        window.c3.onRayJobCompleted((job) => {
          setActiveJob({ ...job });
        })
      );
    }

    if (window.c3?.onRayJobStarted) {
      unsubs.push(
        window.c3.onRayJobStarted((job) => {
          setActiveJob({ ...job });
        })
      );
    }

    if (window.c3?.onRayJobStopped) {
      unsubs.push(
        window.c3.onRayJobStopped((job) => {
          setActiveJob({ ...job });
        })
      );
    }

    return () => {
      unsubs.forEach((u) => u && u());
    };
  }, []);

  // 3. Auto-scroll training logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollTop = logsEndRef.current.scrollHeight;
    }
  }, [activeJob?.logs]);

  // 4. Initialize Terminal when terminal sub-tab is active
  useEffect(() => {
    if (activeSubTab !== 'terminal' || !terminalRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#090d16',
        foreground: '#e2e8f0',
        cursor: '#818cf8',
        selectionBackground: 'rgba(99, 102, 241, 0.35)',
        black: '#090d16',
        red: '#f87171',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#38bdf8',
        white: '#f8fafc',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: 'block',
      convertEol: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalRef.current);
    fit.fit();

    termInstance.current = term;
    fitAddon.current = fit;

    let shellReady = false;
    setTerminalReady(false);
    setTerminalTarget('Connecting…');
    term.onData((data) => {
      if (shellReady && window.c3?.writeTerminal) {
        window.c3.writeTerminal(data);
      }
    });

    let unsub = null;
    if (window.c3?.onTerminalData) {
      unsub = window.c3.onTerminalData((data) => {
        term.write(data);
      });
    }

    if (window.c3?.initTerminal) {
      window.c3.initTerminal(terminalTargetSpec)
        .then(result => {
          shellReady = Boolean(result?.ok);
          setTerminalReady(shellReady);
          setTerminalTarget(result?.target || 'Shell');
          setTerminalKind(result?.kind || 'cluster');
          if (shellReady) term.focus();
        })
        .catch(error => term.write(`\r\n\x1b[31mTerminal failed to start: ${error.message}\x1b[0m\r\n`));
    }

    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch (_) {}
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      if (unsub) unsub();
      if (window.c3?.killTerminal) {
        window.c3.killTerminal();
      }
      setTerminalReady(false);
      term.dispose();
      termInstance.current = null;
    };
  }, [activeSubTab, terminalTargetSpec]);

  const handleTemplateSelect = (tpl) => {
    setSelectedTemplateId(tpl.id);
    setEpochs(tpl.defaultEpochs);
    setBatchSize(tpl.batchSize);
  };

  const handleStartTraining = async () => {
    setStartingJob(true);
    try {
      if (window.c3?.startRayJob) {
        const job = await window.c3.startRayJob(jobMode === 'project'
          ? { mode: 'project', entrypoint: projectEntrypoint, scriptArgs: projectArgs }
          : { mode: 'benchmark', templateId: selectedTemplateId, epochs: Number(epochs), batchSize: Number(batchSize) });
        setActiveJob(job);
      }
    } catch (err) {
      alert(`Failed to start job: ${err.message}`);
    } finally {
      setStartingJob(false);
    }
  };

  const handleStopTraining = async () => {
    setStoppingJob(true);
    try {
      if (window.c3?.stopRayJob) {
        await window.c3.stopRayJob();
      }
    } finally {
      setStoppingJob(false);
    }
  };

  const handleStartRay = async () => {
    setStartingRay(true);
    try {
      const status = await window.c3?.startRayCluster?.();
      if (status) setClusterStatus(status);
      if (status?.status !== 'ONLINE') throw new Error(status?.error || 'Ray did not become ready.');
    } catch (err) {
      alert(`Could not start Ray across the Ready K3s nodes: ${err.message}`);
      try {
        const status = await window.c3?.getRayStatus?.();
        if (status) setClusterStatus(status);
      } catch (_) {}
    } finally {
      setStartingRay(false);
    }
  };

  const handleRunCommand = (cmd) => {
    if (cmd === null) {
      termInstance.current?.clear();
      return;
    }
    if (window.c3?.writeTerminal) {
      window.c3.writeTerminal(cmd);
    }
  };

  const handleRestartShell = () => {
    setTerminalReady(false);
    setTerminalTarget('Connecting…');
    if (termInstance.current) {
      termInstance.current.clear();
      termInstance.current.write('\x1b[38;5;141mRestarting shell session...\x1b[0m\r\n');
    }
    if (window.c3?.initTerminal) {
      window.c3.initTerminal(terminalTargetSpec).then(result => {
        setTerminalReady(Boolean(result?.ok));
        setTerminalTarget(result?.target || 'Shell');
        setTerminalKind(result?.kind || 'cluster');
        termInstance.current?.focus();
      }).catch(error => termInstance.current?.write(`\r\n\x1b[31mTerminal failed to start: ${error.message}\x1b[0m\r\n`));
    }
  };

  const openPodShell = (target) => {
    setTerminalTargetSpec(target);
    setActiveSubTab('terminal');
  };

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0];
  const jobIsRunning = ['RUNNING', 'DOWNLOADING_RESULTS'].includes(activeJob?.status);

  const handleOpenResults = async () => {
    try {
      const result = await window.c3?.openRayResults?.(activeJob?.jobId);
      if (!result?.ok) alert(result?.error || 'Could not open the results folder.');
    } catch (error) {
      alert(`Could not open results: ${error.message}`);
    }
  };

  // Helper to render Loss Chart SVG Path
  const renderLossChart = () => {
    const history = activeJob?.lossHistory || [];
    if (history.length < 2) {
      return (
        <div className="h-full flex items-center justify-center text-xs text-slate-400 font-mono">
          Gathering initial batch gradients...
        </div>
      );
    }

    const minLoss = Math.min(...history) * 0.9;
    const maxLoss = Math.max(...history) * 1.05;
    const range = maxLoss - minLoss || 1;

    const width = 420;
    const height = 110;

    const points = history.map((val, idx) => {
      const x = (idx / (history.length - 1)) * width;
      const y = height - ((val - minLoss) / range) * (height - 18) - 9;
      return `${x},${y}`;
    });

    const pathData = `M 0,${height} L ${points[0]} ` + points.map((p) => `L ${p}`).join(' ') + ` L ${width},${height} Z`;
    const lineData = `M ${points[0]} ` + points.map((p) => `L ${p}`).join(' ');

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
        <defs>
          <linearGradient id="lossGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#818cf8" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#818cf8" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        {/* Fill Area */}
        <path d={pathData} fill="url(#lossGradient)" />
        {/* Stroke Line */}
        <path d={lineData} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {/* Current Endpoint Pulse */}
        {points.length > 0 && (
          <circle
            cx={points[points.length - 1].split(',')[0]}
            cy={points[points.length - 1].split(',')[1]}
            r="4.5"
            fill="#4f46e5"
            stroke="#ffffff"
            strokeWidth="2"
            className="animate-pulse"
          />
        )}
      </svg>
    );
  };

  return (
    <div className="workspace-page w-full h-full flex flex-col p-6 md:p-8 space-y-5 select-none ambient-canvas overflow-y-auto">
      {/* ── Top Header & Sub-Tab Switcher ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-600 animate-pulse" />
            <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-slate-500">
              PHASE 5 &amp; 6 · RAY AI DISTRIBUTED SUPERCOMPUTING
            </span>
          </div>
          <h1 className="text-2xl font-black text-slate-900 font-display flex items-center gap-2">
            <span>Ray AI Studio &amp; Terminal</span>
            {activeJob?.status === 'RUNNING' && (
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/10 text-amber-600 border border-amber-500/30 animate-pulse">
                TRAINING IN PROGRESS
              </span>
            )}
          </h1>
        </div>

        {/* Studio Sub-Navigation Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-100/90 border border-slate-200/80 rounded-2xl shadow-soft-sm">
          <button
            onClick={() => setActiveSubTab('explorer')}
            className={`expand-card flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${activeSubTab === 'explorer' ? 'bg-white text-indigo-600 shadow-soft font-black' : 'text-slate-600 hover:text-slate-900'}`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>Nodes &amp; Pods</span>
          </button>
          <button
            onClick={() => setActiveSubTab('studio')}
            className={`expand-card flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeSubTab === 'studio'
                ? 'bg-white text-indigo-600 shadow-soft font-black'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            <span>AI Training Studio</span>
          </button>

          <button
            onClick={() => setActiveSubTab('terminal')}
            className={`expand-card flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeSubTab === 'terminal'
                ? 'bg-white text-indigo-600 shadow-soft font-black'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <TerminalIcon className="w-3.5 h-3.5" />
            <span>Cluster shell</span>
          </button>

          <button
            onClick={() => setActiveSubTab('dashboard')}
            className={`expand-card flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
              activeSubTab === 'dashboard'
                ? 'bg-white text-indigo-600 shadow-soft font-black'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Ray Dashboard</span>
          </button>
        </div>
      </div>

      {/* ───────────────────────────────────────────────────────────── */}
      {/* ── VIEW 1: AI TRAINING STUDIO ── */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeSubTab === 'studio' && (
        <div className="space-y-6">
          <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-soft-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-black text-slate-900">Choose what to run</div>
                <div className="mt-1 text-xs text-slate-500">Run the built-in synthetic benchmark or distribute your selected Python project to the Ray nodes.</div>
              </div>
              <div className="flex rounded-xl bg-slate-100 p-1">
                <button disabled={jobIsRunning} onClick={() => setJobMode('benchmark')} className={`rounded-lg px-3 py-2 text-xs font-bold ${jobMode === 'benchmark' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600'}`}>Synthetic benchmark</button>
                <button disabled={jobIsRunning} onClick={() => setJobMode('project')} className={`rounded-lg px-3 py-2 text-xs font-bold ${jobMode === 'project' ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600'}`}>My project</button>
              </div>
            </div>
            {jobMode === 'project' && (
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
                <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500">
                  Python entry point
                  <input value={projectEntrypoint} disabled={jobIsRunning} onChange={event => setProjectEntrypoint(event.target.value)} placeholder="main.py or src/train.py" className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-800 outline-none focus:border-indigo-400" />
                </label>
                <label className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-500">
                  Script arguments (optional)
                  <input value={projectArgs} disabled={jobIsRunning} onChange={event => setProjectArgs(event.target.value)} placeholder="--config config.yaml" className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-800 outline-none focus:border-indigo-400" />
                </label>
                <div className="text-xs text-slate-500 md:max-w-72">Workspace: <span className="font-mono text-slate-700">{k3sStatus?.workspacePath || 'Start a cluster with a selected folder first'}</span></div>
                <div className="md:col-span-3 rounded-xl bg-indigo-50 px-3 py-2 text-xs leading-relaxed text-indigo-900">
                  C3 bundles project files (up to 200 MiB) with the job. It runs your entry point once on each live Ray node and saves one result ZIP per node to <code>workspace/C3-results/job-id</code>. Use <code>C3_NODE_INDEX</code>, <code>C3_NODE_COUNT</code>, <code>C3_INPUT_DIR</code>, and <code>C3_OUTPUT_DIR</code> in your script to split input and write output. A root <code>requirements.txt</code> is installed on each node. Project files and code go to every joined provider, so only submit data and scripts you trust those machines to receive and run.
                </div>
              </div>
            )}
          </section>

          {/* Workload Template Picker Cards */}
          {jobMode === 'benchmark' && <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {templates.map((tpl) => {
              const isSelected = selectedTemplateId === tpl.id;
              return (
                <div
                  key={tpl.id}
                  onClick={() => handleTemplateSelect(tpl)}
                  className={`expand-card relative p-5 rounded-[24px] border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-white border-indigo-500 shadow-soft-lg ring-2 ring-indigo-500/10'
                      : 'bg-white/70 hover:bg-white border-slate-200/80 shadow-soft-sm'
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-md">
                      {tpl.category}
                    </span>
                    {isSelected && (
                      <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 ring-4 ring-indigo-100" />
                    )}
                  </div>
                  <h3 className="text-sm font-black text-slate-900 mb-1">{tpl.name}</h3>
                  <p className="text-xs text-slate-500 line-clamp-2 mb-3">{tpl.description}</p>
                  <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono text-slate-400">
                    <span>{tpl.framework}</span>
                    <span>{tpl.defaultEpochs} Epochs</span>
                  </div>
                </div>
              );
            })}
          </div>}

          {/* Hyperparameters & Launch Bar */}
          <div className="bg-white/90 border border-slate-200/80 rounded-[28px] p-5 shadow-soft flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-6 w-full md:w-auto">
              {jobMode === 'benchmark' && <><div>
                <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  Epochs
                </label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  disabled={activeJob?.status === 'RUNNING'}
                  value={epochs}
                  onChange={(e) => setEpochs(e.target.value)}
                  className="w-20 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono font-bold text-slate-800 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  Batch Size
                </label>
                <input
                  type="number"
                  min="8"
                  max="4096"
                  step="8"
                  disabled={activeJob?.status === 'RUNNING'}
                  value={batchSize}
                  onChange={(e) => setBatchSize(e.target.value)}
                  className="w-24 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono font-bold text-slate-800 focus:outline-none focus:border-indigo-500"
                />
              </div></>}

              <div>
                <label className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block mb-1">
                  Hardware Acceleration
                </label>
                <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-amber-500" />
                  <span>Ray + NumPy on CPU (GPU scheduling unavailable)</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 w-full md:w-auto justify-end">
              {jobIsRunning ? (
                <button
                  onClick={handleStopTraining}
                  disabled={stoppingJob || activeJob?.status === 'DOWNLOADING_RESULTS'}
                  className="expand-card px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-full text-xs font-bold shadow-soft transition cursor-pointer flex items-center gap-2"
                >
                  <Square className="w-3.5 h-3.5 fill-white" />
                  <span>{activeJob?.status === 'DOWNLOADING_RESULTS' ? 'Collecting results...' : stoppingJob ? 'Stopping Job...' : 'Abort Distributed Job'}</span>
                </button>
              ) : (
                <button
                  onClick={handleStartTraining}
                  disabled={startingJob || (jobMode === 'project' && (!k3sStatus?.workspacePath || k3sStatus?.status !== 'ACTIVE'))}
                  className="expand-card px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full text-xs font-bold shadow-soft transition cursor-pointer flex items-center gap-2"
                >
                  <Play className="w-3.5 h-3.5 fill-white" />
                  <span>{startingJob ? 'Preparing project...' : jobMode === 'project' ? 'Run on Ray nodes' : `Launch ${selectedTemplate?.name?.split(' ')[1] || 'AI Job'}`}</span>
                </button>
              )}
            </div>
          </div>

          {/* Real-Time Live Job Telemetry Dashboard */}
          {activeJob && (
            activeJob.mode === 'project' ? (
              <div className="space-y-4">
                <section className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-soft-sm">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-indigo-600">Distributed Python project</div>
                      <h3 className="mt-1 text-lg font-black text-slate-900">{activeJob.entrypoint}</h3>
                      <p className="mt-1 text-sm text-slate-500">Status: <span className="font-bold text-slate-800">{activeJob.status === 'DOWNLOADING_RESULTS' ? 'Collecting node outputs…' : activeJob.status}</span> · {activeJob.nodes?.length || 0} node(s) reported</p>
                    </div>
                    {activeJob.resultsPath && <button onClick={handleOpenResults} className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-700"><FolderOpen size={16} /> Open downloaded results</button>}
                  </div>
                  {activeJob.resultsPath && <div className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 font-mono text-xs text-emerald-900">Saved on this PC: {activeJob.resultsPath}</div>}
                  {activeJob.artifacts?.length > 0 && <div className="mt-4 space-y-2">{activeJob.artifacts.map(file => <div key={file.name} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm"><span className="font-mono text-slate-800">{file.name}</span><span className="text-xs text-slate-500">{file.node} · {(file.bytes / 1024).toFixed(1)} KiB of output</span></div>)}</div>}
                  {activeJob.nodes?.length > 0 && <div className="mt-3 text-xs text-slate-500">Executed on: {activeJob.nodes.join(', ')}</div>}
                </section>
                <div className="rounded-[24px] bg-[#090d16] p-5 text-slate-200 shadow-2xl">
                  <div className="mb-3 flex items-center gap-2 border-b border-slate-800 pb-3 text-xs font-mono font-bold uppercase text-slate-300"><Activity size={14} /> Project logs</div>
                  <div ref={logsEndRef} className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs select-text">{(activeJob.logs || []).map((line, idx) => <div key={idx} className="whitespace-pre-wrap break-words">{line}</div>)}</div>
                </div>
              </div>
            ) : (
            <div className="space-y-4">
              {/* Telemetry Metrics Row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {/* 1. Loss Descent */}
                <div className="p-4 rounded-[24px] bg-white border border-slate-200/80 shadow-soft">
                  <div className="flex items-center justify-between text-slate-400 mb-1">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
                      Synthetic Batch Loss
                    </span>
                    <TrendingDown className="w-3.5 h-3.5 text-indigo-500" />
                  </div>
                  <div className="text-2xl font-black font-mono text-slate-900">
                    {activeJob.loss !== null && activeJob.loss !== undefined ? activeJob.loss.toFixed(4) : '--'}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1">
                    Initial: {activeJob.initialLoss !== null && activeJob.initialLoss !== undefined ? activeJob.initialLoss.toFixed(4) : '--'}
                  </div>
                </div>

                {/* 2. Top-1 Accuracy */}
                <div className="p-4 rounded-[24px] bg-white border border-slate-200/80 shadow-soft">
                  <div className="flex items-center justify-between text-slate-400 mb-1">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
                      Synthetic Batch Accuracy
                    </span>
                    <BarChart3 className="w-3.5 h-3.5 text-emerald-500" />
                  </div>
                  <div className="text-2xl font-black font-mono text-slate-900">
                    {activeJob.accuracy !== null && activeJob.accuracy !== undefined ? `${activeJob.accuracy}%` : '--'}
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-1.5 mt-2 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-full rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(100, activeJob.accuracy ?? 0)}%` }}
                    />
                  </div>
                </div>

                {/* 3. Throughput Samples/Sec */}
                <div className="p-4 rounded-[24px] bg-white border border-slate-200/80 shadow-soft">
                  <div className="flex items-center justify-between text-slate-400 mb-1">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
                      Throughput
                    </span>
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                  </div>
                  <div className="text-2xl font-black font-mono text-slate-900">
                    {activeJob.throughputSamplesSec ? activeJob.throughputSamplesSec.toLocaleString() : '--'}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1">
                    samples / sec
                  </div>
                </div>

                {/* 4. Measured workload rate */}
                <div className="p-4 rounded-[24px] bg-white border border-slate-200/80 shadow-soft">
                  <div className="flex items-center justify-between text-slate-400 mb-1">
                    <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
                      Estimated Operation Rate
                    </span>
                    <Activity className="w-3.5 h-3.5 text-purple-500" />
                  </div>
                  <div className="text-2xl font-black font-mono text-indigo-600">
                    {activeJob.estimatedGflops !== null && activeJob.estimatedGflops !== undefined ? `${activeJob.estimatedGflops} GFLOP/s` : '--'}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-1">
                    Epoch {activeJob.currentEpoch} / {activeJob.totalEpochs}
                  </div>
                </div>
              </div>

              {/* Loss Curve Graphic & Pooled Node Allocations */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Mathematical Loss Descent Curve */}
                <div className="p-5 rounded-[28px] bg-white border border-slate-200/80 shadow-soft flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-indigo-500" />
                      <h4 className="text-xs font-black font-display text-slate-900 uppercase tracking-wider">
                        Synthetic Batch Loss History
                      </h4>
                    </div>
                    <span className="text-[10px] font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                      Step {activeJob.currentStep} / {activeJob.totalSteps}
                    </span>
                  </div>

                  <div className="h-32 w-full my-1 flex items-center justify-center">
                    {renderLossChart()}
                  </div>

                  <div className="flex items-center justify-between text-[10px] font-mono text-slate-400 border-t border-slate-100 pt-2">
                    <span>Batch Size: {activeJob.batchSize}</span>
                    <span>LR: {activeJob.learningRate}</span>
                    <span>Status: {activeJob.status}</span>
                  </div>
                </div>

                {/* Node Allocation Breakdown */}
                <div className="p-5 rounded-[28px] bg-white border border-slate-200/80 shadow-soft flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-slate-700" />
                      <h4 className="text-xs font-black font-display text-slate-900 uppercase tracking-wider">
                        Worker Node Allocations
                      </h4>
                    </div>
                    <span className="text-[10px] font-mono text-slate-500">
                      {activeJob.nodes?.length || 0} Ray Node(s) Observed
                    </span>
                  </div>

                  <div className="space-y-3">
                    {(activeJob.nodes || []).map((node, i) => (
                      <div
                        key={i}
                        className="p-3 bg-slate-50 rounded-2xl border border-slate-200/60 flex items-center justify-between"
                      >
                        <div className="space-y-0.5">
                          <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-emerald-500" />
                            <span>{node}</span>
                            <span className="text-[10px] font-mono text-slate-400">(Ray worker)</span>
                          </div>
                          <div className="text-[11px] font-mono text-slate-500">
                            Synthetic CPU workload
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs font-mono font-bold text-indigo-600">
                            Active
                          </div>
                          <div className="w-16 bg-slate-200 rounded-full h-1.5 mt-1 overflow-hidden">
                            <div
                              className="bg-indigo-600 h-full rounded-full transition-all duration-300"
                              style={{ width: '100%' }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 border-t border-slate-100 pt-2 mt-2">
                    <span>Backend: {activeJob.backend || 'Unknown'}</span>
                    <span>Input: {activeJob.dataKind || 'Unknown'}</span>
                  </div>
                </div>
              </div>

              {/* Streaming Execution Log Box */}
              <div className="p-5 rounded-[28px] bg-[#090d16] border border-slate-800 shadow-2xl flex flex-col">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800 text-slate-400 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-xs font-mono font-bold uppercase text-slate-300">
                      Ray Job Logs
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500">
                    Distributed worker output
                  </span>
                </div>

                <div
                  ref={logsEndRef}
                  className="h-44 overflow-y-auto font-mono text-xs text-slate-300 space-y-1 select-text scrollbar-thin"
                >
                  {(activeJob.logs || []).map((line, idx) => (
                    <div key={idx} className="leading-relaxed">
                      <span className="text-slate-500 mr-2">[{new Date().toLocaleTimeString()}]</span>
                      <span className={line.includes('✓') ? 'text-emerald-400 font-bold' : line.includes('Loss') ? 'text-indigo-300' : 'text-slate-300'}>
                        {line}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            )
          )}
        </div>
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* ── VIEW 2: INTERACTIVE TERMINAL ── */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeSubTab === 'terminal' && (
        <div className="flex-1 flex flex-col space-y-3 min-h-[460px]">
          {/* Quick Action Pills */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {quickCommands.map((qc) => (
                <button
                  key={qc.label}
                  onClick={() => handleRunCommand(qc.cmd)}
              disabled={!terminalReady || (qc.requiresCluster && terminalKind !== 'cluster')}
                  className="expand-card px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-mono font-bold rounded-full shadow-soft-sm transition cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                >
                  {qc.label}
                </button>
              ))}
            </div>

            <button
              onClick={handleRestartShell}
              className="expand-card w-8 h-8 rounded-full bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 flex items-center justify-center transition cursor-pointer shadow-soft-sm"
              title="Restart Shell Session"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Terminal Window Frame */}
          <div className="flex-1 bg-[#090d16] border border-slate-800 rounded-[28px] p-5 shadow-2xl flex flex-col overflow-hidden relative group">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800/80 mb-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-rose-500/80 inline-block" />
                <span className="w-3 h-3 rounded-full bg-amber-500/80 inline-block" />
                <span className="w-3 h-3 rounded-full bg-emerald-500/80 inline-block" />
                <span className="text-xs font-mono text-slate-400 ml-2">
                  {terminalTarget}{terminalKind === 'pod' ? ' · pod shell' : ' · cluster shell'}
                </span>
              </div>

              <div className="text-[11px] font-mono text-slate-500">
                  Pipe shell · no TTY
              </div>
            </div>

            {/* Terminal Canvas */}
            <div
              ref={terminalRef}
              className="flex-1 w-full h-full overflow-hidden"
              style={{ minHeight: '380px' }}
            />
            <div className="pt-2 text-[11px] text-slate-400">
              {terminalReady
                ? terminalKind === 'pod'
                  ? 'Commands run inside this pod container. This pipe based shell has no TTY or job control, so full-screen editors and interactive programs are not supported.'
                  : 'Commands run in the K3s control plane. Use Nodes & Pods to inspect container processes or open a shell in a selected pod. This pipe based shell has no TTY or job control.'
                : 'Connecting to the cluster shell…'}
            </div>
          </div>
        </div>
      )}

      {activeSubTab === 'explorer' && (
        <ClusterExplorer onOpenPodShell={openPodShell} />
      )}

      {/* ───────────────────────────────────────────────────────────── */}
      {/* ── VIEW 3: RAY CLUSTER & DASHBOARD ── */}
      {/* ───────────────────────────────────────────────────────────── */}
      {activeSubTab === 'dashboard' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-6 rounded-[28px] bg-white border border-slate-200/80 shadow-soft">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">
                  Head Node
                </span>
                <span className={`w-2.5 h-2.5 rounded-full ${clusterStatus?.status === 'ONLINE' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              </div>
              <h3 className="text-2xl font-black text-slate-900 font-display">
                {clusterStatus?.status === 'ONLINE' ? 'Online' : k3sStatus?.status === 'ACTIVE' ? 'Ready to start' : 'K3s required'}
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                {clusterStatus?.status === 'ONLINE'
                  ? `Dashboard localhost:${clusterStatus.dashboardPort} · GCS ${clusterStatus.port}`
                  : k3sStatus?.status === 'ACTIVE'
                    ? `K3s is active. Start Ray to schedule workers on all ${clusterStatus?.kubernetesReadyNodeCount || 'Ready'} node(s).`
                    : 'Start a K3s cluster in Consumer before starting Ray.'}
              </p>
            </div>

            <div className="p-6 rounded-[28px] bg-white border border-slate-200/80 shadow-soft">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">
                  Plasma Object Store
                </span>
                <Layers className="w-4 h-4 text-indigo-500" />
              </div>
              <h3 className="text-2xl font-black text-slate-900 font-display">
                {clusterStatus?.plasmaMemoryGb != null ? `${clusterStatus.plasmaMemoryGb} GB` : 'Not reported'}
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Reported by Ray when the cluster is active
              </p>
            </div>

            <div className="p-6 rounded-[28px] bg-white border border-slate-200/80 shadow-soft">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400">
                  Compute Capacity
                </span>
                <Zap className="w-4 h-4 text-amber-500" />
              </div>
              <h3 className="text-2xl font-black text-slate-900 font-display">
                {clusterStatus?.status === 'ONLINE' && clusterStatus.coresAvailable != null
                  ? `${clusterStatus.coresAvailable} Ray CPU`
                  : '—'}
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                {clusterStatus?.gpusAvailable == null ? 'GPU scheduling not configured' : (clusterStatus.gpuName || 'No GPU')}
              </p>
            </div>
          </div>

          {clusterStatus?.status !== 'ONLINE' && (
            <div className="p-5 rounded-2xl bg-amber-50 border border-amber-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="font-bold text-slate-900">{k3sStatus?.status === 'ACTIVE' ? 'K3s is running; Ray is ready to start' : 'Start a compute cluster first'}</h3>
                <p className="text-sm text-slate-600 mt-1">{k3sStatus?.status === 'ACTIVE' ? `C3 will create a Ray head and one Ray worker per Ready K3s node (${clusterStatus?.kubernetesReadyNodeCount || 0} detected).` : 'Open Consumer and launch the local K3s control plane. Remote machines join after their providers accept the request and start the worker.'}</p>
              </div>
              <button type="button" disabled={startingRay} onClick={k3sStatus?.status === 'ACTIVE' ? handleStartRay : () => onSwitchTab?.('consumer')} className="shrink-0 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-60">{k3sStatus?.status === 'ACTIVE' ? (startingRay ? 'Starting Ray…' : 'Start Ray Cluster') : 'Go to Consumer'}</button>
            </div>
          )}

          <div className="p-6 rounded-[28px] bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-100 shadow-soft flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-base font-black text-slate-900">
                Launch External Ray Web Dashboard
              </h3>
              <p className="text-xs text-slate-500 max-w-lg">
                {clusterStatus?.status === 'ONLINE'
                  ? 'Open the running Ray dashboard for live cluster and job state.'
                  : 'The dashboard becomes available after a Ray cluster starts successfully.'}
              </p>
            </div>

            <button
              type="button"
              disabled={clusterStatus?.status !== 'ONLINE' || !clusterStatus?.dashboardUrl}
              onClick={() => {
                if (window.c3?.openExternal) {
                  if (clusterStatus?.dashboardUrl) window.c3.openExternal(clusterStatus.dashboardUrl);
                }
              }}
              className="expand-card px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full text-xs font-bold shadow-soft transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 whitespace-nowrap"
            >
              <span>{clusterStatus?.status === 'ONLINE' ? 'Open Ray Dashboard' : 'Ray Dashboard Unavailable'}</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

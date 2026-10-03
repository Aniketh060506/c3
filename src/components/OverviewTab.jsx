import React, { useEffect, useState } from 'react';
import {
  Activity, ArrowRight, CheckCircle2, CircleAlert, Cpu, Database,
  HardDrive, Laptop, Network, Play, RefreshCw, Server, ShieldCheck, Zap,
} from 'lucide-react';

function Metric({ icon: Icon, label, value, detail, tone = 'indigo' }) {
  const tones = {
    indigo: 'bg-indigo-50 text-indigo-600',
    green: 'bg-emerald-50 text-emerald-600',
    blue: 'bg-sky-50 text-sky-600',
    amber: 'bg-amber-50 text-amber-600',
  };
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-slate-500">{label}</span>
        <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${tones[tone]}`}><Icon size={16} /></span>
      </div>
      <div className="mt-3 truncate text-2xl font-bold tracking-tight text-slate-900">{value}</div>
      <div className="mt-1 truncate text-xs text-slate-500">{detail}</div>
    </article>
  );
}

export default function OverviewTab({ specs, liveStats, onSwitchTab, onOpenHealthReport, dockerRunning, onLiveRefresh, refreshing }) {
  const [cluster, setCluster] = useState(null);
  const [ray, setRay] = useState(null);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [clusterState, rayState] = await Promise.all([
          window.c3?.getClusterStatus?.(),
          window.c3?.getRayStatus?.(),
        ]);
        if (!mounted) return;
        if (clusterState) setCluster(clusterState);
        if (rayState) setRay(rayState);
      } catch (_) {}
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  const cpu = specs?.cpuCores;
  const ram = specs?.ramUsableGb ?? specs?.ramGb;
  const gpuName = specs?.gpuModel && specs.gpuModel !== 'None' ? specs.gpuModel : 'No GPU detected';
  const disk = liveStats?.disk || specs?.disk;
  const network = liveStats?.network || specs?.primaryNetwork;
  const rayOnline = ray?.status === 'ONLINE';
  const clusterActive = cluster?.status === 'ACTIVE';
  const systemLabel = rayOnline ? 'Ray cluster online' : clusterActive ? 'K3s running' : dockerRunning === true ? 'Host ready' : dockerRunning === false ? 'Docker offline' : 'Checking status';
  const systemMessage = rayOnline
    ? `Ray is serving ${ray.rayNodeCount} live node(s).`
    : clusterActive
      ? 'K3s is running. Start Ray from the Ray Shell when you are ready to run a job.'
      : dockerRunning === true
        ? 'Docker is available. Launch a cluster to make compute workers available.'
        : 'Start Docker Desktop before creating a C3 cluster.';

  return (
    <div className="workspace-page h-full w-full overflow-y-auto bg-slate-50 px-6 py-6 md:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">C3 workspace</div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Overview</h1>
            <p className="mt-1 text-sm text-slate-500">Your computer’s capacity and the actual state of its C3 cluster.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onLiveRefresh} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50">
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh readings'}
            </button>
            <button type="button" onClick={onOpenHealthReport} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
              <Activity size={15} /> Diagnostics
            </button>
          </div>
        </header>

        <section className={`flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5 ${rayOnline ? 'border-emerald-200 bg-emerald-50' : clusterActive ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
          <div className="flex min-w-0 items-start gap-3">
            <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${rayOnline ? 'bg-emerald-100 text-emerald-700' : clusterActive ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
              {rayOnline ? <CheckCircle2 size={18} /> : clusterActive ? <CircleAlert size={18} /> : <Server size={18} />}
            </span>
            <div className="min-w-0">
              <div className="font-semibold text-slate-900">{systemLabel}</div>
              <p className="mt-1 text-sm text-slate-600">{systemMessage}</p>
            </div>
          </div>
          <button type="button" onClick={() => onSwitchTab(clusterActive ? 'ray' : 'consumer')} className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-950">
            {clusterActive ? 'Open Ray tools' : 'Set up compute'} <ArrowRight size={15} />
          </button>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-900">This computer</h2>
              <p className="text-xs text-slate-500">Operating-system readings. These are local resources, not pooled capacity.</p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500"><Laptop size={14} /> {specs?.hostname || 'Local host'}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric icon={Cpu} label="Logical CPU threads" value={cpu ?? '—'} detail={specs?.cpuPhysicalCores != null ? `${specs.cpuPhysicalCores} physical cores` : specs?.cpuModel || 'Reading unavailable'} />
            <Metric icon={HardDrive} label="Memory" value={ram != null ? `${Number(ram).toFixed(1)} GB` : '—'} detail={liveStats?.memFreeGb != null ? `${Number(liveStats.memFreeGb).toFixed(1)} GB currently free` : specs?.ramType || 'Reading unavailable'} tone="green" />
            <Metric icon={Zap} label="Graphics" value={specs?.gpuVramGb ? `${specs.gpuVramGb} GB VRAM` : gpuName === 'No GPU detected' ? 'Not detected' : 'Detected'} detail={gpuName} tone="amber" />
            <Metric icon={Database} label="Local storage" value={disk?.freeGb != null ? `${disk.freeGb} GB free` : '—'} detail={disk?.mount || 'Reading unavailable'} tone="blue" />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <button type="button" onClick={() => onSwitchTab('consumer')} className="group rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-indigo-300 hover:shadow-md">
            <div className="flex items-center justify-between"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><Cpu size={18} /></span><ArrowRight size={16} className="text-slate-400 transition group-hover:translate-x-1 group-hover:text-indigo-600" /></div>
            <h3 className="mt-4 font-semibold text-slate-900">Use compute</h3><p className="mt-1 text-sm text-slate-500">Configure your local allocation and request remote provider capacity.</p>
          </button>
          <button type="button" onClick={() => onSwitchTab('provider')} className="group rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-emerald-300 hover:shadow-md">
            <div className="flex items-center justify-between"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600"><Server size={18} /></span><ArrowRight size={16} className="text-slate-400 transition group-hover:translate-x-1 group-hover:text-emerald-600" /></div>
            <h3 className="mt-4 font-semibold text-slate-900">Share this computer</h3><p className="mt-1 text-sm text-slate-500">Choose CPU and memory limits, then review incoming requests.</p>
          </button>
          <button type="button" onClick={() => onSwitchTab('ray')} className="group rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:border-sky-300 hover:shadow-md">
            <div className="flex items-center justify-between"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-50 text-sky-600"><Network size={18} /></span><ArrowRight size={16} className="text-slate-400 transition group-hover:translate-x-1 group-hover:text-sky-600" /></div>
            <h3 className="mt-4 font-semibold text-slate-900">Ray and terminal</h3><p className="mt-1 text-sm text-slate-500">Run the CPU benchmark, inspect pods, and check cluster status.</p>
          </button>
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 text-xs text-slate-500">
          <span className="inline-flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${network?.isOnline ? 'bg-emerald-500' : 'bg-slate-400'}`} />{network?.isOnline ? `${network.ip || 'Network connected'}${network.speedMbps ? ` · ${network.speedMbps} Mbps link` : ''}` : 'Network status unavailable'}</span>
          <span className="inline-flex items-center gap-1.5"><ShieldCheck size={14} /> {dockerRunning === true ? 'Docker engine available' : dockerRunning === false ? 'Docker engine offline' : 'Checking Docker'}</span>
        </footer>
      </div>
    </div>
  );
}

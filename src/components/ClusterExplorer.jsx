import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Box, CircleAlert, Cpu, Layers3, RefreshCw, Server, Terminal, Workflow } from 'lucide-react';

const panel = 'rounded-2xl border border-slate-200 bg-white shadow-sm';

export default function ClusterExplorer({ onOpenPodShell }) {
  const [inventory, setInventory] = useState({ nodes: [], pods: [] });
  const [nodeFilter, setNodeFilter] = useState('all');
  const [selected, setSelected] = useState(null);
  const [processes, setProcesses] = useState(null);
  const [loading, setLoading] = useState(false);
  const [processLoading, setProcessLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.c3?.getClusterInventory?.();
      if (!result?.ok) throw new Error(result?.error || 'Could not read the Kubernetes inventory.');
      setInventory(result);
      if (selected && !result.pods.some(pod => pod.namespace === selected.namespace && pod.name === selected.pod)) {
        setSelected(null);
        setProcesses(null);
      }
    } catch (err) {
      setError(err.message || 'K3s is unavailable. Start a cluster from Use compute first.');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => { refresh(); }, []);

  const visiblePods = useMemo(() => inventory.pods.filter(pod => nodeFilter === 'all' || pod.node === nodeFilter), [inventory.pods, nodeFilter]);
  const inspectProcesses = async (pod, container) => {
    setSelected({ namespace: pod.namespace, pod: pod.name, container });
    setProcesses(null);
    setProcessLoading(true);
    try {
      const result = await window.c3?.getPodProcesses?.({ namespace: pod.namespace, pod: pod.name, container });
      if (!result?.ok) throw new Error(result?.error || 'Could not get this container process list.');
      setProcesses(result);
    } catch (err) {
      setProcesses({ error: err.message || 'Process list unavailable.' });
    } finally {
      setProcessLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className={`${panel} p-5 md:p-6`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-indigo-600"><Workflow size={15} /> Live Kubernetes inventory</div>
            <h2 className="text-xl font-black text-slate-900">Nodes &amp; Pods</h2>
            <p className="mt-1 text-sm text-slate-500">Choose a node to see its pods, inspect container processes, or open a shell in a pod.</p>
          </div>
          <button onClick={refresh} disabled={loading} className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
        {error && <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><CircleAlert size={17} className="mt-0.5 shrink-0" />{error}</div>}
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {inventory.nodes.map(node => (
            <div key={node.name} className={`rounded-xl border p-4 transition ${nodeFilter === node.name ? 'border-indigo-400 bg-indigo-50/60 ring-2 ring-indigo-100' : 'border-slate-200 bg-slate-50 hover:border-slate-300'}`}>
              <button onClick={() => setNodeFilter(node.name === nodeFilter ? 'all' : node.name)} className="w-full text-left">
                <div className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2 font-bold text-slate-900"><Server size={16} className="shrink-0 text-indigo-600" /><span className="truncate">{node.name}</span></span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${node.ready ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{node.ready ? 'READY' : 'NOT READY'}</span></div>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500"><span>{node.role}</span><span>{node.podCount} pods</span><span>{node.cpu} CPU</span></div>
              </button>
              <button disabled={!node.ready} onClick={() => onOpenPodShell({ kind: 'node', node: node.name })} className="mt-3 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-40" title="Opens a temporary privileged debug shell for node administration"><Terminal size={13} /> Node shell</button>
            </div>
          ))}
          {inventory.nodes.length > 0 && <button onClick={() => setNodeFilter('all')} className={`rounded-xl border p-4 text-left ${nodeFilter === 'all' ? 'border-indigo-400 bg-indigo-50/60' : 'border-slate-200 bg-slate-50 hover:border-slate-300'}`}><div className="font-bold text-slate-900">All nodes</div><div className="mt-2 text-xs text-slate-500">Show every pod in the cluster</div></button>}
        </div>
      </div>

      <div className={`${panel} overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div className="flex items-center gap-2 font-black text-slate-900"><Layers3 size={17} className="text-indigo-600" /> Pods {nodeFilter !== 'all' && <span className="font-medium text-slate-500">on {nodeFilter}</span>}</div><span className="text-xs font-mono text-slate-500">{visiblePods.length} listed</span></div>
        {visiblePods.length ? <div className="divide-y divide-slate-100">
          {visiblePods.map(pod => (
            <div key={`${pod.namespace}/${pod.name}`} className="grid grid-cols-1 gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><Box size={15} className="text-slate-400" /><span className="font-bold text-slate-900">{pod.name}</span><span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-600">{pod.namespace}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${pod.phase === 'Running' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>{pod.phase}</span></div>
                <div className="mt-1 ml-6 text-xs text-slate-500">Node: {pod.node} · Ready: {pod.ready} · Restarts: {pod.restarts}</div>
                <div className="mt-2 ml-6 flex flex-wrap gap-2">{pod.containers.map(container => <span key={container.name} className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600">{container.name}{container.ready ? ' · ready' : ''}</span>)}</div>
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">{pod.containers.map(container => <React.Fragment key={container.name}><button disabled={pod.phase !== 'Running'} onClick={() => inspectProcesses(pod, container.name)} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Activity size={14} /> Processes</button><button disabled={pod.phase !== 'Running'} onClick={() => onOpenPodShell({ kind: 'pod', namespace: pod.namespace, pod: pod.name, container: container.name })} className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white hover:bg-slate-700 disabled:opacity-40"><Terminal size={14} /> Open shell</button></React.Fragment>)}</div>
            </div>
          ))}
        </div> : <div className="p-10 text-center text-sm text-slate-500">{loading ? 'Loading pods…' : error ? 'Cluster inventory is unavailable.' : 'No pods on this node.'}</div>}
      </div>

      {selected && <section className={`${panel} overflow-hidden`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><div className="flex items-center gap-2 font-black text-slate-900"><Cpu size={17} className="text-indigo-600" /> Container processes</div><div className="mt-1 font-mono text-xs text-slate-500">{selected.namespace}/{selected.pod} · {selected.container}</div></div>{processLoading && <RefreshCw size={16} className="animate-spin text-indigo-600" />}</div>
        {processes?.error ? <div className="p-5 text-sm text-rose-700">{processes.error}</div> : processes ? <><pre className="max-h-80 overflow-auto bg-slate-950 p-5 font-mono text-xs leading-5 text-emerald-200 select-text">{processes.output}</pre>{processes.note && <div className="px-5 py-3 text-xs text-slate-500">{processes.note}</div>}</> : <div className="p-5 text-sm text-slate-500">{processLoading ? 'Reading the live process list from this container…' : 'Select Processes on a running pod to inspect it.'}</div>}
      </section>}
    </div>
  );
}

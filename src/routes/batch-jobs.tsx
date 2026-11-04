import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Activity, Ban, Boxes, Cpu, FolderOpen, LoaderCircle, MemoryStick, Play, RefreshCw, Zap } from "lucide-react";
import { CardHeading, PageHeader, Panel } from "@/components/kit";
import { IconTile } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { clusterService, fileService, type BatchJob, type ClusterSnapshot } from "@/lib/platform";

export const Route = createFileRoute("/batch-jobs")({ validateSearch: (search: Record<string, unknown>) => ({ clusterId: typeof search["clusterId"] === "string" ? search["clusterId"] : "" }), head: () => ({ meta: [{ title: "Distributed workloads · ComputePool" }] }), component: DistributedWorkloads });

function DistributedWorkloads() {
  const { clusterId } = Route.useSearch();
  const [cluster, setCluster] = useState<ClusterSnapshot | null>(null);
  const [jobs, setJobs] = useState<BatchJob[] | null>(null);
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [command, setCommand] = useState("");
  const [cpu, setCpu] = useState(2);
  const [memory, setMemory] = useState(4);
  const [gpu, setGpu] = useState(0);
  const [replicas, setReplicas] = useState(2);
  const [inputFolder, setInputFolder] = useState("");
  const [outputFolder, setOutputFolder] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nodes = useMemo(() => cluster?.nodes.filter((n) => n.status === "ready") ?? [], [cluster]);

  const refresh = async () => {
    if (!clusterId) return;
    setError(null);
    const [c, j] = await Promise.allSettled([clusterService.snapshot(clusterId), clusterService.batchJobs(clusterId)]);
    if (c.status === "fulfilled") { setCluster(c.value); setSelected((prev) => prev.filter((id) => c.value.nodes.some((n) => n.id === id && n.status === "ready"))); }
    else setError(c.reason instanceof Error ? c.reason.message : "Cluster unavailable.");
    if (j.status === "fulfilled") setJobs(j.value);
    else setError(j.reason instanceof Error ? j.reason.message : "Workload history unavailable.");
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [clusterId]);

  const chooseInput = async () => { try { const path = await fileService.chooseProjectFolder(); if (path) { setInputFolder(path); if (!outputFolder) setOutputFolder(path); } } catch (e) { setError(e instanceof Error ? e.message : "Could not choose input folder."); } };
  const chooseOutput = async () => { try { const path = await fileService.chooseProjectFolder(); if (path) setOutputFolder(path); } catch (e) { setError(e instanceof Error ? e.message : "Could not choose output folder."); } };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!clusterId || !name.trim() || !image.trim() || !selected.length || !inputFolder || !outputFolder) return;
    setBusy(true); setError(null);
    try {
      await clusterService.submitBatchJob(clusterId, { name: name.trim(), image: image.trim(), command, cpuCores: cpu, memoryBytes: memory * 1024 ** 3, gpuCount: gpu, replicas, inputFolder, outputFolder, nodeIds: selected });
      setName(""); setCommand(""); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Distributed workload was not submitted."); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => { setBusy(true); setError(null); try { await clusterService.cancelBatchJob(id); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Workload was not cancelled."); } finally { setBusy(false); } };

  const resourceTotals = [
    { icon: Cpu, value: `${cpu * replicas}`, label: "CPU cores", tone: "blue" },
    { icon: MemoryStick, value: `${memory * replicas} GiB`, label: "Memory total", tone: "violet" },
    { icon: Zap, value: `${gpu * replicas}`, label: "GPU devices", tone: "orange" },
  ] as const;

  return <div className="mx-auto max-w-7xl">
    <Link to="/cluster" search={{ clusterId }} className="mb-4 inline-flex text-sm font-semibold text-muted-foreground">← Session dashboard</Link>
    <PageHeader eyebrow="Kubernetes · distributed processing" title="Distributed workload"><Link to="/terminal" search={{ clusterId }} className="inline-flex items-center rounded-xl border border-border px-3 py-2 text-xs font-semibold"><Cpu className="mr-2 size-4" />Interactive pod shell</Link><Button variant="outline" className="rounded-xl" onClick={() => void refresh()} disabled={!clusterId}><RefreshCw className="mr-2 size-4" />Refresh live jobs</Button></PageHeader>
    {error && <Panel className="mb-4 border-warning/40 text-sm text-muted-foreground">{error}</Panel>}
    {!clusterId || !cluster ? <Panel className="py-10 text-center"><h2 className="font-bold">A live session is required</h2><p className="mt-2 text-sm text-muted-foreground">Distributed workloads schedule only after the connected cluster reports live nodes.</p><Link to="/cluster" search={{ clusterId: "" }} className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground">Open session dashboard</Link></Panel> : <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <Panel>
        <div className="mb-5 flex items-start gap-3"><IconTile icon={Boxes} tone="blue" size="md" /><div><h2 className="text-lg font-bold">Run across multiple pods</h2><p className="mt-1 text-sm text-muted-foreground">Set replicas and per pod resources. Kubernetes places each pod across the eligible nodes.</p></div></div>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2"><Field label="Workload name"><input required value={name} onChange={(e) => setName(e.target.value)} className="field" placeholder="model-training" /></Field><Field label="Container image"><input required value={image} onChange={(e) => setImage(e.target.value)} className="field" placeholder="pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime" /></Field></div>
          <Field label="Command / training entrypoint"><input required value={command} onChange={(e) => setCommand(e.target.value)} className="field" placeholder="python train.py --data $COMPUTEPOOL_INPUT_DIR --output $COMPUTEPOOL_OUTPUT_DIR" /></Field>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Field label="Pods"><input type="number" min={1} max={256} value={replicas} onChange={(e) => setReplicas(Math.max(1, Number(e.target.value)))} className="field" /></Field><Field label="CPU / pod"><input type="number" min={1} max={256} value={cpu} onChange={(e) => setCpu(Math.max(1, Number(e.target.value)))} className="field" /></Field><Field label="RAM GiB / pod"><input type="number" min={1} max={4096} value={memory} onChange={(e) => setMemory(Math.max(1, Number(e.target.value)))} className="field" /></Field><Field label="GPU / pod"><input type="number" min={0} max={32} value={gpu} onChange={(e) => setGpu(Math.max(0, Number(e.target.value)))} className="field" /></Field></div>
          <div className="grid grid-cols-3 gap-2">{resourceTotals.map(({ icon, value, label, tone }) => <div key={label} className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-white p-3 shadow-sm"><IconTile icon={icon} tone={tone} size="sm" /><span className="min-w-0"><span className="block text-sm font-bold">{value}</span><span className="block truncate text-[10px] text-muted-foreground">{label}</span></span></div>)}</div>
          <div className="grid gap-3 sm:grid-cols-2"><FolderField label="Input data folder" value={inputFolder} onChoose={() => void chooseInput()} /><FolderField label="Save outputs on this laptop" value={outputFolder} onChoose={() => void chooseOutput()} /></div>
          <div><p className="mb-2 text-xs font-semibold">Eligible provider nodes</p>{nodes.length ? <div className="space-y-2">{nodes.map((n) => <label key={n.id} className="flex items-center gap-3 rounded-xl border border-border p-3 text-sm"><input type="checkbox" checked={selected.includes(n.id)} onChange={(e) => setSelected((all) => e.target.checked ? [...all, n.id] : all.filter((id) => id !== n.id))} /><span className="flex-1">{n.name}</span><span className="text-xs text-muted-foreground">{n.cpuCores ?? "?"} CPU · {n.memoryBytes === undefined ? "?" : `${(n.memoryBytes / 1024 ** 3).toFixed(0)} GiB`}{n.gpuNames.length ? ` · ${n.gpuNames.length} GPU` : ""}</span></label>)}</div> : <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">No ready nodes currently reported.</p>}</div>
          <p className="rounded-xl bg-muted p-3 text-xs leading-5 text-muted-foreground">The selected input folder is copied over the encrypted NetBird peer connection to each selected worker (archives up to 256 MiB). Set your command to read <code>$COMPUTEPOOL_INPUT_DIR</code> and write to <code>$COMPUTEPOOL_OUTPUT_DIR</code>. Completed outputs are copied to per-node subfolders inside the selected output folder.</p>
          <Button className="w-full rounded-xl" disabled={busy || !selected.length || !name.trim() || !image.trim() || !inputFolder || !outputFolder}>{busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}Launch distributed workload</Button>
        </form>
      </Panel>
      <Panel><CardHeading icon={Activity} tone="green" title="Execution status" detail="Track pod placement, resource use, progress, and output sync live." />{jobs === null ? <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">Workload history is unavailable until the scheduler responds.</p> : jobs.length === 0 ? <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">No workloads returned for this session.</p> : <div className="space-y-3">{jobs.map((job) => <div key={job.id} className="rounded-2xl border border-border p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div className="flex min-w-0 items-center gap-3"><IconTile icon={Boxes} tone={job.status === "completed" ? "green" : job.status === "failed" ? "rose" : "blue"} size="md" /><div className="min-w-0"><h3 className="font-semibold">{job.name}</h3><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{job.image} · {job.id}</p></div></div><span className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${job.status === "completed" ? "bg-emerald-50 text-emerald-700" : job.status === "failed" ? "bg-rose-50 text-rose-700" : "bg-blue-50 text-blue-700"}`}>{job.status}</span></div><div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><Boxes className="size-3.5" />{job.replicas ?? job.nodeIds.length} pods</span><span className="inline-flex items-center gap-1"><Cpu className="size-3.5" />{job.cpuCores} cores / pod</span><span className="inline-flex items-center gap-1"><MemoryStick className="size-3.5" />{(job.memoryBytes / 1024 ** 3).toFixed(1)} GiB / pod</span><span className="inline-flex items-center gap-1"><Zap className="size-3.5" />{job.gpuCount ?? 0} GPU / pod</span>{job.outputSync && <span className="capitalize">Output sync: {job.outputSync}</span>}</div>{job.progressPercent !== undefined && <div className="mt-3"><div className="flex justify-between text-xs"><span>Progress</span><span>{job.progressPercent}%</span></div><div className="mt-1 h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, job.progressPercent))}%` }} /></div></div>}{job.error && <p className="mt-2 text-xs text-destructive">{job.error}</p>}{!["completed", "failed", "cancelled"].includes(job.status) && <button disabled={busy} onClick={() => void cancel(job.id)} className="mt-3 inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-destructive"><Ban className="size-3.5" />Cancel workload</button>}</div>)}</div>}</Panel>
    </div>}
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-semibold">{label}{children}</label>; }
function FolderField({ label, value, onChoose }: { label: string; value: string; onChoose: () => void }) { return <div className="min-w-0"><p className="mb-2 text-xs font-semibold">{label}</p><button type="button" onClick={onChoose} className="flex h-12 w-full items-center gap-3 rounded-2xl border border-input bg-white px-3 text-left text-xs shadow-sm transition hover:border-primary/30 hover:shadow-soft"><IconTile icon={FolderOpen} tone="cyan" size="sm" /><span className="truncate">{value || "Choose local folder"}</span></button></div>; }

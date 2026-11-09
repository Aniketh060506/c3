import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Ban, Boxes, CheckCircle2, Cpu, FolderOpen, LoaderCircle, MemoryStick, Play, RefreshCw, Zap } from "lucide-react";
import { CardHeading, PageHeader, Panel } from "@/components/kit";
import { IconTile } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { clusterService, fileService, type BatchJob, type ClusterSnapshot } from "@/lib/platform";
import { ImagePresetPicker } from "@/components/image-presets";

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
  const [refreshing, setRefreshing] = useState(false);
  const [jobsUpdatedAt, setJobsUpdatedAt] = useState<string | null>(null);
  const refreshLock = useRef(false);
  const nodes = useMemo(() => cluster?.nodes.filter((n) => n.status === "ready") ?? [], [cluster]);
  const launchChecklist = [
    { label: "Workload name", ready: Boolean(name.trim()) },
    { label: "Container image", ready: Boolean(image.trim()) },
    { label: "Command", ready: Boolean(command.trim()) },
    { label: "Ready worker selected", ready: selected.length > 0 },
    { label: "Input and output folders", ready: Boolean(inputFolder && outputFolder) },
  ];
  const canLaunch = launchChecklist.every((item) => item.ready) && !busy;

  const refresh = async () => {
    if (!clusterId || refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true);
    const [c, j] = await Promise.allSettled([clusterService.snapshot(clusterId), clusterService.batchJobs(clusterId)]);
    let failed = false;
    if (c.status === "fulfilled") { setCluster(c.value); setSelected((prev) => prev.filter((id) => c.value.nodes.some((n) => n.id === id && n.status === "ready"))); }
    else { failed = true; setError(c.reason instanceof Error ? c.reason.message : "Could not read cluster status."); }
    if (j.status === "fulfilled") { setJobs(j.value); setJobsUpdatedAt(new Date().toISOString()); }
    else { failed = true; setError(j.reason instanceof Error ? j.reason.message : "Could not read workload status."); }
    if (!failed) setError(null);
    refreshLock.current = false;
    setRefreshing(false);
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [clusterId]);

  const chooseInput = async () => { try { const path = await fileService.chooseProjectFolder(); if (path) { setInputFolder(path); if (!outputFolder) setOutputFolder(path); } } catch (e) { setError(e instanceof Error ? e.message : "Could not choose input folder."); } };
  const chooseOutput = async () => { try { const path = await fileService.chooseProjectFolder(); if (path) setOutputFolder(path); } catch (e) { setError(e instanceof Error ? e.message : "Could not choose output folder."); } };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!canLaunch || !clusterId) return;
    setBusy(true); setError(null);
    try {
      const submitted = await clusterService.submitBatchJob(clusterId, { name: name.trim(), image: image.trim(), command, cpuCores: cpu, memoryBytes: memory * 1024 ** 3, gpuCount: gpu, replicas, inputFolder, outputFolder, nodeIds: selected });
      setJobs((current) => [submitted, ...(current ?? []).filter((job) => job.id !== submitted.id)]);
      setJobsUpdatedAt(new Date().toISOString());
      window.setTimeout(() => void refresh(), 1500);
    } catch (err) { setError(err instanceof Error ? err.message : "Distributed workload was not submitted."); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => { setBusy(true); setError(null); try { await clusterService.cancelBatchJob(id); setJobs((current) => current?.map((job) => job.id === id ? { ...job, status: "cancelled" } : job) ?? null); window.setTimeout(() => void refresh(), 1000); } catch (e) { setError(e instanceof Error ? e.message : "Workload was not cancelled."); } finally { setBusy(false); } };

  const resourceTotals = [
    { icon: Cpu, value: `${cpu * replicas}`, label: "CPU cores", tone: "blue" },
    { icon: MemoryStick, value: `${memory * replicas} GiB`, label: "Memory total", tone: "violet" },
    { icon: Zap, value: `${gpu * replicas}`, label: "GPU devices", tone: "orange" },
  ] as const;

  return <div className="w-full min-w-0">
    <Link to="/cluster" search={{ clusterId }} className="mb-4 inline-flex text-sm font-semibold text-muted-foreground">← Session dashboard</Link>
    <PageHeader eyebrow="Kubernetes · distributed processing" title="Distributed workload"><Link to="/terminal" search={{ clusterId }} className="inline-flex items-center rounded-xl border border-border px-3 py-2 text-xs font-semibold"><Cpu className="mr-2 size-4" />Interactive pod shell</Link><Button variant="outline" className="rounded-xl" onClick={() => void refresh()} disabled={!clusterId || refreshing}><RefreshCw className={`mr-2 size-4 ${refreshing ? "animate-spin" : ""}`} />{refreshing ? "Refreshing…" : "Refresh live jobs"}</Button></PageHeader>
    {error && <Panel className="mb-4 border-warning/40 text-sm text-muted-foreground">{error}</Panel>}
    {!clusterId || !cluster ? <Panel className="py-10 text-center"><h2 className="font-bold">A live session is required</h2><p className="mt-2 text-sm text-muted-foreground">Distributed workloads schedule only after the connected cluster reports live nodes.</p><Link to="/cluster" search={{ clusterId: "" }} className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground">Open session dashboard</Link></Panel> : <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <Panel>
        <div className="mb-5 flex items-start gap-3"><IconTile icon={Boxes} tone="blue" size="md" /><div><h2 className="text-lg font-bold">Run across multiple pods</h2><p className="mt-1 text-sm text-muted-foreground">Set replicas and per pod resources. Kubernetes places each pod across the eligible nodes.</p></div></div>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <Field label="Workload name"><input required value={name} onChange={(e) => setName(e.target.value)} className="field" placeholder="model-training" /></Field>
          <ImagePresetPicker value={image} onSelect={setImage} />
          <Field label="Container image"><input required value={image} onChange={(e) => setImage(e.target.value)} className="field" placeholder="Choose a preset above or enter image:tag" /></Field>
          <Field label="Command / training entrypoint"><input required value={command} onChange={(e) => setCommand(e.target.value)} className="field" placeholder="python train.py --data $COMPUTEPOOL_INPUT_DIR --output $COMPUTEPOOL_OUTPUT_DIR" /></Field>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Field label="Pods"><input type="number" min={1} max={256} value={replicas} onChange={(e) => setReplicas(Math.max(1, Number(e.target.value)))} className="field" /></Field><Field label="CPU / pod"><input type="number" min={1} max={256} value={cpu} onChange={(e) => setCpu(Math.max(1, Number(e.target.value)))} className="field" /></Field><Field label="RAM GiB / pod"><input type="number" min={1} max={4096} value={memory} onChange={(e) => setMemory(Math.max(1, Number(e.target.value)))} className="field" /></Field><Field label="GPU / pod"><input type="number" min={0} max={32} value={gpu} onChange={(e) => setGpu(Math.max(0, Number(e.target.value)))} className="field" /></Field></div>
          <div className="grid grid-cols-3 gap-2">{resourceTotals.map(({ icon, value, label, tone }) => <div key={label} className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-white p-3 shadow-sm"><IconTile icon={icon} tone={tone} size="sm" /><span className="min-w-0"><span className="block text-sm font-bold">{value}</span><span className="block truncate text-[10px] text-muted-foreground">{label}</span></span></div>)}</div>
          <div className="grid gap-3 sm:grid-cols-2"><FolderField label="Input data folder" value={inputFolder} onChoose={() => void chooseInput()} /><FolderField label="Save outputs on this laptop" value={outputFolder} onChoose={() => void chooseOutput()} /></div>
          <div><p className="mb-2 text-xs font-semibold">Eligible provider nodes</p>{nodes.length ? <div className="space-y-2">{nodes.map((n) => <label key={n.id} className="flex items-center gap-3 rounded-xl border border-border p-3 text-sm"><input type="checkbox" checked={selected.includes(n.id)} onChange={(e) => setSelected((all) => e.target.checked ? [...all, n.id] : all.filter((id) => id !== n.id))} /><span className="flex-1">{n.name}</span><span className="text-xs text-muted-foreground">{n.cpuCores ?? "?"} CPU · {n.memoryBytes == null ? "?" : `${(n.memoryBytes / 1024 ** 3).toFixed(0)} GiB`}{n.gpuNames.length ? ` · ${n.gpuNames.length} GPU` : ""}</span></label>)}</div> : <p className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">No ready nodes currently reported.</p>}</div>
          <p className="rounded-xl bg-muted p-3 text-xs leading-5 text-muted-foreground">The selected input folder is copied over the encrypted NetBird peer connection to each selected worker (archives up to 256 MiB). Set your command to read <code>$COMPUTEPOOL_INPUT_DIR</code> and write to <code>$COMPUTEPOOL_OUTPUT_DIR</code>. Completed outputs are copied to per-node subfolders inside the selected output folder.</p>
          <Button className="w-full rounded-xl" disabled={!canLaunch}>{busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}Launch distributed workload</Button>
        </form>
      </Panel>
      <Panel className="min-h-[520px]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardHeading icon={Activity} tone="green" title="Live workload status" detail="Kubernetes job state, pod placement, readiness, and errors." className="mb-0" />
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
          <span className={`rounded-full px-3 py-1.5 font-semibold ${cluster.status === "ready" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>Cluster {cluster.status}</span>
          <span className="rounded-full bg-muted px-3 py-1.5 text-muted-foreground">{nodes.length} ready worker{nodes.length === 1 ? "" : "s"}</span>
          <span className="rounded-full bg-muted px-3 py-1.5 text-muted-foreground">{refreshing ? "Updating…" : jobsUpdatedAt ? `Updated ${new Date(jobsUpdatedAt).toLocaleTimeString()}` : "Checking status…"}</span>
          <span className="rounded-full bg-muted px-3 py-1.5 text-muted-foreground">Auto refresh · 5 sec</span>
        </div>
        {jobs === null ? <div role="status" className="mt-4 flex items-center gap-3 rounded-2xl bg-muted p-5 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Checking Kubernetes for workloads…</div>
          : jobs.length === 0 ? <div className="mt-4 grid min-h-[330px] place-items-center rounded-2xl border border-dashed border-border bg-slate-50/70 p-6 text-center"><div><IconTile icon={Boxes} tone="blue" size="lg" className="mx-auto" /><h3 className="mt-4 text-lg font-bold">No distributed job has been submitted</h3><p className="mx-auto mt-2 max-w-md text-sm leading-5 text-muted-foreground">Choosing an image only fills in the form; it does not start a workload. Enter the workload name and command, select at least one ready node, choose both folders, then press <strong>Launch distributed workload</strong>. After Kubernetes accepts it, this panel will show queued, scheduling, running, and finished states for each pod.</p><div className="mx-auto mt-4 flex max-w-md flex-wrap justify-center gap-2">{launchChecklist.map((item) => <span key={item.label} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[10px] font-semibold ${item.ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{item.ready ? <CheckCircle2 className="size-3" /> : <span className="size-1.5 rounded-full bg-amber-500" />}{item.label}{item.ready ? " ready" : " needed"}</span>)}</div></div></div>
          : <div className="mt-4 space-y-3">{jobs.map((job) => <article key={job.id} className="rounded-2xl border border-border bg-white p-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><IconTile icon={Boxes} tone={job.status === "completed" ? "green" : job.status === "failed" ? "rose" : "blue"} size="md" /><div className="min-w-0"><h3 className="font-semibold">{job.name}</h3><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{job.image} · {job.id}</p></div></div><span className={`rounded-full px-3 py-1.5 text-xs font-bold capitalize ${job.status === "completed" ? "bg-emerald-50 text-emerald-700" : job.status === "failed" ? "bg-rose-50 text-rose-700" : job.status === "running" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-800"}`}>{job.status}</span></div><div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground"><span><Boxes className="mr-1 inline size-3.5" />{job.replicas ?? job.nodeIds.length} replicas</span><span><Cpu className="mr-1 inline size-3.5" />{job.cpuCores} CPU / pod</span><span><MemoryStick className="mr-1 inline size-3.5" />{(job.memoryBytes / 1024 ** 3).toFixed(1)} GiB / pod</span><span><Zap className="mr-1 inline size-3.5" />{job.gpuCount ?? 0} GPU / pod</span><span>Image pull: {job.imagePullPolicy ?? "Kubernetes default"}</span>{job.outputSync && <span>Output sync: {job.outputSync}</span>}</div>{job.progressPercent !== undefined && <div className="mt-3"><div className="flex justify-between text-xs"><span>Completed pods</span><span>{job.progressPercent}%</span></div><div className="mt-1 h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, job.progressPercent))}%` }} /></div></div>}{job.pods?.length ? <div className="mt-4 grid gap-2 sm:grid-cols-2">{job.pods.map((pod) => { const pullFailed = /imagepull|errimage/i.test(pod.reason); return <div key={pod.name} className="rounded-xl border border-border bg-slate-50 p-3"><div className="flex items-center justify-between gap-2"><p className="truncate font-mono text-xs font-semibold">{pod.name}</p><span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${pod.ready ? "bg-emerald-50 text-emerald-700" : pullFailed || pod.phase === "Failed" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800"}`}>{pod.ready ? "Ready" : pod.reason || pod.phase}</span></div><p className="mt-1 text-[10px] text-muted-foreground">{pod.nodeName ? `Worker: ${pod.nodeName}` : "Waiting for worker placement"} · {pod.phase} · {pod.restartCount} restarts</p>{pod.detail && <p className={`mt-1 break-words text-[10px] ${pullFailed ? "text-rose-700" : "text-amber-800"}`}>{pod.detail}</p>}{pullFailed && <p className="mt-1 text-[10px] text-muted-foreground">Image pull failed before the container started. Check the node’s registry/DNS/TLS access; application logs will appear after the image downloads.</p>}<div className="mt-3 overflow-hidden rounded-xl border border-slate-700 bg-slate-950"><div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-[10px] font-semibold text-slate-300"><Activity className="size-3 text-emerald-400" />Live container logs <span className="ml-auto font-normal text-slate-500">refreshes every 5 sec · last 60 lines</span></div><pre className="max-h-44 min-h-12 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[10px] leading-4 text-emerald-100">{pod.logs?.trim() || (pullFailed ? "Waiting for image pull; no container has started yet." : pod.phase === "Succeeded" ? "Container completed without writing logs." : "Waiting for the container to start and write logs…")}</pre></div>{pod.events?.length ? <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="mb-1 text-[10px] font-bold text-amber-900">Kubernetes events · image pull and scheduling diagnostics</p>{pod.events.map((event, index) => <p key={`${pod.name}-event-${index}`} className="break-words text-[10px] leading-4 text-amber-900">{event}</p>)}</div> : null}</div>; })}</div> : !["completed", "failed", "cancelled"].includes(job.status) ? <p className="mt-3 rounded-xl bg-muted p-3 text-xs text-muted-foreground">Kubernetes accepted this job. Waiting for its pod records to appear…</p> : null}{job.error && <p className="mt-3 rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{job.error}</p>}{!["completed", "failed", "cancelled"].includes(job.status) && <button disabled={busy} onClick={() => void cancel(job.id)} className="mt-3 inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-destructive"><Ban className="size-3.5" />Cancel workload</button>}</article>)}</div>}
      </Panel>
    </div>}
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-semibold">{label}{children}</label>; }
function FolderField({ label, value, onChoose }: { label: string; value: string; onChoose: () => void }) { return <div className="min-w-0"><p className="mb-2 text-xs font-semibold">{label}</p><button type="button" onClick={onChoose} className="flex h-12 w-full items-center gap-3 rounded-2xl border border-input bg-white px-3 text-left text-xs shadow-sm transition hover:border-primary/30 hover:shadow-soft"><IconTile icon={FolderOpen} tone="cyan" size="sm" /><span className="truncate">{value || "Choose local folder"}</span></button></div>; }

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, Boxes, Cpu, LoaderCircle, MemoryStick, Play, Send, Terminal as TerminalIcon, Zap } from "lucide-react";
import { PageHeader, Panel } from "@/components/kit";
import { clusterService } from "@/lib/platform";

export const Route = createFileRoute("/terminal")({
  validateSearch: (search: Record<string, unknown>) => ({ clusterId: typeof search["clusterId"] === "string" ? search["clusterId"] : "" }),
  head: () => ({ meta: [{ title: "Interactive pod · ComputePool" }] }),
  component: InteractivePod,
});

type Line = { command?: string; stdout?: string; stderr?: string; exitCode?: number };

function InteractivePod() {
  const { clusterId } = Route.useSearch();
  const [image, setImage] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [cpu, setCpu] = useState(2);
  const [memory, setMemory] = useState(4);
  const [gpu, setGpu] = useState(0);
  const [pod, setPod] = useState<{ namespace: string; name: string; image: string } | null>(null);
  const [shellId, setShellId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setShellId(null); setLines([]);
    try {
      if (!clusterId) throw new Error("Open this tool from a connected ComputePool session.");
      const created = await clusterService.createInteractivePod(clusterId, { image: image.trim(), cpuCores: cpu, memoryGib: memory, gpuCount: gpu, namespace: namespace.trim() });
      const session = await clusterService.openPodShell(clusterId, created.namespace, created.podName);
      setPod({ namespace: created.namespace, name: created.podName, image: created.image });
      setShellId(session.shellId);
      setLines([{ stdout: `Pod ${created.namespace}/${created.podName} is ready. Image: ${created.image}` }]);
    } catch (e) { setError(e instanceof Error ? e.message : "Interactive pod was not started."); }
    finally { setBusy(false); }
  };

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!shellId || !input.trim()) return;
    const command = input.trim(); setInput(""); setBusy(true); setError(null);
    try { const result = await clusterService.executePodCommand(shellId, command); setLines((all) => [...all, { command, ...result }]); }
    catch (e) { setError(e instanceof Error ? e.message : "Command was not executed."); }
    finally { setBusy(false); }
  };

  return <div className="mx-auto max-w-7xl">
    <Link to="/cluster" search={{ clusterId }} className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground"><ArrowLeft className="size-4" />Session dashboard</Link>
    <PageHeader eyebrow="Interactive compute · Kubernetes pod" title="Pod shell"><Link to="/batch-jobs" search={{ clusterId }} className="inline-flex items-center rounded-xl border border-border px-3 py-2 text-xs font-semibold"><Boxes className="mr-2 size-4" />Distributed workload</Link></PageHeader>
    {error && <Panel className="mb-4 border-warning/40 text-sm text-muted-foreground">{error}</Panel>}
    <div className="grid gap-4 xl:grid-cols-[0.72fr_1.28fr]">
      <Panel>
        <h2 className="text-lg font-bold">Start an interactive pod</h2>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">Choose the image and per pod resource requests. Kubernetes schedules it on a node with matching free capacity.</p>
        <form onSubmit={(e) => void start(e)} className="space-y-4">
          <Field label="Container image"><input required value={image} onChange={(e) => setImage(e.target.value)} className="field" placeholder="pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime" /></Field>
          <Field label="Kubernetes namespace"><input required value={namespace} onChange={(e) => setNamespace(e.target.value)} className="field" placeholder="default" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="CPU cores"><input type="number" min={1} max={256} value={cpu} onChange={(e) => setCpu(Math.max(1, Number(e.target.value)))} className="field" /></Field>
            <Field label="Memory (GiB)"><input type="number" min={1} max={4096} value={memory} onChange={(e) => setMemory(Math.max(1, Number(e.target.value)))} className="field" /></Field>
          </div>
          <Field label="NVIDIA GPUs"><input type="number" min={0} max={32} value={gpu} onChange={(e) => setGpu(Math.max(0, Number(e.target.value)))} className="field" /></Field>
          <div className="rounded-xl bg-muted p-3 text-xs leading-5 text-muted-foreground"><Cpu className="mr-2 inline size-3.5" />{cpu} CPU · <MemoryStick className="mx-1 inline size-3.5" />{memory} GiB · <Zap className="mx-1 inline size-3.5" />{gpu} GPU. These become Kubernetes requests and limits; GPU nodes need the NVIDIA device plugin installed.</div>
          <button disabled={busy || !image.trim()} className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">{busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}Start pod and open shell</button>
        </form>
        {pod && <div className="mt-4 rounded-xl border border-success/30 bg-success-soft p-3 text-xs"><p className="font-semibold">Running pod</p><p className="mt-1 font-mono">{pod.namespace}/{pod.name}</p><p className="mt-1 break-all text-muted-foreground">{pod.image}</p></div>}
        <p className="mt-4 text-xs leading-5 text-muted-foreground">Uses the active kubectl context. Input and output folder mounting is configured with the distributed workload’s data transfer settings.</p>
      </Panel>
      <Panel className="overflow-hidden bg-ink p-0 text-ink-foreground">
        <div className="flex items-center gap-2 border-b border-ink-foreground/10 px-4 py-3"><TerminalIcon className="size-4 text-primary" /><span className="font-mono text-xs">{pod ? `${pod.namespace}/${pod.name}` : "Pod terminal"}</span><span className="ml-auto rounded-full bg-ink-foreground/10 px-2 py-1 text-[10px]">{shellId ? "Connected" : busy ? "Starting pod" : "No pod"}</span></div>
        <div className="min-h-[420px] space-y-3 overflow-auto p-5 font-mono text-xs">{lines.length === 0 && <p className="text-ink-foreground/55">Pod startup and command output will appear here.</p>}{lines.map((line, i) => <div key={i}><p><span className="text-primary">{pod?.name ?? "pod"}</span><span className="opacity-50"> $ </span>{line.command}</p>{line.stdout && <pre className="mt-1 whitespace-pre-wrap opacity-80">{line.stdout}</pre>}{line.stderr && <pre className="mt-1 whitespace-pre-wrap text-warning">{line.stderr}</pre>}{line.exitCode !== undefined && <p className="mt-1 text-[10px] opacity-45">exit {line.exitCode}</p>}</div>)}{busy && <p className="flex items-center gap-2 opacity-60"><LoaderCircle className="size-3.5 animate-spin" />Waiting for Kubernetes…</p>}</div>
        <form onSubmit={(e) => void run(e)} className="flex gap-2 border-t border-ink-foreground/10 p-3"><input value={input} onChange={(e) => setInput(e.target.value)} disabled={!shellId || busy} className="h-11 min-w-0 flex-1 rounded-xl bg-ink-foreground/5 px-4 font-mono text-xs outline-none focus:ring-1 focus:ring-primary" placeholder={shellId ? "Run a command in this pod" : "Start a pod to open its shell"} /><button disabled={!shellId || busy || !input.trim()} className="rounded-xl bg-primary px-4 text-primary-foreground disabled:opacity-50"><Send className="size-4" /></button></form>
      </Panel>
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-semibold">{label}{children}</label>; }

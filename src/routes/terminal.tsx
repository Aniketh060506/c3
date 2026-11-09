import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Boxes, Cpu, LoaderCircle, MemoryStick, Play, Send, Terminal as TerminalIcon, Trash2, Zap } from "lucide-react";
import { IconTile, PageHeader, Panel } from "@/components/kit";
import { ImagePresetPicker } from "@/components/image-presets";
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
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminalOutputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = terminalOutputRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [lines, busy]);

  const connectTerminal = async (target: { namespace: string; name: string; image: string }) => {
    if (!clusterId) throw new Error("Open this tool from a connected ComputePool session.");
    setShellId(null);
    const session = await clusterService.openPodShell(clusterId, target.namespace, target.name);
    setShellId(session.shellId);
    setLines([{ stdout: `Connected to ${target.namespace}/${target.name}. Image: ${target.image}` }]);
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setShellId(null); setLines([]);
    try {
      if (!clusterId) throw new Error("Open this tool from a connected ComputePool session.");
      if (pod) {
        await connectTerminal(pod);
      } else {
        const created = await clusterService.createInteractivePod(clusterId, { image: image.trim(), cpuCores: cpu, memoryGib: memory, gpuCount: gpu, namespace: namespace.trim() });
        const target = { namespace: created.namespace, name: created.podName, image: created.image };
        // Keep the ready pod even when exec needs a moment to become available.
        // Retrying from this page must reconnect instead of creating duplicates.
        setPod(target);
        setLines([{ stdout: `Pod ${target.namespace}/${target.name} is ready. Connecting terminal…` }]);
        await connectTerminal(target);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Interactive pod was not started."); }
    finally { setBusy(false); }
  };

  const execute = async (command: string) => {
    if (!shellId || !command.trim()) return;
    setInput(""); setHistoryIndex(-1); setCommandHistory((history) => [...history, command.trim()].slice(-100)); setBusy(true); setError(null);
    try { const result = await clusterService.executePodCommand(shellId, command); setLines((all) => [...all, { command, ...result }]); }
    catch (e) { setError(e instanceof Error ? e.message : "Command was not executed."); }
    finally { setBusy(false); }
  };
  const run = (e?: React.FormEvent) => { e?.preventDefault(); void execute(input.trim()); };

  return <div className="w-full min-w-0">
    <Link to="/cluster" search={{ clusterId }} className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground"><ArrowLeft className="size-4" />Session dashboard</Link>
    <PageHeader eyebrow="Interactive compute · Kubernetes pod" title="Pod shell"><Link to="/batch-jobs" search={{ clusterId }} className="inline-flex items-center rounded-xl border border-border px-3 py-2 text-xs font-semibold"><Boxes className="mr-2 size-4" />Distributed workload</Link></PageHeader>
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(320px,390px)_minmax(0,1fr)]">
      <Panel className="p-4">
        <div className="mb-4 flex items-center gap-3"><IconTile icon={Cpu} tone="blue" size="sm" /><div><h2 className="font-bold">Pod configuration</h2><p className="text-xs text-muted-foreground">Choose an image and resource limits.</p></div></div>
        <form onSubmit={(e) => void start(e)} className="space-y-3">
          <ImagePresetPicker value={image} onSelect={setImage} compact />
          <Field label="Container image"><input required value={image} onChange={(e) => setImage(e.target.value)} className="field" placeholder="registry/image:tag" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Namespace"><input required value={namespace} onChange={(e) => setNamespace(e.target.value)} className="field" placeholder="default" /></Field>
            <Field label="NVIDIA GPUs"><input type="number" min={0} max={32} value={gpu} onChange={(e) => setGpu(Math.max(0, Number(e.target.value)))} className="field" /></Field>
            <Field label="CPU cores"><input type="number" min={1} max={256} value={cpu} onChange={(e) => setCpu(Math.max(1, Number(e.target.value)))} className="field" /></Field>
            <Field label="Memory (GiB)"><input type="number" min={1} max={4096} value={memory} onChange={(e) => setMemory(Math.max(1, Number(e.target.value)))} className="field" /></Field>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-muted px-3 py-2 text-[11px] text-muted-foreground"><span><Cpu className="mr-1 inline size-3.5" />{cpu} CPU</span><span><MemoryStick className="mr-1 inline size-3.5" />{memory} GiB RAM</span><span><Zap className="mr-1 inline size-3.5" />{gpu} GPU</span></div>
          <button disabled={busy || (!pod && !image.trim())} className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">{busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : pod ? <TerminalIcon className="mr-2 size-4" /> : <Play className="mr-2 size-4" />}{pod ? shellId ? "Reconnect terminal" : "Connect to existing pod" : "Create pod & connect terminal"}</button>
        </form>
        {pod && <div className="mt-3 rounded-xl border border-success/30 bg-success-soft p-3 text-xs"><div className="flex items-center gap-2 font-semibold text-success"><Boxes className="size-4" />Pod ready · {shellId ? "terminal connected" : "terminal disconnected"}</div><p className="mt-1 break-all font-mono">{pod.namespace}/{pod.name}</p><p className="mt-1 break-all text-muted-foreground">{pod.image}</p>{!shellId && <button type="button" disabled={busy} onClick={() => { setBusy(true); setError(null); void connectTerminal(pod).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not connect to the pod terminal.")).finally(() => setBusy(false)); }} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-success/30 px-2.5 py-1.5 font-semibold text-success disabled:opacity-50"><TerminalIcon className="size-3.5" />{busy ? "Connecting…" : "Reconnect terminal"}</button>}</div>}
        <p className="mt-3 text-[11px] leading-4 text-muted-foreground">Pod resources become Kubernetes requests and limits. GPU scheduling requires NVIDIA-enabled workers and the device plugin.</p>
      </Panel>
      <Panel className="flex h-[min(72vh,760px)] min-h-[520px] flex-col overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 shadow-lg">
        <div className="flex min-h-14 items-center gap-3 border-b border-white/10 bg-slate-900 px-4 py-3"><IconTile icon={TerminalIcon} tone="green" size="sm" /><div className="min-w-0"><p className="font-mono text-sm font-semibold">{pod ? `${pod.namespace}/${pod.name}` : "Interactive pod terminal"}</p><p className="text-[10px] text-slate-400">{pod?.image ?? "Kubernetes exec · commands run inside the selected pod"}</p></div><span className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ${shellId ? "bg-emerald-400/10 text-emerald-300" : busy ? "bg-blue-400/10 text-blue-300" : "bg-white/10 text-slate-300"}`}><span className={`size-1.5 rounded-full ${shellId ? "bg-emerald-400" : busy ? "animate-pulse bg-blue-400" : "bg-slate-500"}`} />{shellId ? "Connected" : busy ? "Starting" : "Not connected"}</span></div>
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-slate-900/60 px-4 py-2"><span className="mr-auto text-[10px] text-slate-400">{shellId ? "Quick commands" : "Start a pod to enable commands"}</span>{shellId && <><button type="button" onClick={() => void execute("pwd")} disabled={busy} className="rounded-lg border border-white/10 px-2.5 py-1 text-[10px] text-slate-300 transition hover:bg-white/10 disabled:opacity-40">pwd</button><button type="button" onClick={() => void execute("ls -la")} disabled={busy} className="rounded-lg border border-white/10 px-2.5 py-1 text-[10px] text-slate-300 transition hover:bg-white/10 disabled:opacity-40">ls -la</button><button type="button" onClick={() => void execute("python --version")} disabled={busy} className="rounded-lg border border-white/10 px-2.5 py-1 text-[10px] text-slate-300 transition hover:bg-white/10 disabled:opacity-40">python --version</button><button type="button" onClick={() => setLines([])} className="rounded-lg border border-white/10 p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white" title="Clear terminal"><Trash2 className="size-3.5" /></button></>}</div>
        <div ref={terminalOutputRef} role="log" aria-live="polite" aria-label="Pod terminal output" className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#080d1b] p-4 font-mono text-xs [scrollbar-color:#475569_#080d1b] [scrollbar-width:thin]">{lines.length === 0 && <div className="grid h-full min-h-[250px] place-items-center text-center"><div><IconTile icon={TerminalIcon} tone="green" size="lg" className="mx-auto" /><h3 className="mt-4 font-sans text-base font-semibold text-slate-200">{shellId ? "Shell is ready" : "Your pod shell will appear here"}</h3><p className="mx-auto mt-2 max-w-sm font-sans text-xs leading-5 text-slate-400">{shellId ? "Type a command below, or choose a quick command above." : "Choose a container image, set CPU and memory, then create a pod to connect."}</p></div></div>}{lines.map((line, i) => <div key={`${i}-${line.command ?? "ready"}`} className="border-b border-white/[0.045] py-3 last:border-0"><p className="whitespace-pre-wrap break-words text-emerald-300"><span className="text-cyan-300">{pod?.name ?? "pod"} </span><span className="text-slate-500">$ </span>{line.command}</p>{line.stdout && <pre className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-slate-200">{line.stdout}</pre>}{line.stderr && <pre className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-rose-300">{line.stderr}</pre>}{line.exitCode !== undefined && <p className="mt-1 text-[10px] text-slate-600">exit {line.exitCode}</p>}</div>)}{busy && <p className="flex items-center gap-2 py-3 text-slate-400"><LoaderCircle className="size-3.5 animate-spin" />Running command in pod…</p>}</div>
        {error && <p className="border-t border-rose-400/20 bg-rose-400/5 px-4 py-2 text-xs text-rose-300">{error}</p>}
        <form onSubmit={run} className="shrink-0 border-t border-white/10 bg-slate-900 p-3"><div className="flex items-end gap-3 rounded-xl border border-white/10 bg-slate-950 px-3 focus-within:border-blue-400/50 focus-within:ring-2 focus-within:ring-blue-400/10"><span className="pb-3 font-mono text-sm text-emerald-300">$</span><textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); run(); } else if (e.key === "ArrowUp" && !input.includes("\n") && commandHistory.length) { e.preventDefault(); const next = Math.min(historyIndex + 1, commandHistory.length - 1); setHistoryIndex(next); setInput(commandHistory[commandHistory.length - 1 - next] ?? ""); } else if (e.key === "ArrowDown" && historyIndex >= 0) { e.preventDefault(); const next = historyIndex - 1; setHistoryIndex(next); setInput(next < 0 ? "" : commandHistory[commandHistory.length - 1 - next] ?? ""); } }} disabled={!shellId || busy} rows={1} className="max-h-32 min-h-11 min-w-0 flex-1 resize-y border-0 bg-transparent px-1 py-3 font-mono text-xs leading-5 text-white outline-none placeholder:text-slate-500 focus:ring-0 disabled:opacity-50" placeholder={shellId ? "Type a command · Enter to run · Shift+Enter for a new line" : "Waiting for pod connection…"} /><button disabled={!shellId || busy || !input.trim()} className="mb-1 inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-blue-500 px-3 text-sm font-semibold text-white transition hover:bg-blue-400 disabled:opacity-40"><Send className="size-4" /><span className="hidden sm:inline">Run</span></button></div><p className="pl-7 pt-2 text-[10px] leading-4 text-slate-500">Up/Down recalls commands. Commands run with <code>sh -lc</code>; each command is a separate process, so chain commands when sharing a working directory or variables.</p></form>
      </Panel>
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-semibold">{label}{children}</label>; }

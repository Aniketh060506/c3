import { createFileRoute, Link } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Cpu, LoaderCircle, MemoryStick, Play, RefreshCw, Terminal as TerminalIcon, Zap } from "lucide-react";
import { PageHeader, Panel } from "@/components/kit";
import { ImagePresetPicker } from "@/components/image-presets";
import { clusterService, type KubernetesPod } from "@/lib/platform";
import { SessionToolsTabs } from "@/components/session-tools-tabs";

export const Route = createFileRoute("/terminal")({
  validateSearch: (search: Record<string, unknown>) => ({ clusterId: typeof search["clusterId"] === "string" ? search["clusterId"] : "", nodeId: typeof search["nodeId"] === "string" ? search["nodeId"] : "" }),
  head: () => ({ meta: [{ title: "Interactive pod · ComputePool" }] }),
  component: InteractivePod,
});

const CREATE_POD = "__create__";
const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function InteractivePod() {
  const { clusterId, nodeId } = Route.useSearch();
  const [pods, setPods] = useState<KubernetesPod[]>([]);
  const visiblePods = nodeId ? pods.filter((pod) => pod.nodeName === nodeId) : pods;
  const [selectedPod, setSelectedPod] = useState(CREATE_POD);
  const [image, setImage] = useState("python:3.12-slim");
  const [namespace, setNamespace] = useState("default");
  const [cpu, setCpu] = useState(2);
  const [memory, setMemory] = useState(4);
  const [gpu, setGpu] = useState(0);
  const [shellId, setShellId] = useState<string | null>(null);
  const [connectedPod, setConnectedPod] = useState<KubernetesPod | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startupMessage, setStartupMessage] = useState<string | null>(null);
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const shellIdRef = useRef<string | null>(null);
  const openingShell = useRef(false);
  const cancelWait = useRef(false);

  const refreshPods = async () => {
    if (!clusterId) return;
    try {
      const current = await clusterService.pods(clusterId);
      setPods(current);
      setSelectedPod((old) => old === CREATE_POD || current.some((pod) => `${pod.namespace}/${pod.name}` === old && (!nodeId || pod.nodeName === nodeId)) ? old : CREATE_POD);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load running pods."); }
  };

  useEffect(() => { void refreshPods(); const timer = window.setInterval(() => void refreshPods(), 5000); return () => window.clearInterval(timer); }, [clusterId, nodeId]);

  useEffect(() => {
    if (!terminalHost.current) return;
    const term = new XTerm({ cursorBlink: true, fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace', fontSize: 14, lineHeight: 1.25, theme: { background: "#0c0c0c", foreground: "#e6e6e6", cursor: "#f2f2f2", selectionBackground: "#264f78", black: "#0c0c0c", red: "#f14c4c", green: "#23d18b", yellow: "#f5f543", blue: "#3b8eea", magenta: "#d670d6", cyan: "#29b8db", white: "#e5e5e5", brightBlack: "#666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5" }, allowProposedApi: false });
    const fitAddon = new FitAddon(); term.loadAddon(fitAddon); term.open(terminalHost.current); fitAddon.fit();
    terminal.current = term; fit.current = fitAddon;
    const dataHandler = term.onData((data) => { const activeShell = shellIdRef.current; if (activeShell) void clusterService.writePodTerminalInput(activeShell, data).catch((e: unknown) => setError(e instanceof Error ? e.message : "Terminal input failed.")); });
    const resizeHandler = term.onResize(({ cols, rows }) => { const activeShell = shellIdRef.current; if (activeShell) void clusterService.resizePodTerminal(activeShell, cols, rows).catch(() => undefined); });
    const observer = new ResizeObserver(() => { try { fitAddon.fit(); } catch { /* Ignore temporary hidden layout. */ } }); observer.observe(terminalHost.current);
    return () => { observer.disconnect(); dataHandler.dispose(); resizeHandler.dispose(); term.dispose(); terminal.current = null; fit.current = null; };
  }, []);

  useEffect(() => {
    let active = true;
    const dispose = listen<{ shellId: string; stream: string; data: string }>("pod-terminal-output", ({ payload }) => {
      if (active && (openingShell.current || payload.shellId === shellIdRef.current)) terminal.current?.write(payload.data);
    });
    return () => { active = false; void dispose.then((fn) => fn()); };
  }, []);

  useEffect(() => () => { const activeShell = shellIdRef.current; if (activeShell) void clusterService.closePodTerminal(activeShell); }, []);

  const connect = async (pod: KubernetesPod, retryUntilConnected = false) => {
    if (!retryUntilConnected) cancelWait.current = false;
    else setStartupMessage(`Pod ${pod.namespace}/${pod.name} is ready · opening terminal…`);
    setBusy(true); setError(null);
    try {
      const previousShell = shellIdRef.current;
      if (previousShell) await clusterService.closePodTerminal(previousShell);
      shellIdRef.current = null; openingShell.current = true;
      setShellId(null); terminal.current?.clear(); setConnectedPod(pod);
      let session: { shellId: string } | null = null;
      do {
        if (cancelWait.current) break;
        try {
          session = await clusterService.openPodShell(clusterId, pod.namespace, pod.name, pod.containers[0]);
        } catch (e) {
          if (!retryUntilConnected) throw e;
          if (cancelWait.current) break;
          setStartupMessage(`Pod is ready. Retrying terminal connection… (${e instanceof Error ? e.message : "waiting for Kubernetes exec"})`);
          await wait(1500);
        }
      } while (!session && retryUntilConnected && !cancelWait.current);
      openingShell.current = false;
      if (session) {
        shellIdRef.current = session.shellId;
        setConnectedPod(pod); setShellId(session.shellId); setStartupMessage(null);
        if (terminal.current) void clusterService.resizePodTerminal(session.shellId, terminal.current.cols, terminal.current.rows).catch(() => undefined);
      } else if (cancelWait.current) {
        shellIdRef.current = null; setShellId(null); setStartupMessage("Connection canceled. The pod is still running; select it above to connect later.");
        await refreshPods();
      }
    } catch (e) { openingShell.current = false; shellIdRef.current = null; setShellId(null); setStartupMessage(null); setError(e instanceof Error ? e.message : "Could not connect to pod."); }
    finally { setBusy(false); }
  };

  const createPod = async () => {
    if (!image.trim() || !clusterId) return;
    setBusy(true); setError(null); setStartupMessage("Creating pod in Kubernetes…"); cancelWait.current = false;
    try {
      const created = await clusterService.createInteractivePod(clusterId, { image: image.trim(), cpuCores: cpu, memoryGib: memory, gpuCount: gpu, namespace: namespace.trim(), targetNode: nodeId || undefined });
      const pod = { namespace: created.namespace, name: created.podName, image: created.image, phase: "Pending", containers: ["shell"], nodeName: created.nodeName ?? nodeId ?? null } satisfies KubernetesPod;
      setSelectedPod(`${pod.namespace}/${pod.name}`);
      for (;;) {
        if (cancelWait.current) break;
        try {
          const status = await clusterService.interactivePodStatus(clusterId, pod.namespace, pod.name);
          const detail = status.waitingReason || status.phase;
          setStartupMessage(`${pod.namespace}/${pod.name} · ${detail}${status.waitingMessage ? ` — ${status.waitingMessage}` : ""}`);
          if (status.phase === "Failed") throw new Error(`Pod startup failed (${detail}). ${status.waitingMessage || "Check the pod events and image name, then retry."}`);
          if (status.phase === "Running" && status.ready) break;
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Pod startup failed")) throw e;
          setStartupMessage(`${pod.namespace}/${pod.name} · Kubernetes is still starting the pod; retrying status check…`);
        }
        await wait(1500);
      }
      if (cancelWait.current) {
        setStartupMessage("Startup canceled. The pod remains in Kubernetes; select it above to connect later.");
        await refreshPods();
        return;
      }
      await refreshPods();
      await connect({ ...pod, phase: "Running" }, true);
    } catch (e) { setStartupMessage(null); setError(e instanceof Error ? e.message : "Could not create pod."); }
    finally { setBusy(false); }
  };

  const cancelStartup = () => { cancelWait.current = true; setStartupMessage("Canceling startup…"); };

  return <div className="w-full min-w-0">
    <Link to="/cluster" search={{ clusterId }} className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground"><ArrowLeft className="size-4" />Session dashboard</Link>
    <PageHeader eyebrow="Interactive compute · live Kubernetes exec" title="Pod terminal" />
    <SessionToolsTabs clusterId={clusterId} active="pods" />

    <Panel className="mb-4 p-4">
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(240px,1fr)_auto]">
        <Field label={nodeId ? `Pod on node · ${nodeId}` : "Start a pod · choose its node"}><select value={selectedPod} onChange={(event) => setSelectedPod(event.target.value)} className="field"><option value={CREATE_POD}>＋ Create a new pod{nodeId ? ` on ${nodeId}` : ""}</option>{visiblePods.map((pod) => <option key={`${pod.namespace}/${pod.name}`} value={`${pod.namespace}/${pod.name}`}>{pod.namespace}/{pod.name} ({pod.image || "image unknown"} · {pod.nodeName || "node pending"})</option>)}</select></Field>
        {selectedPod === CREATE_POD ? <button type="button" onClick={() => void createPod()} disabled={busy || !image.trim()} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}{nodeId ? "Create on this node" : "Create & connect"}</button> : <button type="button" onClick={() => { const pod = visiblePods.find((item) => `${item.namespace}/${item.name}` === selectedPod); if (pod) void connect(pod); }} disabled={busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <TerminalIcon className="size-4" />}Connect to pod</button>}
      </div>
      {selectedPod === CREATE_POD && <div className="mt-3 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(200px,1.5fr)_minmax(130px,1fr)_repeat(3,minmax(82px,.5fr)]">
        <Field label="Container image"><input value={image} onChange={(event) => setImage(event.target.value)} className="field" placeholder="registry/image:tag" /></Field>
        <Field label="Namespace"><input value={namespace} onChange={(event) => setNamespace(event.target.value)} className="field" /></Field>
        <Field label="CPU"><input type="number" min={1} max={256} value={cpu} onChange={(event) => setCpu(Math.max(1, Number(event.target.value)))} className="field" /></Field>
        <Field label="RAM GiB"><input type="number" min={1} max={4096} value={memory} onChange={(event) => setMemory(Math.max(1, Number(event.target.value)))} className="field" /></Field>
        <Field label="GPU"><input type="number" min={0} max={32} value={gpu} onChange={(event) => setGpu(Math.max(0, Number(event.target.value)))} className="field" /></Field>
        <div className="sm:col-span-2 lg:col-span-5"><ImagePresetPicker value={image} onSelect={setImage} compact /></div>
      </div>}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>{visiblePods.length} running pod{visiblePods.length === 1 ? "" : "s"}{nodeId ? ` on ${nodeId}` : ""} · refreshes every 5 sec</span><button type="button" onClick={() => void refreshPods()} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-muted"><RefreshCw className="size-3.5" />Refresh pods</button>{selectedPod === CREATE_POD && <span className="ml-auto inline-flex items-center gap-3"><span><Cpu className="mr-1 inline size-3.5" />{cpu} CPU</span><span><MemoryStick className="mr-1 inline size-3.5" />{memory} GiB</span><span><Zap className="mr-1 inline size-3.5" />{gpu} GPU</span></span>}</div>
      {startupMessage && <div className="mt-3 flex items-center gap-3 rounded-xl bg-blue-50 px-3 py-2 text-sm text-blue-900"><LoaderCircle className="size-4 shrink-0 animate-spin" /><span className="min-w-0 flex-1 break-words">{startupMessage}</span>{busy && <button type="button" onClick={cancelStartup} className="shrink-0 rounded-lg border border-blue-200 bg-white px-3 py-1.5 font-semibold hover:bg-blue-100">Cancel</button>}</div>}
    </Panel>
    {error && <Panel className="mb-3 border-rose-300 bg-rose-50 text-sm text-rose-800">{error}</Panel>}

    <Panel className="overflow-hidden rounded-xl border-[#34363b] bg-[#0c0c0c] p-0 text-[#f2f2f2] shadow-2xl">
      <div className="flex min-h-11 items-center gap-3 border-b border-[#333] bg-[#202020] px-3"><div className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-[#f96057]"/><span className="size-2.5 rounded-full bg-[#f8c04f]"/><span className="size-2.5 rounded-full bg-[#5fcf65]"/></div><div className="ml-2 flex h-8 max-w-[420px] min-w-0 items-center gap-2 rounded-t-lg border border-b-0 border-[#444] bg-[#0c0c0c] px-3 text-xs"><TerminalIcon className="size-3.5 shrink-0 text-[#72d7a0]"/><span className="truncate">{connectedPod ? `${connectedPod.namespace}/${connectedPod.name}` : "Windows Terminal · ComputePool"}</span></div><span className="ml-auto truncate text-[10px] text-[#aaa]">{connectedPod?.image ?? "Select a running pod above"}</span><span className={`ml-2 inline-flex shrink-0 items-center gap-1.5 text-[10px] ${shellId ? "text-[#72d7a0]" : "text-[#aaa]"}`}><span className={`size-1.5 rounded-full ${shellId ? "bg-[#72d7a0]" : "bg-[#888]"}`} />{shellId ? "LIVE" : "DISCONNECTED"}</span></div>
      <div ref={terminalHost} className="h-[min(70vh,720px)] min-h-[420px] w-full bg-[#0c0c0c] px-3 py-2" />
      <div className="flex flex-wrap items-center gap-2 border-t border-[#333] bg-[#1b1b1b] px-3 py-2"><span className="mr-auto text-[10px] text-[#888]">Pod shell · commands run in the selected container · output streams live</span>{["pwd", "ls -la", "python --version"].map((command) => <button key={command} type="button" disabled={!shellId} onClick={() => void clusterService.writePodTerminalInput(shellId!, `${command}\r`)} className="rounded-md border border-white/10 px-2.5 py-1 text-[10px] text-[#ccc] hover:bg-white/10 disabled:opacity-40">{command}</button>)}</div>
    </Panel>
    <p className="mt-3 text-xs text-muted-foreground">Run programs in the pod’s actual shell. Commands such as <code>top</code>, <code>ping</code>, or your own FPS/progress reporter stay attached and stream updates live until you stop them.</p>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-xs font-semibold">{label}{children}</label>; }

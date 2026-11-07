import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Clock3, Cpu, HardDrive, MemoryStick, Power, RefreshCw, Server, Workflow, Zap } from "lucide-react";
import { CardHeading, PageHeader, Panel } from "@/components/kit";
import { IconTile } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { dependencyService, hardwareService, providerService, type Dependency, type HardwareSnapshot, type ProviderSessionMetric, type ProviderStatus } from "@/lib/platform";

export const Route = createFileRoute("/provider/")({ head: () => ({ meta: [{ title: "Provider · ComputePool" }] }), component: ProviderDashboard });

function ProviderDashboard() {
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [sessions, setSessions] = useState<ProviderSessionMetric[]>([]);
  const [deps, setDeps] = useState<Dependency[] | null>(null);
  const [cpu, setCpu] = useState(0);
  const [ram, setRam] = useState(0);
  const [gpus, setGpus] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"capacity" | "telemetry">("capacity");
  const [telemetryUpdatedAt, setTelemetryUpdatedAt] = useState<string | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limitsHydrated = useRef(false);
  const statusVersion = useRef(0);
  const actionInProgress = useRef(false);

  const refresh = async () => {
    if (actionInProgress.current) return;
    const version = statusVersion.current;
    const labels = ["Local hardware", "Provider status", "Dependency check"];
    const results = await Promise.allSettled([hardwareService.get(), providerService.status(), dependencyService.list()]);
    const hw = results[0];
    if (hw.status === "fulfilled") {
      setHardware(hw.value);
      setCpu((n) => n || hw.value.cpu.logicalCores);
      setRam((n) => n || Math.floor(hw.value.memory.availableBytes / 1024 ** 3));
    }
    if (version === statusVersion.current && results[1].status === "fulfilled") {
      const value = results[1].value;
      setStatus(value);
      if (!limitsHydrated.current && value.limits) {
        if (value.limits.cpuCores) setCpu(value.limits.cpuCores);
        if (value.limits.memoryBytes) setRam(Math.floor(value.limits.memoryBytes / 1024 ** 3));
        if (value.limits.gpuIds) setGpus(value.limits.gpuIds);
        limitsHydrated.current = true;
      }
    }
    if (results[2].status === "fulfilled") setDeps(results[2].value);
    const failedIndex = results.findIndex((result) => result.status === "rejected");
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      const detail = failed.reason instanceof Error ? failed.reason.message : "Provider service unavailable.";
      setError(`${labels[failedIndex]} failed: ${detail}`);
    } else setError(null);
  };

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 20000); return () => window.clearInterval(timer); }, []);

  // Poll the actual provider worker containers while sharing is on. This is a
  // separate, light call so changing tabs does not stop the provider heartbeat.
  const refreshTelemetry = async () => {
    try {
      const live = await providerService.liveTelemetry();
      setSessions(live);
      setTelemetryUpdatedAt(new Date().toISOString());
      setTelemetryError(null);
    } catch (e) {
      setTelemetryError(e instanceof Error ? e.message : "Session telemetry refresh failed.");
    }
  };

  useEffect(() => {
    if (!status?.online) return;
    let active = true;
    const poll = async () => {
      try {
        const live = await providerService.liveTelemetry();
        if (active) { setSessions(live); setTelemetryUpdatedAt(new Date().toISOString()); setTelemetryError(null); }
      } catch (e) {
        if (active) setTelemetryError(e instanceof Error ? e.message : "Session telemetry refresh failed.");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [status?.online]);

  const activeSessions = sessions.filter((session) => session.state === "active");
  const hasReportedSession = activeSessions.length > 0 || (status?.activeSessions ?? 0) > 0;
  useEffect(() => { if (!hasReportedSession && tab === "telemetry") setTab("capacity"); }, [hasReportedSession, tab]);

  const toggle = async () => {
    actionInProgress.current = true;
    statusVersion.current += 1;
    setBusy(true);
    setError(null);
    try {
      if (!status?.online) {
        if (!hardware) throw new Error("Live hardware inventory is required before sharing.");
        if (!deps) throw new Error("Machine readiness could not be checked.");
        const missingDocker = deps.find((d) => d.id === "docker" && d.status !== "installed");
        if (missingDocker) throw new Error(`Start Docker Desktop before sharing. Check: ${missingDocker.name}.`);
        if (gpus.length && deps.some((d) => ["nvidia", "nvct"].includes(d.id) && d.status !== "installed")) throw new Error("NVIDIA drivers and NVIDIA Container Toolkit must be installed before offering GPU capacity.");
        await providerService.setLimits({ cpuCores: cpu, memoryBytes: ram * 1024 ** 3, gpuIds: gpus });
        setStatus(await providerService.setOnline(true));
      } else setStatus(await providerService.setOnline(false));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Provider status did not change.");
    } finally {
      actionInProgress.current = false;
      setBusy(false);
    }
  };

  const saveLimits = async () => {
    setBusy(true);
    setError(null);
    try { await providerService.setLimits({ cpuCores: cpu, memoryBytes: ram * 1024 ** 3, gpuIds: gpus }); }
    catch (e) { setError(e instanceof Error ? e.message : "Limits were not saved."); }
    finally { setBusy(false); }
  };

  const memoryGb = hardware ? Math.floor(hardware.memory.availableBytes / 1024 ** 3) : 0;
  return <div className="mx-auto max-w-7xl">
    <PageHeader eyebrow="Provider · local machine" title="Share this laptop">
      <Button variant="outline" className="rounded-xl" onClick={() => void refresh()}><RefreshCw className="mr-2 size-4" />Refresh live status</Button>
    </PageHeader>
    {error && <Panel className="mb-4 border-warning/40 text-sm text-muted-foreground">{error}</Panel>}
    {status?.connectionError && <Panel className="mb-4 border-warning/40 bg-warning-soft/30 text-sm text-muted-foreground">{status.connectionError}</Panel>}
    <Panel className={`mb-5 ${status?.online ? "border-success/40 bg-success-soft/50" : ""}`}>
      <div className="flex flex-wrap items-center gap-4"><IconTile icon={Power} tone={status?.online ? "green" : "slate"} size="lg" className={status?.online ? "animate-pulse" : ""} />
        <div className="min-w-52 flex-1"><h2 className="text-xl font-bold">{status?.online ? "This laptop is online" : "This laptop is offline"}</h2><p className="text-sm text-muted-foreground">{status ? `${status.activeSessions} active sessions · updated ${new Date(status.capturedAt).toLocaleTimeString()}` : "Provider presence has not been confirmed by the service."}</p></div>
        <Button onClick={() => void toggle()} disabled={busy || !hardware} className="rounded-xl">{busy ? "Updating…" : status?.online ? "Stop sharing" : "Save limits & go online"}</Button>
      </div>
    </Panel>

    <div role="tablist" aria-label="Provider dashboard sections" className="mb-5 flex w-fit gap-1 rounded-2xl border border-border bg-card p-1.5 shadow-sm">
      <button role="tab" aria-selected={tab === "capacity"} onClick={() => setTab("capacity")} className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition ${tab === "capacity" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted"}`}><Cpu className="mr-2 inline size-4" />Capacity overview</button>
      <button role="tab" aria-selected={tab === "telemetry"} disabled={!hasReportedSession} title={!hasReportedSession ? "Available after a provider worker joins the session." : "View live per-session worker metrics"} onClick={() => { setTab("telemetry"); void refreshTelemetry(); }} className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${tab === "telemetry" ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted"}`}><Activity className="mr-2 inline size-4" />Session telemetry{(status?.activeSessions ?? activeSessions.length) > 0 && <span className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-xs">{status?.activeSessions ?? activeSessions.length}</span>}</button>
    </div>

    {tab === "capacity" ? <>
      {!hardware ? <Panel className="text-sm text-muted-foreground">Live hardware inventory is needed to set safe contribution limits. Open the Windows app with the native hardware service connected.</Panel> : <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <Panel><CardHeading icon={Cpu} tone="blue" title="Your contribution limits" detail="Set your shareable capacity; keep the rest for your own work." />
          <div className="mb-5 rounded-xl bg-muted p-3 text-sm"><p className="font-semibold">{(hardware.memory.totalBytes / 1024 ** 3).toFixed(1)} GB installed</p><p className="mt-1 text-muted-foreground">{(hardware.memory.usedBytes / 1024 ** 3).toFixed(1)} GB in use · {(hardware.memory.availableBytes / 1024 ** 3).toFixed(1)} GB free now. The share limit is capped by currently free RAM to protect this laptop.</p></div>
          <Limit icon={Cpu} label="CPU cores" value={cpu} max={hardware.cpu.logicalCores} unit="cores" onChange={setCpu} />
          <Limit icon={MemoryStick} label="RAM to share (free now)" value={ram} max={memoryGb} unit="GB" onChange={setRam} />
          <div className="mt-5"><p className="flex items-center gap-2 text-sm font-semibold"><IconTile icon={Zap} tone="orange" size="sm" />GPU devices</p>
            {hardware.gpus.length ? <div className="mt-2 space-y-2">{hardware.gpus.map((gpu) => <label key={gpu.id} className={`flex items-center gap-3 rounded-xl border border-border bg-white p-3 text-sm shadow-sm transition hover:-translate-y-0.5 hover:shadow-soft ${gpu.computeSupported ? "" : "opacity-75"}`}><input type="checkbox" disabled={!gpu.computeSupported} checked={gpus.includes(gpu.id)} onChange={(e) => setGpus((all) => e.target.checked ? [...all, gpu.id] : all.filter((id) => id !== gpu.id))} /><IconTile icon={Zap} tone={/nvidia|geforce/i.test(gpu.name) ? "green" : "rose"} size="sm" /><span className="flex-1"><span className="block font-semibold">{gpu.name}</span><span className="text-xs text-muted-foreground">{gpu.computeSupported ? "NVIDIA GPU scheduling supported" : "Detected; GPU scheduling is not enabled for this adapter"}</span></span><span className="text-right text-xs text-muted-foreground">{gpu.vramTotalBytes > 0 ? `${(gpu.vramTotalBytes / 1024 ** 3).toFixed(1)} GB VRAM` : "Shared memory"}<br />{gpu.driverVersion ? `Driver ${gpu.driverVersion}` : "Driver reported by Windows"}</span></label>)}</div> : <p className="mt-2 text-sm text-muted-foreground">No GPU detected. Windows display adapters are checked locally.</p>}
          </div><Button variant="outline" className="mt-5 w-full rounded-xl" onClick={() => void saveLimits()} disabled={busy}>Save contribution limits</Button>
        </Panel>
        <Panel><CardHeading icon={Activity} tone="green" title="Live resource usage" detail={`Host readings · captured ${new Date(hardware.capturedAt).toLocaleTimeString()}`} />
          <div className="space-y-3"><Usage label="CPU" used={hardware.cpu.utilizationPercent} reserved={cpu / Math.max(1, hardware.cpu.logicalCores) * 100} detail={`${hardware.cpu.logicalCores} logical cores · ${cpu} offered`} /><Usage label="Memory" used={hardware.memory.usedBytes / Math.max(1, hardware.memory.totalBytes) * 100} reserved={ram / Math.max(1, hardware.memory.totalBytes / 1024 ** 3) * 100} detail={`${formatBytes(hardware.memory.usedBytes)} / ${formatBytes(hardware.memory.totalBytes)} · ${formatBytes(hardware.memory.availableBytes)} available`} />{hardware.gpus.map((gpu) => gpu.telemetryAvailable ? <Usage key={gpu.id} label={gpu.name} used={gpu.utilizationPercent} reserved={gpus.includes(gpu.id) ? 100 : 0} detail={`${formatBytes(gpu.vramUsedBytes)} / ${formatBytes(gpu.vramTotalBytes)} VRAM`} /> : <p key={gpu.id} className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">{gpu.name}: Windows detected the adapter, but this driver does not expose utilization telemetry.</p>)}</div>
          <div className="mt-5 rounded-xl bg-muted p-3 text-xs text-muted-foreground">Host utilization is separate from each session’s worker-container usage. Open Session telemetry after a worker joins to see container-level CPU, RAM, network, disk and process counts.</div>
        </Panel>
      </div>}
    </> : <TelemetryView sessions={activeSessions} updatedAt={telemetryUpdatedAt} error={telemetryError} reportedSessionCount={status?.activeSessions ?? 0} onRefresh={() => void refreshTelemetry()} />}
  </div>;
}

function TelemetryView({ sessions, updatedAt, error, reportedSessionCount, onRefresh }: { sessions: ProviderSessionMetric[]; updatedAt: string | null; error: string | null; reportedSessionCount: number; onRefresh: () => void }) {
  return <div className="space-y-4">
    <Panel><div className="flex flex-wrap items-center justify-between gap-3"><CardHeading className="mb-0" icon={Workflow} tone="violet" title="Connected worker telemetry" detail="Measurements are read from each live K3s worker container on this provider laptop." /><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString()}` : "Waiting for telemetry"}</span><Button variant="outline" size="sm" className="rounded-xl" onClick={onRefresh}><RefreshCw className="mr-2 size-4" />Refresh</Button></div></div></Panel>
    {error && <Panel className="border-warning/40 bg-warning-soft/30 text-sm text-muted-foreground">Telemetry request failed: {error}</Panel>}
    {sessions.length === 0 ? <Panel className="grid min-h-52 place-items-center text-center"><div><IconTile icon={Server} tone="blue" size="lg" className="mx-auto" /><h2 className="mt-3 font-bold">{reportedSessionCount ? `${reportedSessionCount} session${reportedSessionCount === 1 ? "" : "s"} reported; worker metrics not received yet` : "Waiting for a provider worker"}</h2><p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">{reportedSessionCount ? "Provider status reports the session, but this laptop has no matching live worker-container record. Keep the provider app open and check the worker connection; metrics will appear after Docker stats are returned." : "This view becomes available when a provider worker container joins the shared cluster."}</p></div></Panel> : <div className="grid gap-4 xl:grid-cols-2">{sessions.map((session) => <SessionTelemetryCard key={session.id} session={session} />)}</div>}
    <Panel className="text-xs leading-relaxed text-muted-foreground"><Activity className="mr-2 inline size-4 text-primary" />Container CPU, memory, network I/O, block I/O and process counts are sampled from Docker every 5 seconds. GPU scheduling and per-container GPU utilization are not enabled in this build, so GPU is reported as unavailable instead of estimated.</Panel>
  </div>;
}

function SessionTelemetryCard({ session }: { session: ProviderSessionMetric }) {
  const cpu = finite(session.cpuPercent) ? session.cpuPercent : null;
  const memory = finite(session.memoryBytes) ? session.memoryBytes : null;
  const memoryLimit = finite(session.memoryLimitBytes) ? session.memoryLimitBytes : null;
  const memoryPercent = finite(session.memoryPercent) ? session.memoryPercent : memory !== null && memoryLimit ? memory / memoryLimit * 100 : null;
  return <Panel className="overflow-hidden border-blue-100 bg-gradient-to-br from-white via-white to-blue-50/70">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><IconTile icon={Server} tone="blue" size="md" /><div className="min-w-0"><p className="truncate font-bold">{session.consumer}</p><p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="size-3.5" />Worker started {new Date(session.startedAt).toLocaleString()}</p></div></div><span className="rounded-full bg-success-soft px-3 py-1 text-xs font-bold capitalize text-success">{session.state}</span></div>
    <div className="mt-4 rounded-xl border border-blue-100 bg-white/80 p-3"><p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Worker container</p><p className="mt-1 break-all font-mono text-sm">{session.containerName ?? `cp-agent-${session.id}`}</p>{session.workloadDescription && <p className="mt-2 text-xs text-muted-foreground">{session.workloadDescription}</p>}</div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <LiveMetric icon={Cpu} label="CPU usage" value={cpu === null ? "Waiting for Docker stats" : `${cpu.toFixed(1)}%`} detail={session.requestedCpuCores ? `${session.requestedCpuCores} vCPU requested` : "Container quota not reported"} percent={cpu === null ? null : Math.min(100, cpu)} tone="blue" />
      <LiveMetric icon={MemoryStick} label="Memory" value={memory === null ? "Waiting for Docker stats" : `${formatBytes(memory)}${memoryLimit ? ` / ${formatBytes(memoryLimit)}` : ""}`} detail={memoryPercent === null ? "Container memory percentage unavailable" : `${memoryPercent.toFixed(1)}% of Docker limit · ${session.requestedMemoryBytes ? `${formatBytes(session.requestedMemoryBytes)} requested` : ""}`} percent={memoryPercent} tone="violet" />
      <TelemetryStat icon={ArrowDownToLine} label="Network received" value={session.networkRxBytes == null ? "—" : formatBytes(session.networkRxBytes)} detail="Container total since start" />
      <TelemetryStat icon={ArrowUpFromLine} label="Network sent" value={session.networkTxBytes == null ? "—" : formatBytes(session.networkTxBytes)} detail="Container total since start" />
      <TelemetryStat icon={HardDrive} label="Block read / written" value={session.blockReadBytes == null && session.blockWriteBytes == null ? "—" : `${formatBytes(session.blockReadBytes ?? 0)} / ${formatBytes(session.blockWriteBytes ?? 0)}`} detail="Docker block I/O totals" />
      <TelemetryStat icon={Activity} label="Processes" value={session.processCount == null ? "—" : String(session.processCount)} detail={`Elapsed ${elapsed(session.startedAt)}${session.durationMinutes ? ` · ${session.durationMinutes} min agreed` : ""}`} />
    </div>
    <div className="mt-3 flex items-center gap-3 rounded-xl border border-orange-100 bg-orange-50/60 p-3"><IconTile icon={Zap} tone="orange" size="sm" /><div className="min-w-0"><p className="text-xs font-bold">GPU telemetry unavailable</p><p className="mt-0.5 text-xs text-muted-foreground">This build does not enable Kubernetes GPU scheduling or per-worker GPU utilization.</p></div></div>
    {session.telemetryAvailable === false && <p className="mt-3 rounded-xl border border-warning/30 bg-warning-soft/30 p-3 text-xs text-muted-foreground">The worker is connected, but Docker did not return container statistics yet. Metrics will fill in on the next poll; check that Docker Desktop is running if they remain unavailable.</p>}
  </Panel>;
}

function Limit({ icon: Icon, label, value, max, unit, onChange }: { icon: typeof Cpu; label: string; value: number; max: number; unit: string; onChange: (n: number) => void }) {
  return <label className="mb-5 block rounded-2xl border border-slate-100 bg-white p-3"><span className="flex items-center gap-3 text-sm font-semibold"><IconTile icon={Icon} tone={label.includes("CPU") ? "blue" : "violet"} size="sm" />{label}</span><span className="mt-3 flex items-center gap-3"><input type="range" min={0} max={max} value={Math.min(value, max)} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-primary" /><span className="min-w-20 text-right font-mono text-sm">{Math.min(value, max)} / {max} {unit}</span></span></label>;
}

function Usage({ label, used, reserved, detail }: { label: string; used: number; reserved: number; detail: string }) {
  const pct = Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : 0;
  const tone = /gpu|nvidia|radeon/i.test(label) ? "from-orange-400 to-rose-500" : /memory/i.test(label) ? "from-violet-500 to-indigo-500" : "from-blue-500 to-cyan-400";
  return <div className="rounded-xl border border-slate-100 bg-white p-3"><div className="flex justify-between gap-3 text-xs"><span className="truncate font-semibold">{label}</span><span className="shrink-0 text-muted-foreground">{pct.toFixed(0)}% in use · {reserved.toFixed(0)}% offered</span></div><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full bg-gradient-to-r ${tone} transition-all duration-700`} style={{ width: `${pct}%` }} /></div></div>;
}

function LiveMetric({ icon: Icon, label, value, detail, percent, tone }: { icon: typeof Cpu; label: string; value: string; detail: string; percent: number | null; tone: "blue" | "violet" }) {
  const accent = tone === "blue" ? "text-blue-700 bg-blue-50" : "text-violet-700 bg-violet-50";
  return <div className="rounded-xl border border-border bg-white p-3"><p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><span className={`grid size-7 place-items-center rounded-lg ${accent}`}><Icon className="size-4" /></span>{label}</p><p className="mt-2 truncate text-lg font-bold" title={value}>{value}</p><p className="mt-1 min-h-4 text-[11px] text-muted-foreground">{detail}</p>{percent !== null && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all duration-500 ${tone === "blue" ? "bg-gradient-to-r from-blue-500 to-cyan-400" : "bg-gradient-to-r from-violet-500 to-indigo-400"}`} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>}</div>;
}

function TelemetryStat({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-border bg-white p-3"><p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground"><span className="grid size-7 place-items-center rounded-lg bg-cyan-50 text-cyan-700"><Icon className="size-4" /></span>{label}</p><p className="mt-2 truncate text-lg font-bold" title={value}>{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></div>;
}

function finite(value: number | null | undefined): value is number { return typeof value === "number" && Number.isFinite(value); }
function formatBytes(value: number | null | undefined): string {
  if (!finite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = Math.max(0, value), unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function elapsed(start: string) { const duration = Date.now() - new Date(start).getTime(); if (!Number.isFinite(duration) || duration < 0) return "—"; const minutes = Math.floor(duration / 60000); return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Boxes, Check, CircleAlert, Cpu, HardDrive, MemoryStick, Monitor, Network, RefreshCw, ShieldCheck, Store, Zap } from "lucide-react";
import { motion } from "motion/react";
import { PageHeader, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { dependencyService, hardwareService, isTauri, type Dependency, type HardwareSnapshot } from "@/lib/platform";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "ComputePool · Machine readiness" }, { name: "description", content: "Live machine diagnostics and choose a ComputePool role." }] }),
  component: Overview,
});

function Overview() {
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);
  const [deps, setDeps] = useState<Dependency[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    if (!isTauri()) {
      setHardware(null); setDeps(null);
      setError("Live hardware and dependency checks are available in the Windows desktop app.");
      return;
    }
    const [hw, checks] = await Promise.allSettled([hardwareService.get(), dependencyService.list()]);
    if (hw.status === "fulfilled") { setHardware(hw.value); setUpdated(hw.value.capturedAt); }
    else setHardware(null);
    if (checks.status === "fulfilled") setDeps(checks.value);
    else setDeps(null);
    if (hw.status === "rejected" || checks.status === "rejected") {
      const reason = hw.status === "rejected" ? hw.reason : checks.status === "rejected" ? checks.reason : null;
      setError(reason instanceof Error ? reason.message : "The desktop diagnostics service is unavailable.");
    }
  }, []);

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, [refresh]);

  const install = async (dep: Dependency) => {
    const action = dep.id === "k3s" ? "Download the K3s image into Docker Desktop now?" : `Install or start ${dep.name} on this computer?`;
    if (!window.confirm(action)) return;
    setBusy(dep.id);
    try {
      await dependencyService.install(dep.id);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : `Could not install ${dep.name}.`); }
    finally { setBusy(null); }
  };

  const memoryPercent = hardware ? percent(hardware.memory.usedBytes, hardware.memory.totalBytes) : null;
  const gpuList = hardware?.gpus ?? [];
  const firstGpu = gpuList.at(0);
  const gpuNames = gpuList.map((item) => item.name);
  const gpuLabel = gpuList.length === 0 ? (hardware ? "No GPU detected" : "Waiting for telemetry") : gpuList.length === 1 ? firstGpu?.name ?? "Graphics adapter detected" : `${gpuList.length} graphics adapters detected`;
  const gpuDetails = gpuList.length === 0 ? "Windows display-adapter inventory is empty" : gpuNames.join(" · ");
  const storage = hardware?.storage[0];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader eyebrow="ComputePool · Windows desktop" title="Your machine, ready for the pool">
        <Link to="/netbird" className="inline-flex items-center rounded-xl border border-border bg-card px-4 py-2 text-sm font-semibold hover:bg-muted"><Network className="mr-2 size-4" />NetBird setup</Link>
        <Button variant="outline" className="rounded-xl" onClick={() => void refresh()}><RefreshCw className="mr-2 size-4" />Refresh diagnostics</Button>
      </PageHeader>

      <Panel className="mb-5 overflow-hidden bg-hero">
        <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold">
              <span className={`size-2 rounded-full ${hardware ? "bg-success" : "bg-muted-foreground"}`} />
              {hardware ? `Live · updated ${formatTime(updated)}` : "Waiting for live desktop diagnostics"}
            </div>
            <h2 className="max-w-3xl text-3xl font-bold md:text-4xl">One app. Two ways to compute.</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">Check this laptop first, then choose whether to rent capacity from online providers or share resources from this machine.</p>
          </div>
          <div className="grid size-24 place-items-center rounded-[2rem] bg-primary text-primary-foreground"><Boxes className="size-11" /></div>
        </div>
      </Panel>

      {error && <div role="status" className="mb-5 flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-sm"><CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div><p className="font-semibold">Live data unavailable</p><p className="mt-1 text-muted-foreground">{error}</p></div></div>}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <HardwareCard icon={Cpu} title="Processor" value={hardware?.cpu.model ?? "Waiting for telemetry"} detail={hardware ? `${hardware.cpu.physicalCores} cores · ${hardware.cpu.logicalCores} threads${hardware.cpu.frequencyMhz ? ` · ${(hardware.cpu.frequencyMhz / 1000).toFixed(1)} GHz` : ""}` : "No system values are being estimated"} meter={hardware?.cpu.utilizationPercent} />
        <HardwareCard icon={MemoryStick} title="Memory" value={hardware ? `${bytes(hardware.memory.totalBytes)} installed` : "Waiting for telemetry"} detail={hardware ? `${bytes(hardware.memory.usedBytes)} used · ${bytes(hardware.memory.availableBytes)} available` : "Live values come from this laptop"} meter={memoryPercent ?? undefined} />
        <HardwareCard icon={Zap} title="Graphics" value={gpuLabel} detail={gpuDetails} meter={gpuList.length === 1 && firstGpu?.telemetryAvailable ? firstGpu.utilizationPercent : undefined} />
        <HardwareCard icon={HardDrive} title="Storage" value={storage?.name ?? (hardware ? "No volume reported" : "Waiting for telemetry")} detail={storage ? `${bytes(storage.availableBytes)} free of ${bytes(storage.totalBytes)}` : "Only local volume data is shown"} meter={undefined} />
      </div>

      <Panel className="mb-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-xl font-bold">Runtime readiness</h2><p className="text-sm text-muted-foreground">Only Docker Desktop and NetBird need to be ready. K3s runs in Docker and downloads when you start a session.</p></div>
          <span className="rounded-full bg-muted px-3 py-1.5 text-xs font-semibold">{deps ? `${deps.filter((d) => d.id !== "k3s" && d.status === "installed").length} / 2 core services ready` : "Status not reported"}</span>
        </div>
        {deps?.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{deps.map((dep) => <DependencyRow key={dep.id} dep={dep} busy={busy === dep.id} onInstall={() => void install(dep)} onRefresh={() => void refresh()} />)}</div> : <div className="rounded-2xl border border-dashed border-border bg-muted/40 p-5 text-sm text-muted-foreground">{isTauri() ? "The desktop dependency checker has not returned results. No installation state is assumed." : "Open the Windows desktop app to check the Docker Desktop engine, NetBird connection, and Docker-managed K3s runtime."}</div>}
        {hardware?.network && <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground"><Network className="size-4" />{hardware.network.connected ? "Internet connected" : "No internet connection"} · NetBird {hardware.network.netbirdStatus}{hardware.network.peerIp ? ` · ${hardware.network.peerIp}` : ""}{hardware.network.interfaceName ? ` · ${hardware.network.interfaceName}` : ""}</p>}
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        <RoleCard to="/marketplace" icon={Store} title="Consumer" subtitle="Rent compute" description="Find providers that are online now, negotiate resource limits and pricing, choose a project folder, then start a session after the provider accepts." />
        <RoleCard to="/provider" icon={Monitor} title="Provider" subtitle="Share this laptop" description="Set CPU, memory, and GPU limits from live hardware. Bring this machine online and review each consumer request before accepting." />
      </div>
      <p className="mt-4 text-center text-xs text-muted-foreground"><ShieldCheck className="mr-1 inline size-3.5" />Hardware values come from this laptop. Remote provider, session, and workload data requires a live service connection.</p>
    </div>
  );
}

function HardwareCard({ icon: Icon, title, value, detail, meter }: { icon: typeof Cpu; title: string; value: string; detail: string; meter: number | undefined }) {
  return <Panel className="min-w-0"><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Icon className="size-4" />{title}</span>{meter === undefined ? <span className="text-xs text-muted-foreground">—</span> : <span className="font-mono text-sm font-bold">{meter.toFixed(0)}%</span>}</div><p className="mt-4 truncate font-semibold" title={value}>{value}</p><p className="mt-1 min-h-10 text-xs text-muted-foreground">{detail}</p>{meter !== undefined && <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><motion.div className="h-full rounded-full bg-primary" animate={{ width: `${Math.max(0, Math.min(100, meter))}%` }} transition={{ type: "spring", stiffness: 100, damping: 20 }} /></div>}</Panel>;
}

function DependencyRow({ dep, busy, onInstall, onRefresh }: { dep: Dependency; busy: boolean; onInstall: () => void; onRefresh: () => void }) {
  const ready = dep.status === "installed" || dep.status === "on_demand";
  const label: Record<Dependency["status"], string> = { installed: "Ready", on_demand: "Managed by ComputePool", missing: "Not installed", outdated: "Update needed", not_running: "Engine not running", configuration_required: "Sign-in needed" };
  return <div className="rounded-2xl border border-border bg-background p-4"><div className="flex items-start justify-between gap-2"><p className="text-sm font-semibold">{dep.name}</p>{ready ? <Check className="size-4 text-success" /> : <CircleAlert className="size-4 text-warning" />}</div><p className="mt-1 font-mono text-[11px] text-muted-foreground">{dep.installedVersion ? `v${dep.installedVersion}` : dep.status === "on_demand" ? "Docker image pulled on first session" : `required ${dep.requiredVersion}`}</p><p className="mt-2 text-xs font-semibold">{label[dep.status]}</p>{dep.details && <p className="mt-1 min-h-10 text-xs leading-relaxed text-muted-foreground">{dep.details}</p>}{!ready && dep.id === "netbird" && <Link to="/netbird" className="mt-3 block w-full rounded-xl bg-primary-soft px-2 py-2 text-center text-xs font-bold text-primary">Open setup guide</Link>}{dep.id === "k3s" && dep.status === "on_demand" && <button disabled={busy} onClick={onInstall} className="mt-3 w-full rounded-xl bg-primary px-2 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50">{busy ? "Downloading image…" : "Download K3s image now"}</button>}{!ready && dep.status !== "configuration_required" && dep.id !== "k3s" && <button disabled={busy} onClick={onInstall} className="mt-2 w-full rounded-xl bg-primary px-2 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50">{busy ? "Working…" : dep.id === "docker" && dep.status === "not_running" ? "Start Docker Desktop" : dep.status === "missing" ? "Install" : "Retry"}</button>}{dep.status === "configuration_required" && <button onClick={onRefresh} className="mt-3 w-full rounded-xl border border-border px-2 py-2 text-xs font-bold">Refresh status</button>}</div>;
}

function RoleCard({ to, icon: Icon, title, subtitle, description }: { to: "/marketplace" | "/provider"; icon: typeof Store; title: string; subtitle: string; description: string }) {
  return <Link to={to}><motion.div whileHover={{ y: -3 }} className="h-full rounded-3xl border border-border bg-card p-6 shadow-soft transition-shadow hover:shadow-lift"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary">{subtitle}</p><h2 className="mt-2 text-2xl font-bold">{title}</h2></div><span className="grid size-12 place-items-center rounded-2xl bg-primary-soft text-primary"><Icon className="size-5" /></span></div><p className="mt-3 max-w-xl text-sm text-muted-foreground">{description}</p><p className="mt-5 text-sm font-bold text-primary">Open {title} →</p></motion.div></Link>;
}

function bytes(value: number) { if (!Number.isFinite(value) || value < 0) return "—"; const units = ["B", "KB", "MB", "GB", "TB"]; let n = value, i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`; }
function percent(part: number, total: number) { return total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0; }
function formatTime(value: string | null) { if (!value) return "just now"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

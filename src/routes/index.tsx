import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Boxes, Check, CircleAlert, Cpu, HardDrive, MemoryStick, MessageCircle, Monitor, Network, RefreshCw, ShieldCheck, Store, Zap } from "lucide-react";
import { motion } from "motion/react";
import { CardHeading, IconTile, PageHeader, Panel } from "@/components/kit";
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
          <NetworkArtwork />
        </div>
      </Panel>

      <section aria-label="How ComputePool works" className="mb-5 grid gap-3 rounded-3xl border border-border bg-white p-4 shadow-soft sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center sm:p-5">
        <FlowStep icon={Cpu} number="01" title="Check this laptop" detail="Live hardware and runtime readiness" />
        <ArrowRight className="mx-auto hidden size-4 text-primary/50 sm:block" />
        <FlowStep icon={MessageCircle} number="02" title="Agree on resources" detail="Discuss the request before sharing" />
        <ArrowRight className="mx-auto hidden size-4 text-primary/50 sm:block" />
        <FlowStep icon={Boxes} number="03" title="Run the workload" detail="Start isolated Kubernetes jobs" />
      </section>

      {error && <div role="status" className="mb-5 flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-sm"><CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div><p className="font-semibold">Live data unavailable</p><p className="mt-1 text-muted-foreground">{error}</p></div></div>}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <HardwareCard icon={Cpu} title="Processor" value={hardware?.cpu.model ?? "Waiting for telemetry"} detail={hardware ? `${hardware.cpu.physicalCores} cores · ${hardware.cpu.logicalCores} threads${hardware.cpu.frequencyMhz ? ` · ${(hardware.cpu.frequencyMhz / 1000).toFixed(1)} GHz` : ""}` : "No system values are being estimated"} meter={hardware?.cpu.utilizationPercent} />
        <HardwareCard icon={MemoryStick} title="Memory" value={hardware ? `${bytes(hardware.memory.totalBytes)} installed` : "Waiting for telemetry"} detail={hardware ? `${bytes(hardware.memory.usedBytes)} used · ${bytes(hardware.memory.availableBytes)} available` : "Live values come from this laptop"} meter={memoryPercent ?? undefined} />
        <HardwareCard icon={Zap} title="Graphics" value={gpuLabel} detail={gpuDetails} meter={gpuList.length === 1 && firstGpu?.telemetryAvailable ? firstGpu.utilizationPercent : undefined} />
        <HardwareCard icon={HardDrive} title="Storage" value={storage?.name ?? (hardware ? "No volume reported" : "Waiting for telemetry")} detail={storage ? `${bytes(storage.availableBytes)} free of ${bytes(storage.totalBytes)}` : "Only local volume data is shown"} meter={undefined} />
      </div>

      <Panel className="mb-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <CardHeading className="mb-0" icon={Boxes} tone="green" title="Runtime readiness" detail="Docker Desktop and NetBird must be ready. A cached K3s image is only a prerequisite; the session cluster starts when you start a session." />
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
  const theme = hardwareTheme(title);
  return <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -4 }} transition={{ duration: 0.38, delay: hardwareDelay(title), type: "spring", stiffness: 240, damping: 22 }} className={`hardware-card hardware-${theme.name} relative min-w-0 overflow-hidden rounded-3xl border bg-white p-5 shadow-soft`}>
    <div className="hardware-glow pointer-events-none absolute -right-8 -top-10 size-32 rounded-full blur-2xl" />
    <div className="relative flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-3">
        <motion.span whileHover={{ rotate: 5, scale: 1.08 }} transition={{ type: "spring", stiffness: 360, damping: 18 }} className="resource-icon grid size-14 shrink-0 place-items-center rounded-2xl border"><ResourceMark title={title} value={value} detail={detail} fallback={Icon} /></motion.span>
        <span className="truncate text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">{title}</span>
      </span>
      {meter === undefined ? <span className="hardware-chip rounded-full px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide">On device</span> : <span className="hardware-chip rounded-full px-2.5 py-1 font-mono text-xs font-extrabold">{meter.toFixed(0)}%</span>}
    </div>
    <p className="relative mt-4 min-h-12 font-bold leading-snug" title={value}>{value}</p>
    <p className="relative mt-1 min-h-10 text-xs leading-relaxed text-muted-foreground">{detail}</p>
    {meter !== undefined && <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><motion.div className="hardware-meter h-full rounded-full" animate={{ width: `${Math.max(0, Math.min(100, meter))}%` }} transition={{ type: "spring", stiffness: 100, damping: 20 }} /></div>}
  </motion.div>;
}

function hardwareTheme(title: string) {
  if (title === "Processor") return { name: "cpu" };
  if (title === "Memory") return { name: "memory" };
  if (title === "Graphics") return { name: "graphics" };
  return { name: "storage" };
}
function hardwareDelay(title: string) { return title === "Processor" ? 0 : title === "Memory" ? 0.06 : title === "Graphics" ? 0.12 : 0.18; }

function ResourceMark({ title, value, detail, fallback: Fallback }: { title: string; value: string; detail: string; fallback: typeof Cpu }) {
  if (title === "Processor" && /ryzen/i.test(value)) return <div className="flex flex-col items-center leading-none"><RyzenSymbol /><span className="mt-0.5 text-[7px] font-black tracking-[0.13em] text-slate-700">RYZEN</span></div>;
  if (title === "Processor" && /intel/i.test(value)) return <div className="flex flex-col items-center leading-none"><span className="font-display text-[16px] font-black italic tracking-tight text-[#0878c9]">intel</span><span className="mt-0.5 text-[7px] font-bold tracking-[0.12em] text-[#0878c9]">CORE</span></div>;
  if (title === "Memory") return <RamModule />;
  if (title === "Graphics") {
    const names = detail.split(" · ").map((name) => name.trim()).filter(Boolean);
    const hasNvidia = names.some((name) => /nvidia|geforce/i.test(name));
    const hasAmd = names.some((name) => /amd|radeon/i.test(name));
    return <div className="flex items-center justify-center gap-1.5">
      {hasNvidia && <NvidiaSymbol />}{hasAmd && <AmdSymbol />}
      {!hasNvidia && !hasAmd && <GraphicsCardMark />}
    </div>;
  }
  if (title === "Storage") return <StorageDrive />;
  if (title === "Processor") return <CpuMark />;
  return <Fallback className="size-6 text-slate-500" />;
}

function CpuMark() {
  return <svg aria-label="Processor" role="img" viewBox="0 0 48 48" className="size-9">
    <defs><linearGradient id="cpu-body" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ffb347"/><stop offset="1" stopColor="#f15b2a"/></linearGradient></defs>
    <rect x="11" y="11" width="26" height="26" rx="6" fill="url(#cpu-body)"/><rect x="17" y="17" width="14" height="14" rx="3" fill="#fff3de" stroke="#fff" strokeWidth="2"/>
    <path d="M17 5v6m7-6v6m7-6v6M17 37v6m7-6v6m7-6v6M5 17h6m-6 7h6m-6 7h6m26-14h6m-6 7h6m-6 7h6" stroke="#d85a27" strokeWidth="3" strokeLinecap="round"/>
  </svg>;
}

function GraphicsCardMark() {
  return <svg aria-label="Graphics adapter" role="img" viewBox="0 0 56 40" className="size-10">
    <defs><linearGradient id="gpu-case" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#8b5cf6"/><stop offset="1" stopColor="#2563eb"/></linearGradient></defs>
    <path d="M5 7h41a5 5 0 0 1 5 5v17a5 5 0 0 1-5 5H5z" fill="url(#gpu-case)"/><circle cx="23" cy="20" r="10" fill="#eef2ff"/><circle cx="23" cy="20" r="3" fill="#6366f1"/>
    <path d="M23 10c4 3 5 6 0 10-4-4-4-7 0-10zm10 10c-3 4-6 5-10 0 4-4 7-4 10 0zm-10 10c-4-3-5-6 0-10 4 4 4 7 0 10zM13 20c3-4 6-5 10 0-4 4-7 4-10 0z" fill="#a5b4fc"/>
    <path d="M46 12h5v16h-5M8 35v3m5-3v3m5-3v3m5-3v3" stroke="#334155" strokeWidth="2" strokeLinecap="round"/>
    <title>Graphics adapter</title>
  </svg>;
}

function RyzenSymbol() {
  return <svg aria-label="AMD Ryzen" role="img" viewBox="0 0 40 30" className="size-8">
    <path fill="#ed6c25" d="M5 4h27l5 5H17l-4 4h17l-5 5H13l-4 4h18l-5 5H4l7-7h11l4-4H10l7-7H9l-4 5H2z" />
    <path fill="#f39b38" d="M29 19h8v5h-8zM31 26h6v3h-6z" />
  </svg>;
}

function RamModule() {
  return <svg aria-label="Memory module" role="img" viewBox="0 0 64 44" className="size-11">
    <defs><linearGradient id="ram-pcb" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#176c52" /><stop offset="1" stopColor="#0e3d34" /></linearGradient></defs>
    <path d="M8 7h48v25H8z" rx="4" fill="url(#ram-pcb)" />
    <path d="M12 11h11v15H12zM27 11h11v15H27zM42 11h11v15H42z" rx="2" fill="#202d37" stroke="#6fc0a0" strokeWidth="1.5" />
    <path d="M12 34v5m7-7v7m7-7v7m7-7v7m7-7v7m7-7v7m7-7v7" stroke="#d8aa43" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M10 17H6m52 0h-4M17 13v4m15-4v4m15-4v4" stroke="#83d3b3" strokeWidth="1.5" strokeLinecap="round" />
  </svg>;
}

function NvidiaSymbol() {
  return <svg aria-label="NVIDIA" role="img" viewBox="0 0 44 38" className="size-6">
    <path fill="#76b900" d="M2 19c6-8 13-12 21-12 7 0 13 3 19 9-5-3-10-4-14-3 3 2 5 5 5 8 0 6-5 10-11 10-7 0-12-5-12-11 0-2 .6-4 1.7-5.6C8.5 15.1 5.2 16.8 2 19z" />
    <path fill="#e7f5d2" d="M15 19c2.4-3.7 5.3-5.6 8.7-5.6 5 0 8.6 3.4 8.6 7.7 0 4.1-3.2 6.8-7 6.8-4.1 0-7.1-3-7.1-6.7 0-1.1.3-2.2.9-3.2 1.2-1.7 2.8-2.6 4.9-2.6 2.5 0 4.3 1.7 4.3 3.9 0 1.9-1.3 3.1-3 3.1-1.5 0-2.6-1-2.6-2.3 0-.9.5-1.6 1.4-2 .3-.1.6-.2 1-.2-2.2-1.5-6.3-.2-6.3 3.4 0 2.6 2 4.5 4.9 4.5 3.5 0 5.9-2.5 5.9-5.7 0-3.4-3-6.1-6.9-6.1-4.8 0-9 3.3-11.7 8.5l-4.2-2.1c2-4 4.8-7.1 8.2-9.2-4.8.8-9.1 3.3-13 7.4V19z" />
  </svg>;
}

function AmdSymbol() {
  return <svg aria-label="AMD Radeon" role="img" viewBox="0 0 40 40" className="size-6">
    <path fill="#ed1c24" d="M6 7h27v27L22 23l-8 8V19l8-8H6z" />
    <path fill="#ff5a36" d="M24 12h5v5h-5zm-9 14 5-5 8 8v2H15z" />
  </svg>;
}

function StorageDrive() {
  return <svg aria-label="Storage drive" role="img" viewBox="0 0 48 48" className="size-8">
    <defs><linearGradient id="drive-metal" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#dfe8f2" /><stop offset="1" stopColor="#aab8c8" /></linearGradient></defs>
    <rect x="7" y="9" width="34" height="30" rx="7" fill="url(#drive-metal)" stroke="#8999aa" strokeWidth="1.5" />
    <rect x="12" y="14" width="24" height="13" rx="3" fill="#f9fbfd" stroke="#9eacb9" />
    <circle cx="24" cy="20.5" r="4" fill="#dce8f1" stroke="#7f91a3" strokeWidth="1.5" />
    <circle cx="24" cy="20.5" r="1.2" fill="#738598" />
    <path d="M15 32h11m4 0h3" stroke="#657789" strokeWidth="2" strokeLinecap="round" />
  </svg>;
}

function NetworkArtwork() {
  return <div aria-hidden="true" className="relative hidden size-36 place-items-center sm:grid">
    <div className="absolute inset-3 rounded-full border border-primary/10" />
    <div className="absolute inset-0 rounded-full border border-dashed border-primary/15 network-orbit" />
    <div className="absolute inset-5 rounded-full bg-primary/5 blur-xl" />
    <div className="relative grid size-20 place-items-center rounded-[1.75rem] bg-primary text-primary-foreground shadow-lift"><Boxes className="size-9" /></div>
    <span className="network-pulse absolute left-4 top-7 grid size-9 place-items-center rounded-xl border border-white bg-white text-primary shadow-soft"><Cpu className="size-4" /></span>
    <span className="network-pulse absolute right-3 top-12 grid size-9 place-items-center rounded-xl border border-white bg-white text-primary shadow-soft [animation-delay:700ms]"><Network className="size-4" /></span>
    <span className="network-pulse absolute bottom-4 left-12 grid size-9 place-items-center rounded-xl border border-white bg-white text-primary shadow-soft [animation-delay:1400ms]"><Store className="size-4" /></span>
    <span className="absolute right-7 top-4 size-1.5 rounded-full bg-success shadow-[0_0_0_5px_oklch(0.66_0.15_158_/_12%)]" />
  </div>;
}

function FlowStep({ icon: Icon, number, title, detail }: { icon: typeof Cpu; number: string; title: string; detail: string }) {
  return <motion.div whileHover={{ x: 2 }} className="flex items-center gap-3 rounded-2xl px-2 py-2 sm:px-1">
    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><Icon className="size-4" /></span>
    <span className="min-w-0"><span className="block text-[10px] font-bold tracking-[0.14em] text-primary">STEP {number}</span><span className="block text-sm font-bold">{title}</span><span className="block text-xs text-muted-foreground">{detail}</span></span>
  </motion.div>;
}

function DependencyRow({ dep, busy, onInstall, onRefresh }: { dep: Dependency; busy: boolean; onInstall: () => void; onRefresh: () => void }) {
  const ready = dep.status === "installed" || dep.status === "on_demand";
  const label: Record<Dependency["status"], string> = { installed: "Ready", on_demand: "Managed by ComputePool", missing: "Not installed", outdated: "Update needed", not_running: "Engine not running", configuration_required: "Sign-in needed" };
  const name = dep.id === "k3s" ? "ComputePool K3s session" : dep.name;
  const statusLabel = dep.id === "k3s"
    ? dep.installedVersion === "running in Docker"
      ? "Container running · cluster readiness checked during session startup"
      : dep.status === "installed"
        ? "Image cached · session cluster stopped"
        : dep.status === "on_demand"
          ? "Image pulled when a session starts"
          : label[dep.status]
    : label[dep.status];
  return <div className="rounded-2xl border border-border bg-background p-4"><div className="flex items-start justify-between gap-2"><p className="text-sm font-semibold">{name}</p>{ready ? <Check className="size-4 text-success" /> : <CircleAlert className="size-4 text-warning" />}</div><p className="mt-1 font-mono text-[11px] text-muted-foreground">{dep.installedVersion ? `v${dep.installedVersion}` : dep.status === "on_demand" ? "Docker image pulled on first session" : `required ${dep.requiredVersion}`}</p><p className="mt-2 text-xs font-semibold">{statusLabel}</p>{dep.details && <p className="mt-1 min-h-10 text-xs leading-relaxed text-muted-foreground">{dep.details}</p>}{!ready && dep.id === "netbird" && <Link to="/netbird" className="mt-3 block w-full rounded-xl bg-primary-soft px-2 py-2 text-center text-xs font-bold text-primary">Open setup guide</Link>}{dep.id === "k3s" && dep.status === "on_demand" && <button disabled={busy} onClick={onInstall} className="mt-3 w-full rounded-xl bg-primary px-2 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50">{busy ? "Downloading image…" : "Download K3s image now"}</button>}{!ready && dep.status !== "configuration_required" && dep.id !== "k3s" && <button disabled={busy} onClick={onInstall} className="mt-2 w-full rounded-xl bg-primary px-2 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50">{busy ? "Working…" : dep.id === "docker" && dep.status === "not_running" ? "Start Docker Desktop" : dep.status === "missing" ? "Install" : "Retry"}</button>}{dep.status === "configuration_required" && <button onClick={onRefresh} className="mt-3 w-full rounded-xl border border-border px-2 py-2 text-xs font-bold">Refresh status</button>}</div>;
}

function RoleCard({ to, icon: Icon, title, subtitle, description }: { to: "/marketplace" | "/provider"; icon: typeof Store; title: string; subtitle: string; description: string }) {
  return <Link to={to}><motion.div whileHover={{ y: -4 }} className={`h-full rounded-3xl border p-6 shadow-soft transition-shadow hover:shadow-lift ${title === "Consumer" ? "border-cyan-100 bg-gradient-to-br from-white to-cyan-50/60" : "border-violet-100 bg-gradient-to-br from-white to-violet-50/60"}`}><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-widest text-primary">{subtitle}</p><h2 className="mt-2 text-2xl font-bold">{title}</h2></div><IconTile icon={Icon} tone={title === "Consumer" ? "cyan" : "violet"} size="lg" /></div><p className="mt-3 max-w-xl text-sm text-muted-foreground">{description}</p><p className="mt-5 inline-flex items-center gap-2 text-sm font-bold text-primary">Open {title} <ArrowRight className="size-4" /></p></motion.div></Link>;
}

function bytes(value: number) { if (!Number.isFinite(value) || value < 0) return "—"; const units = ["B", "KB", "MB", "GB", "TB"]; let n = value, i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; } return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`; }
function percent(part: number, total: number) { return total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0; }
function formatTime(value: string | null) { if (!value) return "just now"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

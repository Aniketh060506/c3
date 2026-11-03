import { createFileRoute, Link } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { useState } from "react";
import { ArrowUpRight, Check, Cpu, HardDrive, MemoryStick, Wifi, X, Download, ShieldCheck, Zap, MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import { Counter, Panel, Pill, Ring, Scramble, Spark } from "@/components/kit";
import { useLiveSeries } from "@/hooks/use-live";
import { dependencies, myHardware, type Dep, type DepStatus } from "@/lib/mock";
import { dependencyService, isTauri } from "@/lib/platform";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview · ComputePool" },
      { name: "description", content: "Your machine's live hardware, environment readiness and role selection." },
      { property: "og:title", content: "ComputePool — share and rent spare compute" },
      { property: "og:description", content: "A peer-to-peer marketplace for CPU, RAM and GPU time." },
    ],
  }),
  component: Overview,
});

const statusMeta: Record<DepStatus, { label: string; tone: "success" | "destructive" | "warning" | "accent" | "primary" }> = {
  installed: { label: "Installed", tone: "success" },
  missing: { label: "Missing", tone: "destructive" },
  outdated: { label: "Outdated", tone: "warning" },
  stopped: { label: "Not running", tone: "accent" },
  config: { label: "Config required", tone: "primary" },
};

function Overview() {
  const cpu = useLiveSeries(38, 14);
  const ram = useLiveSeries(54, 6);
  const gpu = useLiveSeries(22, 18);
  const [deps, setDeps] = useState<Dep[]>(dependencies);
  const [open, setOpen] = useState<Dep | null>(null);
  const cpuNow = cpu[cpu.length - 1].v;
  const ramNow = ram[ram.length - 1].v;
  const gpuNow = gpu[gpu.length - 1].v;
  const ready = deps.filter((d) => d.status === "installed").length;
  const h = myHardware;

  return (
    <div className="mx-auto max-w-7xl">
      {/* Hero */}
      <section className="relative mb-6 overflow-hidden rounded-[2rem] border border-border bg-card bg-hero p-8 shadow-soft">
        <div className="dot-grid absolute inset-0 opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
        <div className="relative grid items-center gap-8 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <div className="mb-4 flex flex-wrap gap-2">
              <Pill tone="success" pulse>Machine online</Pill>
              <Pill tone={isTauri() ? "primary" : "accent"}>{isTauri() ? "Live telemetry" : "Simulated telemetry"}</Pill>
            </div>
            <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="text-4xl font-extrabold leading-[1.05] md:text-6xl">
              Your idle computer is<br />
              <span className="relative inline-block text-primary">
                someone's supercomputer.
                <motion.svg viewBox="0 0 300 12" className="absolute -bottom-2 left-0 w-full" initial={{ pathLength: 0 }}>
                  <motion.path d="M2 8 Q 75 2 150 7 T 298 5" fill="none" strokeWidth="4" strokeLinecap="round" className="stroke-accent" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, delay: 0.4 }} />
                </motion.svg>
              </span>
            </motion.h1>
            <p className="mt-5 max-w-lg text-muted-foreground">
              {h.cpu.model} · {h.ram.total} GB RAM · {h.gpu.model}. Rent compute from peers or open your machine to the pool.
            </p>
          </div>
          <MachineOrbit cpu={cpuNow} ram={ramNow} gpu={gpuNow} />
        </div>
      </section>

      {/* Role selection */}
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <RoleCard to="/marketplace" tone="primary" title="Consumer" desc="Discover computers and rent CPU, RAM and GPUs by the hour." cta="Open Consumer Dashboard" icon={MonitorSmartphone} />
        <RoleCard to="/provider" tone="accent" title="Provider" desc="Share unused hardware on your terms and earn credits." cta="Open Provider Dashboard" icon={Zap} />
      </div>

      {/* Hardware */}
      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel delay={0.05}>
          <HwHead icon={Cpu} label="CPU" value={<Counter value={cpuNow} suffix="%" />} />
          <p className="mt-1 text-sm font-semibold">{h.cpu.model}</p>
          <p className="text-xs text-muted-foreground">{h.cpu.physical} cores · {h.cpu.logical} threads · {h.cpu.ghz} GHz</p>
          <div className="mt-3"><Spark data={cpu} /></div>
        </Panel>
        <Panel delay={0.1}>
          <HwHead icon={MemoryStick} label="Memory" value={<Counter value={ramNow} suffix="%" />} />
          <p className="mt-1 text-sm font-semibold">{((h.ram.total * ramNow) / 100).toFixed(1)} / {h.ram.total} GB</p>
          <p className="text-xs text-muted-foreground">{(h.ram.total - (h.ram.total * ramNow) / 100).toFixed(1)} GB available</p>
          <div className="mt-3"><Spark data={ram} tone="accent" /></div>
        </Panel>
        <Panel delay={0.15}>
          <HwHead icon={Zap} label="GPU" value={<Counter value={gpuNow} suffix="%" />} />
          <p className="mt-1 text-sm font-semibold">{h.gpu.model}</p>
          <p className="text-xs text-muted-foreground">{h.gpu.vram} GB VRAM · driver {h.gpu.driver}</p>
          <div className="mt-3"><Spark data={gpu} tone="success" /></div>
        </Panel>
        <Panel delay={0.2} className="flex flex-col gap-3">
          <HwHead icon={Wifi} label="Network" value={<Pill tone="success">Connected</Pill>} />
          <Row k="Interface" v={h.net.iface} />
          <Row k="NetBird" v={<Pill tone="accent">{h.net.netbird}</Pill>} />
          <Row k="Peer IP" v={<Scramble text={h.net.peerIp} className="text-sm font-semibold" />} />
          <div className="mt-auto">
            <div className="mb-1 flex justify-between text-xs"><span className="flex items-center gap-1 text-muted-foreground"><HardDrive className="size-3" />Storage</span><span className="font-semibold">{h.storage.free} GB free</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <motion.div className="h-full rounded-full bg-primary" initial={{ width: 0 }} animate={{ width: `${(1 - h.storage.free / h.storage.total) * 100}%` }} transition={{ duration: 1 }} />
            </div>
          </div>
        </Panel>
      </div>

      {/* Environment readiness */}
      <Panel delay={0.25}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">Environment readiness</h2>
            <p className="text-sm text-muted-foreground">Nothing installs without your click.</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {deps.map((d) => (
                <motion.span key={d.id} layout className={d.status === "installed" ? "h-6 w-2 rounded-full bg-success" : "h-6 w-2 rounded-full bg-muted"} />
              ))}
            </div>
            <span className="font-display text-2xl font-bold">{ready}<span className="text-muted-foreground">/{deps.length}</span></span>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {deps.map((d, i) => {
            const m = statusMeta[d.status];
            return (
              <motion.button
                key={d.id}
                layout
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + i * 0.03 }}
                whileHover={{ y: -3 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => setOpen(d)}
                className="rounded-2xl border border-border bg-background p-4 text-left transition-colors hover:border-primary"
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="grid size-9 place-items-center rounded-xl bg-muted font-mono text-xs font-bold">{d.name.slice(0, 2)}</div>
                  {d.status === "installed" ? <Check className="size-4 text-success" /> : <ArrowUpRight className="size-4 text-muted-foreground" />}
                </div>
                <p className="text-sm font-bold">{d.name}</p>
                <p className="mb-2 font-mono text-[11px] text-muted-foreground">{d.version ?? "—"}</p>
                <Pill tone={m.tone}>{m.label}</Pill>
              </motion.button>
            );
          })}
        </div>
      </Panel>

      <DepDialog dep={open} onClose={() => setOpen(null)} onInstalled={(id) => {
        setDeps((p) => p.map((d) => (d.id === id ? { ...d, status: "installed", version: d.version ?? d.required.replace(/[^\d.v]/g, "") } : d)));
      }} />
    </div>
  );
}

function MachineOrbit({ cpu, ram, gpu }: { cpu: number; ram: number; gpu: number }) {
  const chips = [
    { label: "CPU", v: cpu, tone: "primary" as const, a: 0 },
    { label: "RAM", v: ram, tone: "accent" as const, a: 120 },
    { label: "GPU", v: gpu, tone: "success" as const, a: 240 },
  ];
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[340px]">
      {[1, 0.72, 0.44].map((s, i) => (
        <motion.div key={i} className="absolute inset-0 m-auto rounded-full border border-dashed border-border" style={{ width: `${s * 100}%`, height: `${s * 100}%` }}
          animate={{ rotate: i % 2 ? -360 : 360 }} transition={{ duration: 40 + i * 12, repeat: Infinity, ease: "linear" }} />
      ))}
      <motion.div className="absolute inset-0" animate={{ rotate: 360 }} transition={{ duration: 36, repeat: Infinity, ease: "linear" }}>
        {chips.map((c) => (
          <div key={c.label} className="absolute left-1/2 top-1/2" style={{ transform: `rotate(${c.a}deg) translateY(-150px) rotate(-${c.a}deg)` }}>
            <motion.div animate={{ rotate: -360 }} transition={{ duration: 36, repeat: Infinity, ease: "linear" }} className="-translate-x-1/2 -translate-y-1/2">
              <div className="rounded-2xl border border-border bg-card p-1.5 shadow-lift">
                <Ring value={c.v} size={64} stroke={7} tone={c.tone}>
                  <div><p className="text-[10px] font-semibold text-muted-foreground">{c.label}</p><p className="text-xs font-bold tabular-nums">{Math.round(c.v)}%</p></div>
                </Ring>
              </div>
            </motion.div>
          </div>
        ))}
      </motion.div>
      <motion.div className="absolute inset-0 m-auto grid size-28 place-items-center rounded-[2rem] bg-ink text-ink-foreground shadow-lift"
        animate={{ scale: [1, 1.04, 1] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}>
        <div className="text-center">
          <Cpu className="mx-auto size-7" />
          <p className="mt-1 font-mono text-[10px] opacity-70">this-machine</p>
        </div>
      </motion.div>
    </div>
  );
}

function RoleCard({ to, title, desc, cta, icon: Icon, tone }: { to: "/marketplace" | "/provider"; title: string; desc: string; cta: string; icon: typeof Cpu; tone: "primary" | "accent" }) {
  return (
    <Link to={to} className="group block">
      <motion.div whileHover="hover" initial="rest" animate="rest" className="relative overflow-hidden rounded-[2rem] border border-border bg-card p-7 shadow-soft transition-shadow hover:shadow-lift">
        <motion.div variants={{ rest: { scale: 0.6, opacity: 0 }, hover: { scale: 1, opacity: 1 } }} transition={{ type: "spring", stiffness: 200, damping: 20 }}
          className={tone === "primary" ? "absolute -right-16 -top-16 size-56 rounded-full bg-primary-soft" : "absolute -right-16 -top-16 size-56 rounded-full bg-accent-soft"} />
        <div className="relative flex items-start justify-between">
          <div className={tone === "primary" ? "grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground" : "grid size-14 place-items-center rounded-2xl bg-accent text-accent-foreground"}>
            <Icon className="size-6" />
          </div>
          <motion.div variants={{ rest: { rotate: 0, x: 0 }, hover: { rotate: 45, x: 4 } }} className="grid size-10 place-items-center rounded-full border border-border bg-background">
            <ArrowUpRight className="size-4" />
          </motion.div>
        </div>
        <h2 className="relative mt-6 text-2xl font-bold">{title}</h2>
        <p className="relative mt-1 max-w-sm text-muted-foreground">{desc}</p>
        <p className={tone === "primary" ? "relative mt-5 text-sm font-bold text-primary" : "relative mt-5 text-sm font-bold text-accent"}>{cta} →</p>
      </motion.div>
    </Link>
  );
}

function HwHead({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Icon className="size-4" />{label}</span>
      <span className="font-display text-xl font-bold">{value}</span>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-center justify-between text-sm"><span className="text-muted-foreground">{k}</span><span className="font-semibold">{v}</span></div>;
}

function DepDialog({ dep, onClose, onInstalled }: { dep: Dep | null; onClose: () => void; onInstalled: (id: string) => void }) {
  const [progress, setProgress] = useState<number | null>(null);
  const run = async () => {
    if (!dep) return;
    setProgress(0);
    await dependencyService.install(dep.id, setProgress);
    onInstalled(dep.id);
    toast.success(`${dep.name} is ready`);
    setProgress(null);
    onClose();
  };
  return (
    <Dialog open={!!dep} onOpenChange={(o) => { if (!o && progress === null) onClose(); }}>
      <DialogContent className="rounded-3xl sm:max-w-lg">
        {dep && (
          <>
            <DialogHeader>
              <DialogTitle className="font-display text-2xl">{dep.name}</DialogTitle>
              <DialogDescription>{dep.what}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="rounded-2xl bg-muted p-4"><p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Why ComputePool needs it</p>{dep.why}</div>
              <div className="grid grid-cols-3 gap-2">
                <Info k="Status" v={statusMeta[dep.status].label} />
                <Info k="Current" v={dep.version ?? "—"} />
                <Info k="Required" v={dep.required} />
              </div>
              <div className="rounded-2xl bg-ink p-4 font-mono text-xs text-ink-foreground">$ {dep.install}</div>
              <AnimatePresence>
                {progress !== null && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                    <div className="mb-1 flex justify-between text-xs"><span>Installing (simulated)…</span><span className="font-mono">{progress}%</span></div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted"><motion.div className="h-full rounded-full bg-primary" animate={{ width: `${progress}%` }} /></div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="rounded-xl" onClick={() => toast(`${dep.name}: ${statusMeta[dep.status].label}`)}><ShieldCheck />Verify</Button>
              {dep.status !== "installed" ? (
                <Button className="rounded-xl" disabled={progress !== null} onClick={run}><Download />{dep.status === "missing" ? "Install" : "Configure"}</Button>
              ) : (
                <Button variant="ghost" className="rounded-xl" onClick={onClose}><X />Close</Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return <div className="rounded-2xl border border-border p-3"><p className="text-[11px] text-muted-foreground">{k}</p><p className="font-semibold">{v}</p></div>;
}

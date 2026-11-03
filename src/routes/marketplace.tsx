import { createFileRoute, Link } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { useMemo, useState } from "react";
import { MessageCircle, Search, Star, Signal, MapPin } from "lucide-react";
import { HueAvatar, PageHeader, Pill, TiltCard } from "@/components/kit";
import { Slider } from "@/components/ui/slider";
import { providers, type Provider } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/marketplace")({
  head: () => ({
    meta: [
      { title: "Marketplace · ComputePool" },
      { name: "description", content: "Browse peer computers with spare CPU, RAM and GPUs to rent." },
      { property: "og:title", content: "Compute Marketplace · ComputePool" },
      { property: "og:description", content: "Find a peer machine that fits your workload." },
    ],
  }),
  component: Marketplace,
});

type Sort = "fit" | "price" | "latency";

function fitScore(p: Provider, need: { cores: number; ram: number; gpu: boolean }) {
  const c = Math.min(1, p.freeCores / Math.max(1, need.cores));
  const r = Math.min(1, p.freeRam / Math.max(1, need.ram));
  const g = need.gpu ? (p.gpu ? 1 : 0) : 1;
  return Math.round(((c + r) / 2) * g * (p.online ? 1 : 0.6) * 100);
}

function Marketplace() {
  const [q, setQ] = useState("");
  const [cores, setCores] = useState(4);
  const [ram, setRam] = useState(16);
  const [gpu, setGpu] = useState(true);
  const [sort, setSort] = useState<Sort>("fit");

  const list = useMemo(() => {
    return providers
      .filter((p) => (p.name + p.cpu + (p.gpu ?? "") + p.location).toLowerCase().includes(q.toLowerCase()))
      .map((p) => ({ p, fit: fitScore(p, { cores, ram, gpu }) }))
      .sort((a, b) => (sort === "fit" ? b.fit - a.fit : sort === "price" ? a.p.rate - b.p.rate : a.p.latency - b.p.latency));
  }, [q, cores, ram, gpu, sort]);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader eyebrow="Consumer · Marketplace" title="Available providers">
        <Pill tone="success" pulse>{providers.filter((p) => p.online).length} online now</Pill>
      </PageHeader>

      {/* Need composer — cards re-rank live as you describe your workload */}
      <div className="mb-6 grid gap-4 rounded-[2rem] border border-border bg-card p-5 shadow-soft lg:grid-cols-[1fr_1fr_1fr_auto]">
        <label className="flex items-center gap-2 rounded-2xl bg-muted px-4 py-3 lg:col-span-4">
          <Search className="size-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, CPU, GPU or city" className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </label>
        <Need label="CPU cores" value={`${cores}`} unit="cores"><Slider value={[cores]} min={1} max={32} step={1} onValueChange={([v]) => setCores(v)} /></Need>
        <Need label="Memory" value={`${ram}`} unit="GB"><Slider value={[ram]} min={2} max={192} step={2} onValueChange={([v]) => setRam(v)} /></Need>
        <div className="rounded-2xl border border-border p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">GPU</p>
          <div className="relative grid grid-cols-2 rounded-xl bg-muted p-1 text-sm font-semibold">
            {[true, false].map((v) => (
              <button key={String(v)} onClick={() => setGpu(v)} className={cn("relative z-10 rounded-lg py-1.5", gpu === v ? "text-foreground" : "text-muted-foreground")}>
                {gpu === v && <motion.span layoutId="gpu-thumb" className="absolute inset-0 -z-10 rounded-lg bg-card shadow-soft" />}
                {v ? "Required" : "Optional"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col justify-center gap-1 rounded-2xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sort</p>
          <div className="flex gap-1">
            {(["fit", "price", "latency"] as Sort[]).map((s) => (
              <button key={s} onClick={() => setSort(s)} className={cn("rounded-lg px-2.5 py-1 text-xs font-bold capitalize transition-colors", sort === s ? "bg-ink text-ink-foreground" : "bg-muted text-muted-foreground")}>{s}</button>
            ))}
          </div>
        </div>
      </div>

      <motion.div layout className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence>
          {list.map(({ p, fit }) => (
            <motion.div key={p.id} layout initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ type: "spring", stiffness: 260, damping: 26 }}>
              <ProviderCard p={p} fit={fit} />
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
      {list.length === 0 && <p className="py-20 text-center text-muted-foreground">No providers match “{q}”.</p>}
    </div>
  );
}

function Need({ label, value, unit, children }: { label: string; value: string; unit: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="font-display text-xl font-bold tabular-nums">{value}<span className="ml-1 text-xs text-muted-foreground">{unit}</span></p>
      </div>
      {children}
    </div>
  );
}

function ProviderCard({ p, fit }: { p: Provider; fit: number }) {
  return (
    <TiltCard className="p-5">
      <div className="flex items-start gap-3">
        <HueAvatar hue={p.hue} label={p.name} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold">{p.name}</p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="size-3" />{p.location} · @{p.handle}</p>
        </div>
        {p.online ? <Pill tone="success" pulse>Online</Pill> : <Pill>Offline</Pill>}
      </div>

      {/* Fit meter */}
      <div className="mt-4 rounded-2xl bg-muted p-3">
        <div className="mb-1.5 flex justify-between text-xs"><span className="font-semibold">Workload fit</span><span className="font-mono font-bold">{fit}%</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-card">
          <motion.div className={cn("h-full rounded-full", fit > 80 ? "bg-success" : fit > 50 ? "bg-warning" : "bg-destructive")} animate={{ width: `${fit}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Spec k="CPU" v={`${p.freeCores}/${p.cores}`} sub="cores free" />
        <Spec k="RAM" v={`${p.freeRam}`} sub={`of ${p.ram} GB`} />
        <Spec k="GPU" v={p.gpu ? `${p.vram}G` : "—"} sub={p.gpu ?? "CPU only"} />
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Star className="size-3.5 fill-warning text-warning" />{p.rating}</span>
        <span className="flex items-center gap-1"><Signal className="size-3.5" />{p.latency} ms</span>
        <span>{p.uptime}% uptime</span>
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
        <div className="mr-auto"><span className="font-display text-2xl font-bold">{p.rate.toFixed(2)}</span><span className="text-xs text-muted-foreground"> cr/hr</span></div>
        <Link to="/chat" className="grid size-10 place-items-center rounded-xl border border-border bg-background hover:border-primary" aria-label="Chat"><MessageCircle className="size-4" /></Link>
        <Link to="/providers/$id" params={{ id: p.id }} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground transition-transform hover:scale-[1.03]">Select</Link>
      </div>
    </TiltCard>
  );
}

function Spec({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-border p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{k}</p>
      <p className="font-display text-lg font-bold">{v}</p>
      <p className="truncate text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

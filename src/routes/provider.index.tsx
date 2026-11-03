import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { useState } from "react";
import { Bar, BarChart, ResponsiveContainer, XAxis, Tooltip } from "recharts";
import { Power } from "lucide-react";
import { Counter, PageHeader, Panel, Pill, Ring, Spark } from "@/components/kit";
import { Slider } from "@/components/ui/slider";
import { useLiveSeries } from "@/hooks/use-live";
import { earnings, myHardware } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/provider/")({
  head: () => ({
    meta: [
      { title: "Provider dashboard · ComputePool" },
      { name: "description", content: "Control what you share, watch usage and track your earnings." },
      { property: "og:title", content: "Provider dashboard · ComputePool" },
      { property: "og:description", content: "Share spare hardware and earn credits." },
    ],
  }),
  component: ProviderDash,
});

function ProviderDash() {
  const [sharing, setSharing] = useState(false);
  const [cpu, setCpu] = useState(6);
  const [ram, setRam] = useState(12);
  const [gpuPct, setGpuPct] = useState(70);
  const usage = useLiveSeries(sharing ? 46 : 8, 12);
  const h = myHardware;
  const total = earnings.reduce((a, e) => a + e.v, 0);
  const potential = (cpu * 0.08 + ram * 0.02 + (gpuPct / 100) * 0.9).toFixed(2);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader eyebrow="Provider" title="Share your machine" />

      {/* Big sharing switch */}
      <motion.div layout className={cn("mb-5 flex flex-wrap items-center gap-6 rounded-[2rem] border p-6 shadow-soft transition-colors", sharing ? "border-success bg-success-soft" : "border-border bg-card")}>
        <button onClick={() => setSharing((s) => !s)} aria-label="Toggle sharing"
          className={cn("relative h-16 w-32 rounded-full p-1.5 transition-colors", sharing ? "bg-success" : "bg-muted")}>
          <motion.span layout transition={{ type: "spring", stiffness: 500, damping: 30 }}
            className={cn("grid size-13 place-items-center rounded-full bg-card shadow-lift", sharing ? "ml-auto" : "")}>
            <Power className={cn("size-5", sharing ? "text-success" : "text-muted-foreground")} />
          </motion.span>
        </button>
        <div className="flex-1">
          <AnimatePresence mode="wait">
            <motion.div key={String(sharing)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <h2 className="text-2xl font-bold">{sharing ? "You're live on the pool" : "Sharing is paused"}</h2>
              <p className="text-sm text-muted-foreground">{sharing ? `Offering ${cpu} cores, ${ram} GB RAM and ${gpuPct}% of your GPU.` : "Set your limits, then flip the switch."}</p>
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="text-right"><p className="text-xs text-muted-foreground">Potential</p><p className="font-display text-3xl font-bold">{potential}<span className="text-sm text-muted-foreground"> cr/hr</span></p></div>
      </motion.div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="lg:col-span-1">
          <h2 className="mb-1 text-lg font-bold">Resource limits</h2>
          <p className="mb-5 text-sm text-muted-foreground">Your PC keeps the rest.</p>
          <Limit label="CPU cores" v={cpu} max={h.cpu.logical} set={setCpu} unit={`/ ${h.cpu.logical}`} />
          <Limit label="RAM" v={ram} max={h.ram.total} set={setRam} unit={`/ ${h.ram.total} GB`} />
          <Limit label="GPU share" v={gpuPct} max={100} set={setGpuPct} unit="%" />
          {/* Split bar visual */}
          <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-muted">
            <motion.div className="bg-primary" animate={{ width: `${(cpu / h.cpu.logical) * 100}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">Blue is shared, grey stays with you.</p>
        </Panel>

        <Panel delay={0.05}>
          <h2 className="mb-4 text-lg font-bold">Live usage</h2>
          <div className="flex items-center justify-around">
            <Ring value={usage[usage.length - 1]!.v} size={110} stroke={11}><div><p className="text-xs text-muted-foreground">CPU</p><p className="font-display text-xl font-bold">{Math.round(usage[usage.length - 1]!.v)}%</p></div></Ring>
            <Ring value={sharing ? 61 : 4} size={110} stroke={11} tone="accent"><div><p className="text-xs text-muted-foreground">GPU</p><p className="font-display text-xl font-bold">{sharing ? 61 : 4}%</p></div></Ring>
          </div>
          <div className="mt-4"><Spark data={usage} /></div>
          <div className="mt-3 flex justify-between text-sm"><span className="text-muted-foreground">Active sessions</span><Pill tone={sharing ? "success" : "muted"} pulse={sharing}>{sharing ? "1 · nora.ml" : "None"}</Pill></div>
        </Panel>

        <Panel delay={0.1}>
          <div className="flex items-end justify-between">
            <div><h2 className="text-lg font-bold">Earnings</h2><p className="text-sm text-muted-foreground">This week</p></div>
            <p className="font-display text-3xl font-bold"><Counter value={total} decimals={2} /><span className="text-sm text-muted-foreground"> cr</span></p>
          </div>
          <div className="mt-4 h-44">
            <ResponsiveContainer>
              <BarChart data={earnings}>
                <XAxis dataKey="d" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
                <Tooltip cursor={{ fill: "var(--muted)", radius: 12 }} contentStyle={{ borderRadius: 14, border: "1px solid var(--border)" }} />
                <Bar dataKey="v" radius={[10, 10, 10, 10]} fill="var(--accent)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Limit({ label, v, max, set, unit }: { label: string; v: number; max: number; set: (n: number) => void; unit: string }) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex justify-between text-sm"><span className="font-semibold">{label}</span><span className="font-mono font-bold">{v} <span className="text-muted-foreground">{unit}</span></span></div>
      <Slider value={[v]} min={0} max={max} step={1} onValueChange={([x]) => set(x ?? 0)} />
    </div>
  );
}

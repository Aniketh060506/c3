import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { useState } from "react";
import { ArrowLeft, Check, Clock, FolderUp, Loader2, Send } from "lucide-react";
import { HueAvatar, Panel, Pill } from "@/components/kit";
import { Slider } from "@/components/ui/slider";
import { providers } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/providers/$id")({
  loader: ({ params }) => {
    const p = providers.find((x) => x.id === params.id);
    if (!p) throw notFound();
    return p;
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData ? `${loaderData.name} · ComputePool` : "Provider · ComputePool" },
      { name: "description", content: loaderData ? `${loaderData.cpu}, ${loaderData.ram} GB RAM, ${loaderData.gpu ?? "no GPU"}.` : "Provider details." },
      { property: "og:title", content: loaderData?.name ?? "Provider" },
      { property: "og:description", content: "Configure and request compute from this provider." },
    ],
  }),
  component: ProviderDetail,
});

const steps = ["Request sent", "Waiting for acceptance", "Accepted"] as const;

function ProviderDetail() {
  const p = Route.useLoaderData();
  const [cpu, setCpu] = useState(Math.min(4, p.freeCores));
  const [ram, setRam] = useState(Math.min(8, p.freeRam));
  const [gpus, setGpus] = useState(p.gpu ? 1 : 0);
  const [hours, setHours] = useState(3);
  const [stage, setStage] = useState(-1);
  const price = (p.rate * hours * (0.5 + cpu / p.cores / 2 + gpus * 0.3)).toFixed(2);

  const send = () => {
    setStage(0);
    setTimeout(() => setStage(1), 900);
    setTimeout(() => setStage(2), 2600);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <Link to="/marketplace" className="mb-5 inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Marketplace</Link>
      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          <Panel className="bg-hero">
            <div className="flex items-center gap-4">
              <motion.div layoutId={`av-${p.id}`}><HueAvatar hue={p.hue} label={p.name} size={64} /></motion.div>
              <div>
                <h1 className="text-3xl font-bold">{p.name}</h1>
                <p className="text-sm text-muted-foreground">@{p.handle} · {p.location} · online {p.onlineHours}h this month</p>
              </div>
            </div>
            <p className="mt-4 text-muted-foreground">{p.bio}</p>
            <div className="mt-4 flex flex-wrap gap-2">{p.tags.map((t) => <Pill key={t} tone="primary">{t}</Pill>)}</div>
          </Panel>
          <Panel delay={0.05}>
            <h2 className="mb-4 text-lg font-bold">Hardware</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Bar label="CPU" spec={p.cpu} free={p.freeCores} total={p.cores} unit="cores" />
              <Bar label="Memory" spec="DDR5" free={p.freeRam} total={p.ram} unit="GB" />
              <Bar label="GPU" spec={p.gpu ?? "None"} free={p.gpu ? p.vram : 0} total={p.vram || 1} unit="GB VRAM" />
              <div className="rounded-2xl border border-border p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Reliability · 30 days</p>
                <div className="mt-3 flex h-10 items-end gap-0.5">
                  {Array.from({ length: 30 }, (_, i) => {
                    const h = 60 + ((i * 37 + p.hue) % 40);
                    return <motion.span key={i} initial={{ height: 0 }} animate={{ height: `${h}%` }} transition={{ delay: i * 0.015 }} className={cn("flex-1 rounded-sm", h < 70 ? "bg-warning" : "bg-success")} />;
                  })}
                </div>
                <p className="mt-2 text-sm font-semibold">{p.uptime}% uptime · {p.latency} ms</p>
              </div>
            </div>
          </Panel>
        </div>

        <Panel delay={0.1} className="h-fit lg:sticky lg:top-24">
          <h2 className="text-lg font-bold">Build your request</h2>
          <p className="mb-5 text-sm text-muted-foreground">Asking {p.rate.toFixed(2)} cr/hr. Final price is negotiated in chat.</p>
          <div className="space-y-5">
            <Knob label="CPU cores" v={cpu} max={p.freeCores} set={setCpu} />
            <Knob label="RAM (GB)" v={ram} max={p.freeRam} set={setRam} />
            {p.gpu && <Knob label="GPUs" v={gpus} max={1} min={0} set={setGpus} />}
            <Knob label="Hours" v={hours} max={24} set={setHours} />
          </div>
          <div className="my-5 flex items-end justify-between rounded-2xl bg-ink p-4 text-ink-foreground">
            <div><p className="text-xs opacity-70">Estimated total</p><motion.p key={price} initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="font-display text-3xl font-bold">{price}<span className="text-sm opacity-70"> cr</span></motion.p></div>
            <Clock className="size-5 opacity-60" />
          </div>

          <AnimatePresence mode="wait">
            {stage < 0 ? (
              <motion.button key="send" exit={{ opacity: 0, scale: 0.95 }} whileTap={{ scale: 0.97 }} onClick={send} disabled={!p.online}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 font-bold text-primary-foreground disabled:opacity-50">
                <Send className="size-4" />{p.online ? "Send request" : "Provider offline"}
              </motion.button>
            ) : (
              <motion.div key="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
                {steps.map((s, i) => (
                  <div key={s} className="flex items-center gap-3">
                    <motion.div animate={{ scale: stage === i ? [1, 1.15, 1] : 1 }} transition={{ repeat: stage === i && i < 2 ? Infinity : 0, duration: 1 }}
                      className={cn("grid size-8 place-items-center rounded-full", stage > i || (stage === 2 && i === 2) ? "bg-success text-primary-foreground" : stage === i ? "bg-primary-soft text-primary" : "bg-muted text-muted-foreground")}>
                      {stage > i || (stage === 2 && i === 2) ? <Check className="size-4" /> : stage === i ? <Loader2 className="size-4 animate-spin" /> : i + 1}
                    </motion.div>
                    <span className={cn("text-sm font-semibold", stage < i && "text-muted-foreground")}>{s}</span>
                  </div>
                ))}
                {stage === 2 && (
                  <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 gap-2 pt-2">
                    <Link to="/cluster" className="rounded-2xl bg-primary py-3 text-center text-sm font-bold text-primary-foreground">Open cluster</Link>
                    <Link to="/chat" className="flex items-center justify-center gap-1.5 rounded-2xl border border-border py-3 text-sm font-bold"><FolderUp className="size-4" />Send files</Link>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </Panel>
      </div>
    </div>
  );
}

function Knob({ label, v, max, min = 1, set }: { label: string; v: number; max: number; min?: number; set: (n: number) => void }) {
  return (
    <div>
      <div className="mb-2 flex justify-between text-sm"><span className="font-semibold">{label}</span><span className="font-mono font-bold">{v}<span className="text-muted-foreground">/{max}</span></span></div>
      <Slider value={[v]} min={min} max={max} step={1} onValueChange={([x]) => set(x)} />
    </div>
  );
}

function Bar({ label, spec, free, total, unit }: { label: string; spec: string; free: number; total: number; unit: string }) {
  return (
    <div className="rounded-2xl border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold">{spec}</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><motion.div className="h-full rounded-full bg-primary" initial={{ width: 0 }} animate={{ width: `${(free / total) * 100}%` }} transition={{ duration: 0.9 }} /></div>
      <p className="mt-1.5 text-xs text-muted-foreground">{free} {unit} available</p>
    </div>
  );
}

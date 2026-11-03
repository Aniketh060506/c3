import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence, useMotionValue, useTransform, type PanInfo } from "motion/react";
import { useState } from "react";
import { Check, Star, X } from "lucide-react";
import { toast } from "sonner";
import { HueAvatar, PageHeader } from "@/components/kit";
import { incomingRequests } from "@/lib/mock";

export const Route = createFileRoute("/provider/requests")({
  head: () => ({
    meta: [
      { title: "Incoming requests · ComputePool" },
      { name: "description", content: "Swipe to accept or decline compute requests for your machine." },
      { property: "og:title", content: "Incoming requests · ComputePool" },
      { property: "og:description", content: "Review who wants to use your hardware." },
    ],
  }),
  component: Requests,
});

type Req = (typeof incomingRequests)[number];

function Requests() {
  const [stack, setStack] = useState(incomingRequests);
  const [log, setLog] = useState<{ r: Req; ok: boolean }[]>([]);
  const decide = (r: Req, ok: boolean) => {
    setStack((s) => s.filter((x) => x.id !== r.id));
    setLog((l) => [{ r, ok }, ...l]);
    toast[ok ? "success" : "message"](ok ? `Accepted ${r.who} — session starting` : `Declined ${r.who}`);
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader eyebrow="Provider · Inbox" title="Incoming requests" />
      <div className="grid gap-8 md:grid-cols-[1fr_280px]">
        <div className="relative mx-auto h-[440px] w-full max-w-md">
          <AnimatePresence>
            {stack.map((r, i) => (
              <SwipeCard key={r.id} r={r} depth={stack.length - 1 - i} top={i === stack.length - 1} onDecide={decide} />
            ))}
          </AnimatePresence>
          {stack.length === 0 && (
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="grid h-full place-items-center rounded-[2rem] border-2 border-dashed border-border text-center">
              <div><p className="font-display text-2xl font-bold">Inbox zero</p><p className="text-sm text-muted-foreground">New requests will land here.</p></div>
            </motion.div>
          )}
        </div>
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Drag right to accept, left to decline</p>
          <div className="space-y-2">
            {log.map(({ r, ok }) => (
              <motion.div key={r.id} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3">
                <span className={ok ? "grid size-7 place-items-center rounded-full bg-success-soft text-success" : "grid size-7 place-items-center rounded-full bg-destructive-soft text-destructive"}>{ok ? <Check className="size-4" /> : <X className="size-4" />}</span>
                <div><p className="text-sm font-bold">{r.who}</p><p className="text-xs text-muted-foreground">{r.offer.toFixed(2)} cr · {r.hours}h</p></div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SwipeCard({ r, depth, top, onDecide }: { r: Req; depth: number; top: boolean; onDecide: (r: Req, ok: boolean) => void }) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-14, 14]);
  const yes = useTransform(x, [20, 120], [0, 1]);
  const no = useTransform(x, [-120, -20], [1, 0]);
  const end = (_: unknown, info: PanInfo) => {
    if (info.offset.x > 120) onDecide(r, true);
    else if (info.offset.x < -120) onDecide(r, false);
  };
  return (
    <motion.div
      drag={top ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.9}
      onDragEnd={end}
      style={{ x, rotate, zIndex: 10 - depth }}
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1 - depth * 0.05, y: depth * 16, opacity: 1 }}
      exit={{ x: x.get() >= 0 ? 400 : -400, opacity: 0, rotate: x.get() >= 0 ? 20 : -20, transition: { duration: 0.3 } }}
      className="absolute inset-0 cursor-grab touch-none rounded-[2rem] border border-border bg-card p-6 shadow-lift active:cursor-grabbing"
    >
      <motion.div style={{ opacity: yes }} className="absolute left-6 top-6 rounded-xl border-2 border-success px-3 py-1 font-display text-lg font-bold text-success">ACCEPT</motion.div>
      <motion.div style={{ opacity: no }} className="absolute right-6 top-6 rounded-xl border-2 border-destructive px-3 py-1 font-display text-lg font-bold text-destructive">DECLINE</motion.div>
      <div className="mt-12 flex items-center gap-3">
        <HueAvatar hue={(r.who.length * 47) % 360} label={r.who} size={56} />
        <div><p className="font-display text-2xl font-bold">{r.who}</p><p className="flex items-center gap-1 text-sm text-muted-foreground"><Star className="size-3.5 fill-warning text-warning" />{r.trust} · {r.workload}</p></div>
      </div>
      <div className="mt-6 grid grid-cols-4 gap-2 text-center">
        {[["CPU", r.cpu], ["RAM", `${r.ram}G`], ["GPU", r.gpu], ["Hours", r.hours]].map(([k, v]) => (
          <div key={k} className="rounded-2xl bg-muted p-3"><p className="font-display text-xl font-bold">{v}</p><p className="text-[10px] text-muted-foreground">{k}</p></div>
        ))}
      </div>
      <div className="mt-6 flex items-end justify-between rounded-2xl bg-ink p-4 text-ink-foreground">
        <div><p className="text-xs opacity-70">Offer</p><p className="font-display text-3xl font-bold">{r.offer.toFixed(2)} cr</p></div>
        <p className="text-xs opacity-70">{(r.offer / r.hours).toFixed(2)} cr/hr</p>
      </div>
      {top && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => onDecide(r, false)} className="flex items-center justify-center gap-1.5 rounded-2xl bg-destructive-soft py-3 text-sm font-bold text-destructive"><X className="size-4" />Decline</button>
          <button onClick={() => onDecide(r, true)} className="flex items-center justify-center gap-1.5 rounded-2xl bg-success py-3 text-sm font-bold text-primary-foreground"><Check className="size-4" />Accept</button>
        </div>
      )}
    </motion.div>
  );
}

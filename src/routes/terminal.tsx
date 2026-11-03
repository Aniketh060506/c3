import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Plus, RotateCw, X } from "lucide-react";
import { PageHeader } from "@/components/kit";
import { cn } from "@/lib/utils";
import { nodes, pods } from "@/lib/mock";

export const Route = createFileRoute("/terminal")({
  head: () => ({
    meta: [
      { title: "Terminal · ComputePool" },
      { name: "description", content: "Open shells into your control plane, nodes and pods." },
      { property: "og:title", content: "Terminal · ComputePool" },
      { property: "og:description", content: "Multi-tab shells across your rented cluster." },
    ],
  }),
  component: TerminalPage,
});

type Line = { kind: "in" | "out" | "ok" | "err"; text: string };
type Tab = { id: number; target: string; lines: Line[] };

function respond(cmd: string): Line[] {
  const c = cmd.trim();
  if (c === "help") return [{ kind: "out", text: "try: kubectl get nodes · kubectl get pods -A · nvidia-smi · clear" }];
  if (c === "kubectl get nodes") return [{ kind: "out", text: "NAME                STATUS     ROLES           AGE" }, ...nodes.map((n) => ({ kind: (n.status === "Ready" ? "ok" : "err") as Line["kind"], text: `${n.name.padEnd(20)}${n.status.padEnd(11)}${(n.role === "Worker" ? "<none>" : "control-plane").padEnd(16)}1h` }))];
  if (c.startsWith("kubectl get pods")) return [{ kind: "out", text: "NAMESPACE  NAME                STATUS" }, ...pods.map((p) => ({ kind: (p.status === "Pending" ? "err" : "out") as Line["kind"], text: `${p.ns.padEnd(11)}${p.name.padEnd(20)}${p.status}` }))];
  if (c === "nvidia-smi") return [{ kind: "ok", text: "NVIDIA RTX 4090 | 24564MiB | 78% util | 64°C | CUDA 12.4" }];
  if (!c) return [];
  return [{ kind: "err", text: `${c.split(" ")[0]}: command not found (simulated shell)` }];
}

function TerminalPage() {
  const targets = ["control-plane", ...nodes.filter((n) => n.id !== "cp").map((n) => n.name), "pod/trainer-7f9c-0"];
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, target: "control-plane", lines: [{ kind: "ok", text: "Connected to control-plane via NetBird 100.84.12.7" }, { kind: "out", text: "Type 'help' to get started." }] }]);
  const [active, setActive] = useState(1);
  const [input, setInput] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const scroll = useRef<HTMLDivElement>(null);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];

  useEffect(() => { scroll.current?.scrollTo({ top: 1e6, behavior: "smooth" }); }, [tab?.lines.length]);

  const run = () => {
    const cmd = input;
    setHist((h) => [cmd, ...h]); setHIdx(-1); setInput("");
    setTabs((ts) => ts.map((t) => (t.id !== active ? t : cmd.trim() === "clear" ? { ...t, lines: [] } : { ...t, lines: [...t.lines, { kind: "in", text: cmd }, ...respond(cmd)] })));
  };

  const open = (target: string) => {
    const id = Date.now();
    setTabs((ts) => [...ts, { id, target, lines: [{ kind: "ok", text: `Connected to ${target}` }] }]);
    setActive(id);
  };

  if (!tab) return null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Consumer · Shell" title="Terminal" />
      <div className="mb-4 flex flex-wrap gap-2">
        {targets.map((t, i) => (
          <motion.button key={t} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} whileHover={{ y: -2 }} onClick={() => open(t)}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 font-mono text-xs font-semibold shadow-soft hover:border-primary">
            <Plus className="size-3" />{t}
          </motion.button>
        ))}
      </div>
      <div className="overflow-hidden rounded-[2rem] bg-ink text-ink-foreground shadow-lift">
        <div className="flex items-center gap-1 overflow-x-auto border-b border-ink-foreground/10 px-3 pt-3">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setActive(t.id)} className={cn("relative flex items-center gap-2 rounded-t-xl px-4 py-2 font-mono text-xs", active === t.id ? "text-ink-foreground" : "text-ink-foreground/50")}>
              {active === t.id && <motion.span layoutId="term-tab" className="absolute inset-0 rounded-t-xl bg-ink-foreground/10" />}
              <span className="relative size-1.5 rounded-full bg-success" />
              <span className="relative">{t.target}</span>
              {tabs.length > 1 && <X className="relative size-3 opacity-60 hover:opacity-100" onClick={(e) => { e.stopPropagation(); setTabs((ts) => ts.filter((x) => x.id !== t.id)); if (active === t.id) setActive(tabs[0]!.id === t.id ? tabs[1]!.id : tabs[0]!.id); }} />}
            </button>
          ))}
          <button className="ml-auto mb-2 flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-foreground/60 hover:text-ink-foreground" onClick={() => setTabs((ts) => ts.map((t) => (t.id === active ? { ...t, lines: [...t.lines, { kind: "ok", text: "Reconnected." }] } : t)))}><RotateCw className="size-3" />Reconnect</button>
        </div>
        <div ref={scroll} onClick={() => document.getElementById("term-in")?.focus()} className="h-[460px] overflow-y-auto p-5 font-mono text-[13px] leading-relaxed">
          <AnimatePresence initial={false}>
            {tab.lines.map((l, i) => (
              <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.15, delay: l.kind === "in" ? 0 : 0.02 * (i % 10) }}
                className={cn("whitespace-pre", l.kind === "ok" && "text-success", l.kind === "err" && "text-warning", l.kind === "in" && "text-ink-foreground")}>
                {l.kind === "in" ? <><span className="text-accent">{tab.target}</span><span className="opacity-50"> $ </span>{l.text}</> : <span className={l.kind === "out" ? "opacity-70" : ""}>{l.text}</span>}
              </motion.div>
            ))}
          </AnimatePresence>
          <div className="flex items-center">
            <span className="text-accent">{tab.target}</span><span className="opacity-50">&nbsp;$&nbsp;</span>
            <input id="term-in" autoFocus value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") run();
                if (e.key === "ArrowUp" && hist.length) { const n = Math.min(hist.length - 1, hIdx + 1); setHIdx(n); setInput(hist[n] ?? ""); }
                if (e.key === "ArrowDown") { const n = Math.max(-1, hIdx - 1); setHIdx(n); setInput(n < 0 ? "" : (hist[n] ?? "")); }
              }}
              className="flex-1 bg-transparent caret-accent outline-none" aria-label="Terminal input" />
          </div>
        </div>
      </div>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { useState } from "react";
import { Power, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Counter, HueAvatar, PageHeader, Panel, Pill, Ring, Spark } from "@/components/kit";
import { useLiveSeries, useTicker } from "@/hooks/use-live";
import { nodes, pods } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/cluster")({
  head: () => ({
    meta: [
      { title: "Cluster · ComputePool" },
      { name: "description", content: "Live view of your rented compute cluster, nodes and pods." },
      { property: "og:title", content: "Cluster dashboard · ComputePool" },
      { property: "og:description", content: "Nodes, pods and resource usage across providers." },
    ],
  }),
  component: Cluster,
});

function Cluster() {
  const cpu = useLiveSeries(62, 10);
  const gpu = useLiveSeries(78, 8);
  const t = useTicker();
  const [sel, setSel] = useState(nodes[1].id);
  const node = nodes.find((n) => n.id === sel)!;
  const mins = 72 + Math.floor(t / 60);
  const totalCpu = nodes.reduce((a, n) => a + n.cpu, 0);
  const totalRam = nodes.reduce((a, n) => a + n.ram, 0);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader eyebrow="Session · cp-cluster-7a1" title="Cluster dashboard">
        <div className="flex items-center gap-2">
          <Pill tone="success" pulse>Healthy</Pill>
          <Pill>K3s v1.30.2</Pill>
          <Pill tone="primary">{Math.floor(mins / 60)}h {String(mins % 60).padStart(2, "0")}m {String(t % 60).padStart(2, "0")}s</Pill>
          <button onClick={() => toast("Session will end after workloads drain")} className="flex items-center gap-1.5 rounded-xl bg-destructive-soft px-3 py-2 text-xs font-bold text-destructive"><Power className="size-3.5" />End session</button>
        </div>
      </PageHeader>

      <div className="mb-5 grid gap-4 md:grid-cols-4">
        <Panel><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">CPU</p><p className="font-display text-3xl font-bold"><Counter value={totalCpu} /> <span className="text-sm text-muted-foreground">cores</span></p><Spark data={cpu} /></Panel>
        <Panel delay={0.05}><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Memory</p><p className="font-display text-3xl font-bold"><Counter value={totalRam} /> <span className="text-sm text-muted-foreground">GB</span></p><Spark data={cpu.map((d) => ({ ...d, v: d.v * 0.7 }))} tone="accent" /></Panel>
        <Panel delay={0.1}><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">GPU</p><p className="font-display text-3xl font-bold">3 <span className="text-sm text-muted-foreground">devices</span></p><Spark data={gpu} tone="success" /></Panel>
        <Panel delay={0.15} className="flex items-center justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pods</p><p className="font-display text-3xl font-bold">{pods.filter((p) => p.status === "Running").length}<span className="text-sm text-muted-foreground">/{pods.length}</span></p><p className="text-xs text-muted-foreground">2 jobs running</p></div>
          <Ring value={gpu[gpu.length - 1].v} tone="success"><span className="text-xs font-bold">VRAM</span></Ring>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Panel delay={0.2}>
          <h2 className="mb-1 text-lg font-bold">Topology</h2>
          <p className="mb-4 text-sm text-muted-foreground">Tap a node. Dots are live packets over the private mesh.</p>
          <Topology sel={sel} onSel={setSel} />
        </Panel>
        <Panel delay={0.25}>
          <div className="flex items-center gap-3">
            <HueAvatar hue={node.hue} label={node.name} />
            <div className="flex-1"><p className="font-mono text-sm font-bold">{node.name}</p><p className="text-xs text-muted-foreground">{node.role} · {node.provider}</p></div>
            <Pill tone={node.status === "Ready" ? "success" : "warning"}>{node.status}</Pill>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            {[["CPU", `${node.cpu}c`], ["RAM", `${node.ram}G`], ["GPU", node.gpu ?? "—"]].map(([k, v]) => (
              <div key={k} className="rounded-2xl bg-muted p-3"><p className="text-[10px] text-muted-foreground">{k}</p><p className="truncate text-sm font-bold">{v}</p></div>
            ))}
          </div>
          <p className="mt-5 mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pods on this node</p>
          <div className="space-y-2">
            {pods.filter((p) => p.node === node.name).map((p) => (
              <div key={p.name} className="flex items-center gap-3 rounded-2xl border border-border p-3">
                <span className={cn("size-2 rounded-full", p.status === "Running" ? "bg-success" : p.status === "Pending" ? "bg-warning" : "bg-muted-foreground")} />
                <div className="flex-1"><p className="font-mono text-xs font-semibold">{p.name}</p><p className="text-[10px] text-muted-foreground">{p.ns} · {p.age}</p></div>
                <span className="font-mono text-xs">{p.cpu}%</span>
              </div>
            ))}
            {pods.filter((p) => p.node === node.name).length === 0 && <p className="text-sm text-muted-foreground">No workloads scheduled.</p>}
          </div>
          <Link to="/terminal" className="mt-4 flex items-center justify-center gap-2 rounded-2xl bg-ink py-3 text-sm font-bold text-ink-foreground"><Terminal className="size-4" />Open terminal</Link>
        </Panel>
      </div>
    </div>
  );
}

const pos: Record<string, [number, number]> = { cp: [50, 50], alpha: [16, 20], beta: [84, 24], gamma: [52, 88] };

function Topology({ sel, onSel }: { sel: string; onSel: (id: string) => void }) {
  return (
    <div className="dot-grid relative aspect-[16/10] w-full rounded-3xl bg-muted">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full">
        {nodes.filter((n) => n.id !== "cp").map((n, i) => {
          const [x, y] = pos[n.id];
          const d = `M50 50 L${x} ${y}`;
          return (
            <g key={n.id}>
              <motion.path d={d} className={n.status === "Ready" ? "stroke-primary" : "stroke-warning"} strokeWidth="0.5" strokeDasharray="1.5 1.5" fill="none" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, delay: i * 0.15 }} vectorEffect="non-scaling-stroke" />
              {n.status === "Ready" && (
                <motion.circle r="1" className="fill-accent" animate={{ cx: [50, x, 50], cy: [50, y, 50] }} transition={{ duration: 2.4 + i * 0.5, repeat: Infinity, ease: "easeInOut" }} />
              )}
            </g>
          );
        })}
      </svg>
      {nodes.map((n) => {
        const [x, y] = pos[n.id];
        return (
          <motion.button key={n.id} onClick={() => onSel(n.id)} whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.95 }}
            className={cn("absolute -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 bg-card px-3 py-2 text-left shadow-soft transition-colors", sel === n.id ? "border-primary shadow-lift" : "border-transparent")}
            style={{ left: `${x}%`, top: `${y}%` }}>
            <p className="font-mono text-[11px] font-bold">{n.name}</p>
            <p className="text-[10px] text-muted-foreground">{n.role}{n.gpu ? ` · ${n.gpu}` : ""}</p>
          </motion.button>
        );
      })}
    </div>
  );
}

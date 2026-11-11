import { Link } from "@tanstack/react-router";
import { Boxes, Gauge, LayoutDashboard, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

type SessionTool = "overview" | "pods" | "distributed" | "benchmark";

export function SessionToolsTabs({ clusterId, active }: { clusterId: string; active: SessionTool }) {
  const tabs: { id: SessionTool; label: string; icon: typeof Terminal }[] = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "pods", label: "Pods", icon: Terminal },
    { id: "distributed", label: "Distributed", icon: Boxes },
    { id: "benchmark", label: "Benchmark", icon: Gauge },
  ];

  return <nav aria-label="Session tools" className="mb-5 flex w-fit max-w-full flex-wrap gap-1 rounded-2xl border border-border bg-card p-1.5 shadow-sm">
    {tabs.map(({ id, label, icon: Icon }) => {
      const current = active === id;
      const className = cn("inline-flex min-h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors", current ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground");
      return id === "overview"
        ? <Link key={id} to="/cluster" search={{ clusterId }} aria-current={current ? "page" : undefined} className={className}><Icon className="size-4" />{label}</Link>
        : id === "pods"
        ? <Link key={id} to="/terminal" search={{ clusterId }} aria-current={current ? "page" : undefined} className={className}><Icon className="size-4" />{label}</Link>
        : <Link key={id} to="/batch-jobs" search={{ clusterId, view: id }} aria-current={current ? "page" : undefined} className={className}><Icon className="size-4" />{label}</Link>;
    })}
  </nav>;
}

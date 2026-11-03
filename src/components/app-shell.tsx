import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { motion, AnimatePresence, LayoutGroup } from "motion/react";
import {
  Bell, Boxes, Cpu, LayoutGrid, MessageCircle, Network, Search, Store, Terminal, Inbox, Gauge, Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const consumerNav = [
  { to: "/marketplace", label: "Marketplace", icon: Store },
  { to: "/chat", label: "Chat", icon: MessageCircle, badge: 3 },
  { to: "/cluster", label: "Cluster", icon: Network },
  { to: "/terminal", label: "Terminal", icon: Terminal },
] as const;

const providerNav = [
  { to: "/provider", label: "Dashboard", icon: Gauge },
  { to: "/provider/requests", label: "Requests", icon: Inbox, badge: 3 },
  { to: "/chat", label: "Chat", icon: MessageCircle },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const mode: "consumer" | "provider" = path.startsWith("/provider") ? "provider" : "consumer";
  const nav = mode === "consumer" ? consumerNav : providerNav;

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-sidebar p-4 md:flex">
        <Link to="/" className="mb-6 flex items-center gap-2.5 px-2">
          <motion.div
            className="grid size-9 place-items-center rounded-xl bg-ink text-ink-foreground"
            whileHover={{ rotate: 90 }}
            transition={{ type: "spring", stiffness: 300, damping: 14 }}
          >
            <Boxes className="size-5" />
          </motion.div>
          <div>
            <p className="font-display text-lg font-bold leading-none">ComputePool</p>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">v0.9.2 · preview</p>
          </div>
        </Link>

        {/* Mode switch with a sliding thumb */}
        <div className="relative mb-6 grid grid-cols-2 rounded-2xl bg-muted p-1 text-sm font-semibold">
          {(["consumer", "provider"] as const).map((m) => (
            <button
              key={m}
              onClick={() => navigate({ to: m === "consumer" ? "/marketplace" : "/provider" })}
              className={cn("relative z-10 rounded-xl py-2 capitalize transition-colors", mode === m ? "text-foreground" : "text-muted-foreground")}
            >
              {mode === m && (
                <motion.span layoutId="mode-thumb" className="absolute inset-0 -z-10 rounded-xl bg-card shadow-soft" transition={{ type: "spring", stiffness: 400, damping: 32 }} />
              )}
              {m}
            </button>
          ))}
        </div>

        <LayoutGroup>
          <nav className="flex flex-col gap-1">
            <NavItem to="/" label="Overview" icon={LayoutGrid} active={path === "/"} />
            <AnimatePresence mode="popLayout">
              <motion.div
                key={mode}
                initial={{ opacity: 0, x: mode === "consumer" ? -16 : 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: mode === "consumer" ? 16 : -16 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="flex flex-col gap-1"
              >
                <p className="mt-4 mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{mode}</p>
                {nav.map((n) => (
                  <NavItem key={n.to} to={n.to} label={n.label} icon={n.icon} badge={"badge" in n ? n.badge : undefined} active={path === n.to} />
                ))}
              </motion.div>
            </AnimatePresence>
          </nav>
        </LayoutGroup>

        <div className="mt-auto rounded-2xl bg-ink p-4 text-ink-foreground">
          <p className="text-xs opacity-70">Network credits</p>
          <p className="font-display text-2xl font-bold">248.60</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-foreground/15">
            <motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: "62%" }} transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }} />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-background/80 px-6 py-3 backdrop-blur-xl">
          <div className="flex flex-1 items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-soft md:max-w-md">
            <Search className="size-4" />
            <span>Search providers, nodes, pods…</span>
            <kbd className="ml-auto rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px]">Ctrl K</kbd>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button className="relative grid size-10 place-items-center rounded-2xl border border-border bg-card shadow-soft" aria-label="Notifications">
              <Bell className="size-4" />
              <span className="absolute right-2.5 top-2.5 size-2 rounded-full bg-accent" />
            </button>
            <button className="grid size-10 place-items-center rounded-2xl border border-border bg-card shadow-soft" aria-label="Settings">
              <Settings className="size-4" />
            </button>
            <div className="grid size-10 place-items-center rounded-2xl bg-primary font-display text-sm font-bold text-primary-foreground">RS</div>
          </div>
        </header>
        <AnimatePresence mode="wait">
          <motion.main
            key={path}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="flex-1 px-6 py-8 lg:px-10"
          >
            {children}
          </motion.main>
        </AnimatePresence>
      </div>
    </div>
  );
}

function NavItem({ to, label, icon: Icon, active, badge }: { to: string; label: string; icon: typeof Cpu; active: boolean; badge?: number | undefined }) {
  return (
    <Link to={to} className={cn("relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors", active ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
      {active && <motion.span layoutId="nav-pill" className="absolute inset-0 -z-0 rounded-xl bg-primary-soft" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
      <Icon className="relative size-4" />
      <span className="relative">{label}</span>
      {badge ? <span className="relative ml-auto rounded-full bg-accent px-1.5 text-[10px] font-bold text-accent-foreground">{badge}</span> : null}
    </Link>
  );
}


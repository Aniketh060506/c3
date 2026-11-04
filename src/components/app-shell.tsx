import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Boxes, Gauge, LayoutGrid, MessageCircle, Network, Store, Inbox, Cpu } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SignOutButton } from "@/components/auth-gate";

const consumerNav = [
  { to: "/marketplace", label: "Find providers", icon: Store },
  { to: "/chat", label: "Negotiation", icon: MessageCircle },
  { to: "/cluster", label: "Session dashboard", icon: Network },
] as const;
const providerNav = [
  { to: "/provider", label: "Share this laptop", icon: Gauge },
  { to: "/provider/requests", label: "Requests & chat", icon: Inbox },
  { to: "/provider/chat", label: "Conversations", icon: MessageCircle },
] as const;

export function AppShell({ children, username, signOut }: { children: ReactNode; username: string; signOut: () => Promise<void> }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const mode: "consumer" | "provider" = path.startsWith("/provider") ? "provider" : "consumer";
  const nav = mode === "consumer" ? consumerNav : providerNav;

  return <div className="flex min-h-screen bg-background">
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-sidebar p-4 md:flex">
      <Link to="/" className="mb-7 flex items-center gap-2.5 px-2"><span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Boxes className="size-5" /></span><span><span className="block font-display text-lg font-bold leading-none">ComputePool</span><span className="mt-1 block font-mono text-[10px] text-muted-foreground">Windows desktop</span></span></Link>
      <div className="mb-6 rounded-2xl bg-muted p-1"><div className="relative grid grid-cols-2 text-sm font-semibold">{(["consumer", "provider"] as const).map((m) => <button key={m} onClick={() => navigate({ to: m === "consumer" ? "/marketplace" : "/provider" })} className={cn("relative z-10 rounded-xl py-2.5 capitalize transition-colors", mode === m ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>{mode === m && <motion.span layoutId="mode-thumb" className="absolute inset-0 -z-10 rounded-xl bg-card shadow-soft" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}{m}</button>)}</div></div>
      <nav className="flex flex-col gap-1"><NavItem to="/" label="Machine readiness" icon={LayoutGrid} active={path === "/"} /><NavItem to="/netbird" label="NetBird setup" icon={Network} active={path === "/netbird"} /><LayoutGroup><AnimatePresence mode="wait"><motion.div key={mode} initial={{ opacity: 0, x: mode === "consumer" ? -12 : 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: mode === "consumer" ? 12 : -12 }} transition={{ duration: 0.18 }} className="flex flex-col gap-1"><p className="mb-1 mt-5 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{mode} path</p>{nav.map((item) => <NavItem key={item.to} to={item.to} label={item.label} icon={item.icon} active={path === item.to || (item.to === "/cluster" && path === "/terminal")} />)}</motion.div></AnimatePresence></LayoutGroup></nav>
      <div className="mt-auto rounded-2xl border border-border bg-background p-4"><p className="flex items-center gap-2 text-xs font-semibold"><Cpu className="size-4 text-primary" />Local machine first</p><p className="mt-2 text-xs leading-relaxed text-muted-foreground">Hardware and dependency status are read from this laptop. Provider data appears only when connected to the live service.</p></div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-background/85 px-5 py-3 backdrop-blur-xl md:px-8"><Link to="/" className="flex items-center gap-2 font-semibold md:hidden"><Boxes className="size-5 text-primary" />ComputePool</Link><div className="hidden items-center gap-2 text-xs text-muted-foreground md:flex"><span className="size-2 rounded-full bg-primary" />{mode === "consumer" ? "Consumer workflow" : "Provider workflow"}</div><div className="flex items-center gap-1 rounded-full border border-border bg-card p-1 text-xs font-semibold md:hidden">{(["consumer", "provider"] as const).map((m) => <button key={m} onClick={() => navigate({ to: m === "consumer" ? "/marketplace" : "/provider" })} className={cn("rounded-full px-3 py-1.5 capitalize", mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>{m}</button>)}</div><SignOutButton username={username} onSignOut={signOut} /></header>
      <AnimatePresence mode="wait"><motion.main key={path} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.2 }} className="flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</motion.main></AnimatePresence>
    </div>
  </div>;
}

function NavItem({ to, label, icon: Icon, active }: { to: string; label: string; icon: typeof Cpu; active: boolean }) {
  return <Link to={to} className={cn("relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors", active ? "text-primary" : "text-muted-foreground hover:text-foreground")}>{active && <motion.span layoutId="nav-pill" className="absolute inset-0 -z-0 rounded-xl bg-primary-soft" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}<Icon className="relative size-4" /><span className="relative">{label}</span></Link>;
}

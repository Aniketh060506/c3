import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Gauge, LayoutGrid, MessageCircle, Network, Store, Inbox, Cpu, History, Power, LoaderCircle, Moon, Sun } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/brand-logo";
import { SignOutButton } from "@/components/auth-gate";
import { IconTile } from "@/components/kit";
import { nativeActivity, providerService, type ProviderStatus } from "@/lib/platform";

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
  const [providerPresence, setProviderPresence] = useState<ProviderStatus | null>(null);
  const [darkMode, setDarkMode] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("computepool.theme") === "dark");
  const pendingNativeCalls = useSyncExternalStore(nativeActivity.subscribe, nativeActivity.count, () => 0);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    document.documentElement.style.colorScheme = darkMode ? "dark" : "light";
    window.localStorage.setItem("computepool.theme", darkMode ? "dark" : "light");
  }, [darkMode]);
  useEffect(() => {
    let active = true;
    const heartbeat = async () => { try { const status = await providerService.status(); if (active) setProviderPresence(status); } catch { /* Keep the last confirmed presence through brief network/API failures. */ } };
    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), 15000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const mode: "consumer" | "provider" = path.startsWith("/provider") ? "provider" : "consumer";
  const nav = mode === "consumer" ? consumerNav : providerNav;

  const sharedNav = [
    { to: "/" as const, label: "Machine readiness", icon: LayoutGrid, active: path === "/" },
    { to: "/netbird" as const, label: "NetBird setup", icon: Network, active: path === "/netbird" },
    { to: "/history" as const, label: "Account history", icon: History, active: path === "/history" },
  ];
  return <div className="flex h-screen min-h-0 w-screen overflow-hidden bg-slate-50/70">
    <aside className="z-30 flex w-[248px] shrink-0 flex-col border-r border-slate-200/80 bg-white px-4 py-5 shadow-[8px_0_30px_-28px_rgba(15,23,42,0.3)] max-lg:w-[220px] max-md:w-[190px] max-sm:w-[72px] max-sm:px-2">
      <Link to="/" className="mb-7 flex items-center gap-2.5 px-2 font-semibold text-slate-950 max-sm:justify-center max-sm:px-0"><BrandLogo className="size-10 shrink-0 rounded-xl object-cover" /><span className="max-sm:hidden">ComputePool</span></Link>
      <div className="mb-6 rounded-[20px] bg-slate-100/90 p-1.5 max-sm:p-1">{(["consumer", "provider"] as const).map((m) => <button key={m} onClick={() => navigate({ to: m === "consumer" ? "/marketplace" : "/provider" })} aria-pressed={mode === m} className={cn("mb-1 flex w-full items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm font-semibold capitalize transition-all last:mb-0 max-sm:justify-center max-sm:px-0", mode === m ? m === "consumer" ? "bg-gradient-to-r from-blue-600 to-cyan-500 text-white shadow-md shadow-blue-200" : "bg-gradient-to-r from-violet-600 to-fuchsia-500 text-white shadow-md shadow-violet-200" : "text-slate-600 hover:bg-white hover:text-slate-950")}>{m === "consumer" ? <Store className="size-4" /> : <Gauge className="size-4" />}<span className="max-sm:hidden">{m}</span></button>)}</div>
      <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400 max-sm:hidden">{mode} workspace</div>
      <nav aria-label="Main navigation" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto [scrollbar-width:none]">
        {nav.map((item) => <RailItem key={item.to} to={item.to} label={item.label} icon={item.icon} active={path === item.to || (item.to === "/cluster" && path === "/terminal")} mode={mode} />)}
        <div className="my-4 border-t border-slate-200/80" />
        <div className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400 max-sm:hidden">Workspace</div>
        {sharedNav.map((item) => <RailItem key={item.to} to={item.to} label={item.label} icon={item.icon} active={item.active} mode={mode} />)}
      </nav>
      <div className="mt-4 rounded-2xl border border-border bg-card p-3 max-sm:hidden"><div className="flex items-center gap-2 text-xs font-semibold text-foreground"><span className="grid size-7 place-items-center rounded-xl bg-secondary text-secondary-foreground"><Cpu className="size-3.5" /></span>Local machine first</div><p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">Hardware and dependency status are read from this laptop.</p></div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200/80 bg-white/90 px-5 py-3 backdrop-blur-xl md:px-8"><div className="flex items-center gap-2 text-xs font-medium text-slate-500"><span className={cn("size-2 rounded-full", mode === "consumer" ? "bg-primary" : "bg-accent")} />{mode === "consumer" ? "Consumer workflow" : "Provider workflow"}</div><div className="flex items-center gap-2">{pendingNativeCalls > 0 && <div role="status" aria-live="polite" title={nativeActivity.label()} className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-800"><LoaderCircle className="size-3.5 animate-spin" /><span className="hidden sm:inline">{nativeActivity.label() || "Working"}</span></div>}{providerPresence?.online && <Link to="/provider" className="hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800 sm:inline-flex"><IconTile icon={Power} tone="green" size="sm" />Provider online · {providerPresence.activeSessions} active</Link>}<button type="button" onClick={() => setDarkMode((current) => !current)} aria-label={`Switch to ${darkMode ? "light" : "dark"} mode`} aria-pressed={darkMode} title={`Switch to ${darkMode ? "light" : "dark"} mode`} className="inline-flex size-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 transition-colors hover:border-cyan-500 hover:text-cyan-700"><span className="sr-only">{darkMode ? "Light mode" : "Dark mode"}</span>{darkMode ? <Sun className="size-4" /> : <Moon className="size-4" />}</button><SignOutButton username={username} onSignOut={signOut} /></div></header>
      <AnimatePresence mode="wait"><motion.main key={path} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.2 }} className="min-h-0 w-full flex-1 overflow-y-auto px-4 pb-6 pt-6 sm:px-6 lg:px-8 lg:pt-7">{children}</motion.main></AnimatePresence>
    </div>
  </div>;
}

function RailItem({ to, label, icon: Icon, active, mode }: { to: string; label: string; icon: typeof Cpu; active: boolean; mode: "consumer" | "provider" }) {
  const navigate = useNavigate();
  const activeColor = mode === "consumer" ? "bg-blue-50 text-blue-800 ring-blue-100" : "bg-violet-50 text-violet-800 ring-violet-100";
  const tileColor = label.includes("Find") ? "bg-cyan-100 text-cyan-700" : label.includes("Negotiation") || label.includes("Conversation") ? "bg-violet-100 text-violet-700" : label.includes("Session") || label.includes("Request") ? "bg-blue-100 text-blue-700" : label.includes("Machine") ? "bg-emerald-100 text-emerald-700" : label.includes("NetBird") ? "bg-orange-100 text-orange-700" : "bg-amber-100 text-amber-700";
  const openFreshNegotiation = to === "/chat" ? (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    try {
      window.sessionStorage.removeItem("computepool-provider-id");
      window.sessionStorage.removeItem("computepool-negotiation-id");
      window.sessionStorage.removeItem("computepool-active-session");
    } catch { /* The route still starts fresh if storage is unavailable. */ }
    void navigate({ to: "/chat", search: { providerId: "", providerIds: "", negotiationId: "", newChat: true } });
  } : undefined;
  return <Link to={to} onClick={openFreshNegotiation} title={label} aria-current={active ? "page" : undefined} className={cn("group flex min-w-0 items-center gap-3 rounded-2xl px-2.5 py-2.5 text-xs font-semibold ring-1 ring-transparent transition-all max-sm:justify-center max-sm:px-0", active ? activeColor : "text-slate-600 hover:bg-slate-50 hover:text-slate-950") }><span className={cn("grid size-8 shrink-0 place-items-center rounded-xl shadow-sm ring-1 ring-white transition-transform group-hover:scale-105", tileColor, active && (mode === "consumer" ? "bg-gradient-to-br from-blue-600 to-cyan-500 text-white" : "bg-gradient-to-br from-violet-600 to-fuchsia-500 text-white"))}><Icon className="size-4" /></span><span className="truncate max-sm:hidden">{label}</span></Link>;
}

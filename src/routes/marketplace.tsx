import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Cpu, MemoryStick, RefreshCw, Search, Wifi, Zap, Laptop } from "lucide-react";
import { PageHeader, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { marketplaceService, type ProviderNode } from "@/lib/platform";

export const Route = createFileRoute("/marketplace")({ head: () => ({ meta: [{ title: "Find providers · ComputePool" }] }), component: Marketplace });
function Marketplace() {
  const [providers, setProviders] = useState<ProviderNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlineOnly, setOnlineOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const refresh = async () => { setLoading(true); setError(null); try { setProviders(await marketplaceService.list()); } catch (e) { setProviders(null); setError(e instanceof Error ? e.message : "NetBird provider discovery unavailable."); } finally { setLoading(false); } };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 10000); return () => window.clearInterval(timer); }, []);
  const visible = useMemo(() => (providers ?? []).filter((p) => (!onlineOnly || p.online) && `${p.displayName} ${p.id} ${p.netbirdIp ?? ""}`.toLowerCase().includes(query.toLowerCase())), [providers, query, onlineOnly]);
  return <div className="mx-auto max-w-7xl"><PageHeader eyebrow="Consumer · live provider directory" title="Find providers"><Button variant="outline" className="rounded-xl" onClick={() => void refresh()} disabled={loading}><RefreshCw className="mr-2 size-4" />Refresh providers</Button></PageHeader>
    <Panel className="mb-5"><p className="text-sm text-muted-foreground">Availability, capacity and negotiation are read from the live ComputePool AWS service. Providers heartbeat from their own desktop; NetBird access is created only after an accepted session starts.</p><div className="mt-4 flex flex-wrap gap-3"><label className="flex min-w-56 flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3"><Search className="size-4 text-muted-foreground" /><input className="h-11 w-full bg-transparent text-sm outline-none" placeholder="Search ComputePool providers" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label className="flex items-center gap-2 rounded-xl border border-border px-3 text-sm"><input type="checkbox" checked={onlineOnly} onChange={(e) => setOnlineOnly(e.target.checked)} />Online only</label></div></Panel>
    {error && <Panel className="mb-4 border-warning/40 text-sm text-muted-foreground">{error}</Panel>}
    {providers === null ? <Empty title="Provider directory unavailable" detail="The Cognito-authenticated AWS marketplace API is not responding. Refresh, and check that this desktop build has the deployed API URL configured." /> : visible.length === 0 ? <Empty title="No ComputePool providers online" detail="Providers appear here after signing in, setting capacity limits and turning on sharing in the Provider view." /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map((p) => <Panel key={p.id}><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-bold">{p.displayName}</h2><p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><span className={`size-2 rounded-full ${p.online ? "bg-success" : "bg-muted-foreground"}`} />{p.online ? "Available" : "Unavailable"}</p></div><Laptop className="size-4 text-muted-foreground" /></div><div className="my-4 grid grid-cols-2 gap-2"><Spec icon={Cpu} label="Available CPU" value={`${p.availableCores ?? "—"} cores`} /><Spec icon={MemoryStick} label="Available RAM" value={p.availableMemoryBytes === undefined ? "—" : formatBytes(p.availableMemoryBytes)} /></div><div className="rounded-xl bg-muted p-3"><p className="flex items-center gap-2 text-xs font-semibold"><Zap className="size-4" />GPU capacity</p><p className="mt-1 text-sm text-muted-foreground">{p.gpuNames.length ? p.gpuNames.join(", ") : "CPU workloads"}</p></div>{p.cpuModel && <p className="mt-2 text-xs text-muted-foreground">{p.cpuModel}</p>}<Link to="/providers/$id" params={{ id: p.id }} className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">View provider</Link></Panel>)}</div>}
  </div>;
}
function Spec({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string }) { return <div className="rounded-xl border border-border p-3"><p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Icon className="size-3.5" />{label}</p><p className="mt-1 text-sm font-semibold">{value}</p></div>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <Panel className="py-12 text-center"><h2 className="text-xl font-bold">{title}</h2><p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">{detail}</p></Panel>; }
function formatBytes(n: number) { return `${(n / 1024 ** 3).toFixed(1)} GB`; }

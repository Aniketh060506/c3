import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Clock3, Cpu, History, MessageCircle, RefreshCw, Server } from "lucide-react";
import { IconTile, LoadingPanel, PageHeader, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { negotiationService, type Negotiation } from "@/lib/platform";

export const Route = createFileRoute("/history")({ head: () => ({ meta: [{ title: "Account history · ComputePool" }] }), component: AccountHistory });

function AccountHistory() {
  const [items, setItems] = useState<Negotiation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => { setError(null); try { setItems(await negotiationService.list()); } catch (e) { setError(e instanceof Error ? e.message : "Account history could not be loaded."); } };
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => window.clearInterval(timer); }, []);
  const sorted = [...(items ?? [])].sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""));
  return <div className="w-full min-w-0"><PageHeader eyebrow="Consumer + provider · account history" title="Your compute history"><Button variant="outline" className="rounded-xl" onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Refresh history</Button></PageHeader>
    <Panel className="mb-5"><div className="flex items-center gap-3"><IconTile icon={History} tone="violet" size="md" /><div><h2 className="font-bold">Every request from this account</h2><p className="mt-1 text-sm text-muted-foreground">Consumer requests and provider requests, including open, accepted, rejected, and ended sessions.</p></div></div></Panel>
    {error && <Panel className="mb-4 border-warning/40 text-sm text-muted-foreground">{error}</Panel>}
    {items === null && !error ? <LoadingPanel label="Loading your account history" /> : items === null ? <Panel className="py-12 text-center"><IconTile icon={Clock3} tone="cyan" size="lg" className="mx-auto" /><h2 className="mt-4 font-semibold">Account history unavailable</h2><p className="mt-2 text-sm text-muted-foreground">Refresh after the negotiation service is available.</p><Button variant="outline" className="mt-4 rounded-xl" onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Retry</Button></Panel> : sorted.length === 0 ? <Panel className="py-12 text-center"><IconTile icon={History} tone="blue" size="lg" className="mx-auto" /><h2 className="mt-4 text-lg font-bold">No compute history yet</h2><p className="mt-2 text-sm text-muted-foreground">Requests you send as a consumer or receive as a provider will appear here.</p></Panel> : <div className="grid gap-4 xl:grid-cols-2">{sorted.map((item) => {
      const providerSide = item.myRole === "provider";
      const otherParty = providerSide ? item.consumerName ?? item.consumer ?? "Consumer" : item.providerName ?? item.providerId;
      const cpu = item.requestedLimits?.cpuCores;
      const ram = item.requestedLimits?.memoryBytes;
      const href = providerSide ? "/provider/chat" as const : "/chat" as const;
      const peerId = item.consumer ?? item.consumerSub ?? item.consumerName ?? "";
      return <Panel key={item.id} className="p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><IconTile icon={providerSide ? Server : Cpu} tone={providerSide ? "green" : "blue"} size="md" /><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">{providerSide ? "Provider request" : "Consumer request"}</p><h2 className="mt-1 truncate font-bold">{otherParty}</h2><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{item.id}</p></div></div><span className={`rounded-full px-3 py-1.5 text-xs font-bold capitalize ${item.state === "accepted" ? "bg-success-soft text-success" : item.state === "open" ? "bg-primary-soft text-primary" : item.state === "rejected" ? "bg-destructive-soft text-destructive" : "bg-muted text-muted-foreground"}`}>{item.state}</span></div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="CPU" value={cpu === undefined ? "—" : `${cpu} cores`} /><Metric label="RAM" value={ram === undefined ? "—" : `${(ram / 1024 ** 3).toFixed(1)} GB`} /><Metric label="Duration" value={item.durationMinutes === undefined ? "—" : `${item.durationMinutes} min`} /><Metric label="Updated" value={dateLabel(item.updatedAt ?? item.createdAt)} /></div>
        {item.workloadDescription && <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{item.workloadDescription}</p>}
        <Link to={href} search={providerSide ? { peerId, negotiationId: item.id } : { providerId: item.providerId, negotiationId: item.id }} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-semibold transition hover:-translate-y-0.5 hover:shadow-soft"><MessageCircle className="size-4 text-violet-600" />Open conversation</Link>
      </Panel>;
    })}</div>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-xl border border-border bg-white p-2.5"><p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 truncate text-xs font-semibold" title={value}>{value}</p></div>; }
function dateLabel(value?: string) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleDateString(); }

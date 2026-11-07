import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Clock3, MessageCircle, RefreshCw, Send } from "lucide-react";
import { CardHeading, IconTile, PageHeader, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { negotiationService, type NegotiationMessage } from "@/lib/platform";

export const Route = createFileRoute("/provider/chat")({ validateSearch: (search: Record<string, unknown>) => ({ peerId: typeof search["peerId"] === "string" ? search["peerId"] : "", negotiationId: typeof search["negotiationId"] === "string" ? search["negotiationId"] : "" }), head: () => ({ meta: [{ title: "Provider chat · ComputePool" }] }), component: ProviderChat });
function ProviderChat() {
  const { peerId, negotiationId } = Route.useSearch();
  const [conversations, setConversations] = useState<Awaited<ReturnType<typeof negotiationService.list>>>([]);
  const [messages, setMessages] = useState<NegotiationMessage[] | null>(null);
  const [body, setBody] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      const rows = await negotiationService.list();
      const accountRows = rows.filter((n) => n.myRole === "provider").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setConversations(accountRows);
      const match = (negotiationId ? accountRows.find((n) => n.id === negotiationId) : undefined)
        ?? (peerId ? accountRows.find((n) => n.consumer === peerId || n.consumerSub === peerId) : undefined)
        ?? accountRows[0];
      if (!match) { setConversationId(null); setMessages([]); return; }
      setConversationId(match.id);
      setBody("");
      setMessages(await negotiationService.messagesById(match.id));
    } catch (e) { setMessages(null); setError(e instanceof Error ? e.message : "Provider chat unavailable."); }
  };
  useEffect(() => { void load(); }, [peerId, negotiationId]);
  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    let reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try { const latest = await negotiationService.messagesById(conversationId); if (active) setMessages(latest); }
      catch { /* Keep the last messages visible during brief network interruptions. */ }
      finally { reading = false; }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversationId]);
  const send = async () => { if (!body.trim() || !conversationId) return; try { const sent = await negotiationService.sendMessageById(conversationId, body.trim()); setMessages((current) => [...(current ?? []).filter((m) => m.id !== sent.id), sent].sort((a, b) => a.createdAt.localeCompare(b.createdAt))); setBody(""); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "Message was not sent."); } };
  const selected = conversations.find((item) => item.id === conversationId);
  return <div className="mx-auto max-w-7xl"><PageHeader eyebrow="Provider · consumer conversation" title="Chat"><Button variant="outline" className="rounded-xl" onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Refresh</Button></PageHeader>
    {error && <Panel className="mb-4 border-warning/40 text-sm text-muted-foreground">{error}</Panel>}
    {conversations.length === 0 ? <Panel className="py-10 text-center"><IconTile icon={MessageCircle} tone="violet" size="lg" className="mx-auto" /><h2 className="mt-4 font-bold">No conversations on this account yet</h2><p className="mt-2 text-sm text-muted-foreground">Incoming and past consumer chats stay here after the request is accepted, rejected, or ended.</p><Link to="/provider/requests" className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground">View incoming requests</Link></Panel> : <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Panel className="h-fit"><CardHeading icon={Clock3} tone="cyan" title="Chat history" detail={`${conversations.length} conversation${conversations.length === 1 ? "" : "s"} on this account`} /><div className="mt-3 max-h-[min(65vh,700px)] space-y-2 overflow-y-auto">{conversations.map((item) => <Link key={item.id} to="/provider/chat" search={{ peerId: item.consumer ?? item.consumerSub ?? "", negotiationId: item.id }} className={`block rounded-xl border p-3 transition hover:border-primary/40 hover:bg-primary/5 ${item.id === conversationId ? "border-primary bg-primary/5" : "border-border bg-white"}`}><div className="flex items-start justify-between gap-2"><p className="truncate text-sm font-semibold">{item.consumerName ?? item.consumer ?? "Consumer"}</p><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{item.state}</span></div><p className="mt-1 text-[11px] text-muted-foreground">{new Date(item.updatedAt ?? item.createdAt ?? "").toLocaleString()}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{item.id}</p></Link>)}</div></Panel>
      <Panel className="flex min-h-[min(72vh,760px)] flex-col"><CardHeading className="border-b border-border pb-4" icon={MessageCircle} tone="violet" title={selected?.consumerName ?? selected?.consumer ?? peerId ?? "Conversation"} detail={selected ? `${selected.state} · ${selected.id}` : "Private ComputePool negotiation"} />{messages === null ? <p className="py-8 text-center text-sm text-muted-foreground">Loading the complete conversation history…</p> : messages.length === 0 ? <div className="grid min-h-48 flex-1 place-items-center text-center"><div><IconTile icon={MessageCircle} tone="cyan" size="md" className="mx-auto" /><p className="mt-3 text-sm text-muted-foreground">No messages yet. Discuss the request before accepting it.</p></div></div> : <div className="flex-1 space-y-3 overflow-y-auto py-4">{messages.map((m) => <div key={m.id} className={`flex ${m.sender === "provider" ? "justify-end" : "justify-start"}`}><div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${m.sender === "provider" ? "bg-primary text-primary-foreground" : "border border-border bg-background"}`}><p>{m.text}</p>{m.proposal && <div className="mt-2 border-t border-current/15 pt-2 text-xs">Proposal · {m.proposal.cpuCores} CPU · {(m.proposal.memoryBytes / 1024 ** 3).toFixed(1)} GiB RAM · {m.proposal.durationMinutes} min · {m.proposal.state}</div>}<time className="mt-2 block text-[10px] opacity-60">{new Date(m.createdAt).toLocaleString()}</time></div></div>)}</div>}<form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex gap-2 border-t border-border pt-3"><input className="h-11 min-w-0 flex-1 rounded-xl bg-muted px-4 text-sm outline-none" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Discuss the request with the consumer…" /><Button className="rounded-xl" disabled={!body.trim() || !conversationId}><Send className="size-4" /></Button></form></Panel>
    </div>}</div>;
}

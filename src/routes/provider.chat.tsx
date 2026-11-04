import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { MessageCircle, RefreshCw, Send } from "lucide-react";
import { CardHeading, IconTile, PageHeader, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { negotiationService, type NegotiationMessage } from "@/lib/platform";

export const Route = createFileRoute("/provider/chat")({ validateSearch: (search: Record<string, unknown>) => ({ peerId: typeof search["peerId"] === "string" ? search["peerId"] : "" }), head: () => ({ meta: [{ title: "Provider chat · ComputePool" }] }), component: ProviderChat });
function ProviderChat() {
  const { peerId } = Route.useSearch();
  const [messages, setMessages] = useState<NegotiationMessage[] | null>(null);
  const [body, setBody] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (!peerId) return;
    setError(null);
    try {
      const rows = await negotiationService.list();
      const match = rows.filter((n) => n.consumer === peerId || n.consumerSub === peerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!match) throw new Error("No negotiation exists with this consumer yet.");
      setConversationId(match.id);
      setMessages(await negotiationService.messagesById(match.id));
    } catch (e) { setMessages(null); setError(e instanceof Error ? e.message : "Provider chat unavailable."); }
  };
  useEffect(() => { void load(); }, [peerId]);
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
  return <div className="mx-auto max-w-7xl"><PageHeader eyebrow="Provider · consumer conversation" title={peerId ? `Chat with ${peerId}` : "Chat"}><Button variant="outline" className="rounded-xl" disabled={!peerId} onClick={() => void load()}><RefreshCw className="mr-2 size-4" />Refresh</Button></PageHeader>{!peerId ? <Panel className="py-10 text-center"><IconTile icon={MessageCircle} tone="violet" size="lg" className="mx-auto" /><h2 className="mt-4 font-bold">Open a conversation from a request</h2><p className="mt-2 text-sm text-muted-foreground">Select Chat first on an incoming request to discuss workload, duration, and limits.</p></Panel> : <Panel className="flex min-h-[min(72vh,760px)] flex-col"><CardHeading className="border-b border-border pb-4" icon={MessageCircle} tone="violet" title={peerId} detail="Private ComputePool negotiation" />{error && <p className="mb-3 rounded-xl bg-warning-soft p-3 text-sm text-muted-foreground">{error}</p>}<div className="flex-1 space-y-3 overflow-y-auto pb-4">{messages === null ? <p className="py-8 text-center text-sm text-muted-foreground">Waiting for live messages from the provider chat service.</p> : messages.length === 0 ? <div className="grid min-h-48 place-items-center text-center"><div><IconTile icon={MessageCircle} tone="cyan" size="md" className="mx-auto" /><p className="mt-3 text-sm text-muted-foreground">No messages yet. Discuss the request before accepting it.</p></div></div> : messages.map((m) => <div key={m.id} className={`flex ${m.sender === "provider" ? "justify-end" : "justify-start"}`}><div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${m.sender === "provider" ? "bg-primary text-primary-foreground" : "border border-border bg-background"}`}><p>{m.text}</p><time className="mt-2 block text-[10px] opacity-60">{new Date(m.createdAt).toLocaleString()}</time></div></div>)}</div><form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex gap-2 border-t border-border pt-3"><input className="h-11 min-w-0 flex-1 rounded-xl bg-muted px-4 text-sm outline-none" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Discuss the request with the consumer…" /><Button className="rounded-xl" disabled={!body.trim()}><Send className="size-4" /></Button></form></Panel>}</div>;
}

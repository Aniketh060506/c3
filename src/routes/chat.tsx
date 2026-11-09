import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Cpu, FolderOpen, Laptop, LoaderCircle, MemoryStick, RefreshCw, Send, ShieldCheck, Timer } from "lucide-react";
import { LoadingPanel, PageHeader, Panel } from "@/components/kit";
import { IconTile } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { clusterService, fileService, marketplaceService, negotiationService, type Negotiation, type NegotiationMessage, type ProviderNode } from "@/lib/platform";

export const Route = createFileRoute("/chat")({ validateSearch: (search: Record<string, unknown>) => ({ providerId: typeof search["providerId"] === "string" ? search["providerId"] : "", negotiationId: typeof search["negotiationId"] === "string" ? search["negotiationId"] : "" }), head: () => ({ meta: [{ title: "Negotiation · ComputePool" }] }), component: NegotiationChat });
function NegotiationChat() {
  const { providerId, negotiationId } = Route.useSearch();
  const selectedProviderId = providerId || readSessionValue("computepool-provider-id") || "";
  const selectedNegotiationId = negotiationId || (!providerId ? readSessionValue("computepool-negotiation-id") || "" : "");
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ProviderNode | null>(null);
  const [messages, setMessages] = useState<NegotiationMessage[]>([]);
  const [negotiations, setNegotiations] = useState<Negotiation[]>([]);
  const [accountConversations, setAccountConversations] = useState<Negotiation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [cpu, setCpu] = useState(2);
  const [memory, setMemory] = useState(4);
  const [minutes, setMinutes] = useState(60);
  const [folder, setFolder] = useState<string | null>(() => readSessionValue("computepool-project-folder"));
  const [sessionId, setSessionId] = useState<string | null>(() => readSessionValue("computepool-active-session"));
  const [connection, setConnection] = useState<{ status: "connecting" | "ready" | "failed"; stages: { id: string; label: string; status: "pending" | "running" | "completed" | "failed"; detail?: string }[]; error?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const acceptedRequests = negotiations.filter((n) => n.state === "accepted").sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  // A physical provider laptop can only join a K3s cluster once. When older
  // builds allowed repeated proposals, use the latest accepted offer per laptop.
  const acceptedForSession = acceptedRequests.filter((item, index, all) => all.findIndex((candidate) => candidate.providerId === item.providerId) === index);
  const duplicateAcceptedCount = acceptedRequests.length - acceptedForSession.length;
  const accepted = acceptedForSession.length > 0;
  const currentRequest = negotiations.find((item) => item.id === conversationId);
  const currentRequestState = currentRequest?.state;
  const canCreateProposal = !currentRequestState || ["rejected", "expired", "ended"].includes(currentRequestState);
  const load = async () => {
    setInitialLoading(true);
    setError(null);
    const results = await Promise.allSettled([selectedProviderId ? marketplaceService.get(selectedProviderId) : Promise.resolve(null), negotiationService.list()]);
    if (results[0].status === "fulfilled" && results[0].value) setProvider(results[0].value);
    let selectedConversation: Negotiation | undefined;
    if (results[1].status === "fulfilled") {
      const allRows = results[1].value;
      setAccountConversations(allRows.filter((n) => n.myRole === "consumer").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      const matching = allRows.filter((n) => selectedNegotiationId ? n.id === selectedNegotiationId : selectedProviderId ? n.providerId === selectedProviderId : n.myRole === "consumer").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setNegotiations(matching);
      selectedConversation = matching[0];
      setConversationId(selectedConversation?.id ?? null);
      if (selectedConversation) {
        writeSessionValue("computepool-provider-id", selectedConversation.providerId);
        writeSessionValue("computepool-negotiation-id", selectedConversation.id);
      }
      if (selectedConversation) {
        try { setMessages(await negotiationService.messagesById(selectedConversation.id)); }
        catch (e) { setError(e instanceof Error ? e.message : "Conversation messages could not be loaded."); }
      } else setMessages([]);
    }
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") setError(failed.reason instanceof Error ? failed.reason.message : "Negotiation service unavailable.");
    setInitialLoading(false);
  };
  useEffect(() => { void load(); }, [selectedProviderId, selectedNegotiationId]);
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
  useEffect(() => {
    if (!conversationId) return;
    let active = true;
    const pollDecision = async () => {
      try { const latest = await negotiationService.list(); if (active) setNegotiations(latest.filter((n) => selectedNegotiationId ? n.id === selectedNegotiationId : n.providerId === selectedProviderId)); }
      catch { /* Preserve the last known negotiation state when offline. */ }
    };
    const timer = window.setInterval(() => void pollDecision(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversationId, selectedProviderId, selectedNegotiationId]);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen<{ sessionId: string; clusterId: string; status: "connecting" | "ready" | "failed"; stages: { id: string; label: string; status: "pending" | "running" | "completed" | "failed"; detail?: string }[]; error?: string | null }>("computepool-session-progress", ({ payload }) => {
      if (!active) return;
      setSessionId(payload.sessionId);
      writeSessionValue("computepool-active-session", payload.sessionId);
      setConnection(payload);
      if (payload.error) setError(payload.error);
    }).then((dispose) => { if (active) unlisten = dispose; else dispose(); });
    return () => { active = false; unlisten?.(); };
  }, []);
  const send = async () => { if (!text.trim() || !conversationId) return; setBusy(true); setError(null); try { const sent = await negotiationService.sendMessageById(conversationId, text.trim()); setMessages((current) => [...current.filter((m) => m.id !== sent.id), sent].sort((a, b) => a.createdAt.localeCompare(b.createdAt))); setText(""); } catch (e) { setError(e instanceof Error ? e.message : "Message was not sent."); } finally { setBusy(false); } };
  const propose = async () => {
    if (!selectedProviderId || !canCreateProposal) return;
    setBusy(true); setError(null);
    try {
      const created = await negotiationService.sendProposal(selectedProviderId, { cpuCores: cpu, memoryBytes: memory * 1024 ** 3, gpuIds: [], }, minutes);
      writeSessionValue("computepool-provider-id", selectedProviderId);
      writeSessionValue("computepool-negotiation-id", created.id);
      setSessionId(null); writeSessionValue("computepool-active-session", null); setConnection(null);
      await navigate({ to: "/chat", search: { providerId: selectedProviderId, negotiationId: created.id } });
    } catch (e) { setError(e instanceof Error ? e.message : "Proposal could not be sent."); }
    finally { setBusy(false); }
  };
  const closeRequest = async () => {
    if (!conversationId || !currentRequestState || !["open", "accepted"].includes(currentRequestState)) return;
    if (connection?.status === "connecting" || connection?.status === "ready") {
      setError("End the connected cluster session before closing this accepted request.");
      return;
    }
    setBusy(true); setError(null);
    try {
      await negotiationService.closeRequest(conversationId);
      setSessionId(null); writeSessionValue("computepool-active-session", null); setConnection(null);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "The request could not be closed."); }
    finally { setBusy(false); }
  };
  const chooseFolder = async () => { setBusy(true); setError(null); try { const selected = await fileService.chooseProjectFolder(); setFolder(selected); writeSessionValue("computepool-project-folder", selected); } catch (e) { setError(e instanceof Error ? e.message : "Folder picker unavailable."); } finally { setBusy(false); } };
  const startSession = async () => { if (connection?.status === "failed") { setSessionId(null); writeSessionValue("computepool-active-session", null); setConnection(null); } setBusy(true); setError(null); try { const acceptedIds = acceptedForSession.map((n) => n.id); const setup = await clusterService.startSession(acceptedIds, folder!); setSessionId(setup.sessionId); writeSessionValue("computepool-active-session", setup.sessionId); setConnection((current) => current ?? { status: "connecting", stages: [] }); } catch (e) { setError(e instanceof Error ? e.message : "Session did not start."); } finally { setBusy(false); } };

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const poll = async () => {
      try {
        const value = await clusterService.connectionStatus(sessionId);
        if (!active) return;
        setConnection(value);
        if (value.status === "ready") await navigate({ to: "/cluster", search: { clusterId: value.clusterId } });
        if (value.status === "failed") setError(value.error ?? "The provider connection could not be established.");
      } catch (e) { if (active) setError(e instanceof Error ? e.message : "Connection status unavailable."); }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId, navigate]);

  return <div className="w-full min-w-0"><PageHeader eyebrow="Consumer · step 2" title="Chat & agree first"><Button variant="outline" className="rounded-xl" onClick={() => void load()} disabled={busy}><RefreshCw className="mr-2 size-4" />Refresh conversation</Button></PageHeader>
    {accountConversations.length > 0 && <Panel className="mb-4"><div className="mb-3 flex items-center justify-between gap-3"><div><h2 className="font-bold">Your conversation history</h2><p className="mt-1 text-xs text-muted-foreground">Every provider request from this account, including closed conversations.</p></div><span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold">{accountConversations.length} total</span></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{accountConversations.map((item) => <Link key={item.id} to="/chat" search={{ providerId: item.providerId, negotiationId: item.id }} className={`rounded-xl border p-3 transition hover:border-primary/40 hover:bg-primary/5 ${item.id === conversationId ? "border-primary bg-primary/5" : "border-border bg-white"}`}><div className="flex items-start justify-between gap-2"><p className="truncate text-sm font-semibold">{item.providerName ?? item.providerId}</p><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] capitalize text-muted-foreground">{item.state}</span></div><p className="mt-1 text-[11px] text-muted-foreground">{new Date(item.updatedAt ?? item.createdAt ?? "").toLocaleString()}</p><p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{item.id}</p></Link>)}</div></Panel>}
    {initialLoading ? <LoadingPanel label="Loading conversation, account history, and provider status" /> : !selectedProviderId ? <Panel className="py-10 text-center"><IconTile icon={Laptop} tone="blue" size="lg" className="mx-auto" /><h2 className="mt-4 text-xl font-bold">{accountConversations.length ? "Choose a conversation above" : "Choose a provider to begin"}</h2><p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">{accountConversations.length ? "Your prior chats stay available above, with all messages and request details." : "Open a live provider from the marketplace. The terminal appears only after the provider accepts and a session is connected."}</p><Link to="/marketplace" className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground">Find providers</Link></Panel> : <>
      {error && <Panel className="mb-4 border-warning/40 text-sm text-muted-foreground">{error}</Panel>}
      <Panel className="mb-4"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><IconTile icon={Laptop} tone={provider?.online ? "green" : "slate"} size="md" /><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-widest text-primary">Selected provider</p><h2 className="mt-1 truncate text-xl font-bold">{provider?.displayName ?? "Loading live provider…"}</h2></div></div><span className={`rounded-full px-3 py-1.5 text-xs font-bold ${provider?.online ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>{provider ? provider.online ? "Online" : "Offline" : "Status unavailable"}</span></div></Panel>
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel className="flex min-h-[min(72vh,760px)] flex-col"><div className="flex-1 space-y-3 overflow-y-auto pb-4">{messages.length ? messages.map((m) => <div key={m.id} className={`flex ${m.sender === "consumer" ? "justify-end" : "justify-start"}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${m.sender === "consumer" ? "bg-primary text-primary-foreground" : "border border-border bg-background"}`}><p>{m.text}</p>{m.proposal && <div className="mt-3 border-t border-current/15 pt-3 text-xs">Proposal · {m.proposal.cpuCores} CPU · {(m.proposal.memoryBytes / 1024 ** 3).toFixed(1)} GB RAM · {m.proposal.durationMinutes} min · {m.proposal.priceAmount} {m.proposal.currency}<p className="mt-1 font-bold">{m.proposal.state}</p></div>}<time className="mt-2 block text-[10px] opacity-60">{new Date(m.createdAt).toLocaleString()}</time></div></div>) : <div className="grid h-full min-h-48 place-items-center text-center"><p className="max-w-sm text-sm text-muted-foreground">No messages have been returned for this conversation. Send a message to begin; provider replies arrive through the live negotiation service.</p></div>}</div>
          <div className="flex gap-2 border-t border-border pt-3"><input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void send()} placeholder="Talk through the workload and terms…" className="h-11 min-w-0 flex-1 rounded-xl bg-muted px-4 text-sm outline-none" /><Button className="rounded-xl" onClick={() => void send()} disabled={!text.trim() || busy || !conversationId}><Send className="size-4" /></Button></div></Panel>
        <div className="space-y-4"><Panel><div className="flex items-center gap-3"><IconTile icon={Cpu} tone="blue" size="md" /><h2 className="font-bold">Resource proposal</h2></div><p className="mt-1 text-xs text-muted-foreground">One request represents one provider laptop. The provider accepts once; then connect or retry that accepted request.</p>{duplicateAcceptedCount > 0 && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">There are {acceptedRequests.length} accepted requests for this provider. Only the newest is used for this worker node.</p>}
          {currentRequestState === "open" ? <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm"><p className="font-semibold">Waiting for provider acceptance</p><p className="mt-1 text-xs text-muted-foreground">Keep chatting here. Once accepted, the connection button becomes available.</p><Button variant="outline" className="mt-3 w-full rounded-xl" onClick={() => void closeRequest()} disabled={busy}>Cancel request and start over</Button></div> : currentRequestState === "accepted" ? <div className="mt-4 rounded-xl border border-success/30 bg-success-soft/40 p-3 text-sm"><p className="font-semibold text-success">Provider accepted this request</p><p className="mt-1 text-xs text-muted-foreground">Choose the project folder, then start the cluster. If setup failed, retry uses this same accepted request; the provider does not need to accept again.</p><Button variant="outline" className="mt-3 w-full rounded-xl" onClick={() => void closeRequest()} disabled={busy || connection?.status === "connecting" || connection?.status === "ready"}>Close accepted request and negotiate again</Button></div> : <>
            {currentRequestState && <p className="mt-3 rounded-xl bg-muted p-3 text-xs text-muted-foreground">Previous request: <span className="font-semibold capitalize">{currentRequestState}</span>. You can send a new proposal now.</p>}
            <label className="mt-4 block text-xs font-semibold"><span className="mb-1 flex items-center gap-2"><IconTile icon={Cpu} tone="blue" size="sm" />CPU cores</span><input type="number" min={1} value={cpu} onChange={(e) => setCpu(Math.max(1, Number(e.target.value)))} className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-3" /></label><label className="mt-3 block text-xs font-semibold"><span className="mb-1 flex items-center gap-2"><IconTile icon={MemoryStick} tone="violet" size="sm" />Memory (GB)</span><input type="number" min={1} value={memory} onChange={(e) => setMemory(Math.max(1, Number(e.target.value)))} className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-3" /></label><label className="mt-3 block text-xs font-semibold"><span className="mb-1 flex items-center gap-2"><IconTile icon={Timer} tone="cyan" size="sm" />Duration (minutes)</span><input type="number" min={1} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value)))} className="mt-1 h-10 w-full rounded-xl border border-border bg-background px-3" /></label><Button className="mt-4 w-full rounded-xl" onClick={() => void propose()} disabled={busy || !provider?.online || !canCreateProposal}><Send className="mr-2 size-4" />Send new proposal</Button>
          </>}</Panel>
          <Panel><div className="flex items-center gap-3"><IconTile icon={FolderOpen} tone="cyan" size="md" /><h2 className="font-bold">Project folder</h2></div><p className="mt-1 text-xs text-muted-foreground">Choose only after you and the provider agree. Approved nodes use this project folder; outputs and logs return to this consumer laptop.</p><Button variant="outline" className="mt-3 w-full rounded-xl" disabled={!accepted || busy || (!!sessionId && connection?.status !== "failed")} onClick={() => void chooseFolder()}><FolderOpen className="mr-2 size-4" />{folder ? "Change folder" : "Choose project folder"}</Button>{folder && <p className="mt-2 break-all text-xs text-muted-foreground">{folder}</p>}<Button className="mt-3 w-full rounded-xl" disabled={!accepted || !folder || busy || (!!sessionId && connection?.status !== "failed")} onClick={() => void startSession()}>{busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <ShieldCheck className="mr-2 size-4" />}{connection?.status === "failed" ? "Retry session" : "Start session"}</Button>{!accepted && <p className="mt-2 text-xs text-muted-foreground">Waiting for provider acceptance. No connection will be started yet.</p>}</Panel>
        </div>
      </div>
      {sessionId && <Panel className="mt-4"><div className="flex items-center gap-3"><LoaderCircle className={`size-5 text-primary ${connection?.status === "failed" ? "hidden" : "animate-spin"}`} /><div><h2 className="font-bold">{connection?.status === "failed" ? "Connection failed" : connection?.status === "ready" ? "Cluster connected" : "Establishing live provider connection"}</h2><p className="text-xs text-muted-foreground">Session {sessionId} · {connection?.status === "ready" ? "all nodes are ready" : connection?.status === "failed" ? "review the failed stage, fix it, then retry" : "the dashboard opens when all cluster nodes are Ready."}</p></div></div>{connection?.stages.length ? <div className="mt-5 grid gap-2 sm:grid-cols-2">{connection.stages.map((stage) => <div key={stage.id} className="flex items-start gap-3 rounded-xl border border-border p-3"><span className={`mt-1 size-2 rounded-full ${stage.status === "completed" ? "bg-success" : stage.status === "running" ? "bg-primary animate-pulse" : stage.status === "failed" ? "bg-destructive" : "bg-muted-foreground"}`} /><div><p className="text-sm font-semibold">{stage.label}</p><p className="mt-1 text-xs capitalize text-muted-foreground">{stage.status}{stage.detail ? ` · ${stage.detail}` : ""}</p></div></div>)}</div> : <p className="mt-4 text-sm text-muted-foreground">Waiting for live connection stages from the session service…</p>}</Panel>}
    </>}
  </div>;
}

function readSessionValue(key: string): string | null {
  try { return typeof window === "undefined" ? null : window.sessionStorage.getItem(key); }
  catch { return null; }
}

function writeSessionValue(key: string, value: string | null) {
  try { if (value === null) window.sessionStorage.removeItem(key); else window.sessionStorage.setItem(key, value); }
  catch { /* The live backend state remains authoritative if webview storage is unavailable. */ }
}

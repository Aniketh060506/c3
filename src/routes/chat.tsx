import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Check, Paperclip, Repeat, Send, X } from "lucide-react";
import { toast } from "sonner";
import { HueAvatar, PageHeader, Pill } from "@/components/kit";
import { providers, threads as seed, type Msg } from "@/lib/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chat")({
  head: () => ({
    meta: [
      { title: "Chat & negotiation · ComputePool" },
      { name: "description", content: "Negotiate resources and pricing directly with providers." },
      { property: "og:title", content: "Negotiate compute · ComputePool" },
      { property: "og:description", content: "Chat with providers and accept resource proposals." },
    ],
  }),
  component: Chat,
});

function Chat() {
  const [threads, setThreads] = useState(seed);
  const [active, setActive] = useState(seed[0].providerId);
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const thread = threads.find((t) => t.providerId === active)!;
  const p = providers.find((x) => x.id === active)!;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [thread.messages.length, active]);

  const push = (m: Omit<Msg, "id" | "time">) =>
    setThreads((ts) => ts.map((t) => (t.providerId === active ? { ...t, unread: 0, messages: [...t.messages, { ...m, id: String(Date.now() + Math.random()), time: "now" }] } : t)));

  const setProposal = (id: string, state: "accepted" | "rejected") =>
    setThreads((ts) => ts.map((t) => (t.providerId === active ? { ...t, messages: t.messages.map((m) => (m.id === id && m.proposal ? { ...m, proposal: { ...m.proposal, state } } : m)) } : t)));

  const send = () => {
    if (!text.trim()) return;
    push({ from: "me", text });
    setText("");
    setTimeout(() => push({ from: "them", text: "Sounds good — sending you an updated proposal." }), 1200);
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Negotiation" title="Messages" />
      <div className="grid h-[calc(100vh-15rem)] min-h-[520px] overflow-hidden rounded-[2rem] border border-border bg-card shadow-soft md:grid-cols-[280px_1fr]">
        <aside className="hidden flex-col gap-1 border-r border-border p-3 md:flex">
          {threads.map((t) => {
            const pr = providers.find((x) => x.id === t.providerId)!;
            const last = t.messages[t.messages.length - 1];
            return (
              <button key={t.providerId} onClick={() => { setActive(t.providerId); setThreads((ts) => ts.map((x) => (x.providerId === t.providerId ? { ...x, unread: 0 } : x))); }}
                className="relative flex items-center gap-3 rounded-2xl p-3 text-left">
                {active === t.providerId && <motion.span layoutId="thread" className="absolute inset-0 rounded-2xl bg-muted" />}
                <div className="relative"><HueAvatar hue={pr.hue} label={pr.name} size={40} />{pr.online && <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-card bg-success" />}</div>
                <div className="relative min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{pr.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{last.proposal ? "📦 Resource proposal" : last.text}</p>
                </div>
                {t.unread > 0 && <span className="relative grid size-5 place-items-center rounded-full bg-accent text-[10px] font-bold text-accent-foreground">{t.unread}</span>}
              </button>
            );
          })}
        </aside>

        <section className="flex min-h-0 flex-col">
          <div className="flex items-center gap-3 border-b border-border px-5 py-3">
            <HueAvatar hue={p.hue} label={p.name} size={36} />
            <div className="flex-1"><p className="text-sm font-bold">{p.name}</p><p className="text-xs text-muted-foreground">{p.cpu} · {p.gpu ?? "CPU only"}</p></div>
            {p.online ? <Pill tone="success" pulse>Online</Pill> : <Pill>Offline</Pill>}
          </div>

          <div className="dot-grid flex-1 space-y-3 overflow-y-auto p-5">
            <AnimatePresence initial={false}>
              {thread.messages.map((m) => (
                <motion.div key={m.id} layout initial={{ opacity: 0, y: 14, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 380, damping: 28 }}
                  className={cn("flex", m.from === "me" ? "justify-end" : "justify-start")}>
                  {m.proposal ? (
                    <ProposalCard m={m} onAccept={() => { setProposal(m.id, "accepted"); toast.success("Proposal accepted — session is being prepared"); }}
                      onReject={() => setProposal(m.id, "rejected")}
                      onCounter={() => push({ from: "me", proposal: { ...m.proposal!, price: +(m.proposal!.price * 0.85).toFixed(2), state: "open" } })} />
                  ) : (
                    <div className={cn("max-w-[70%] rounded-3xl px-4 py-2.5 text-sm", m.from === "me" ? "rounded-br-lg bg-primary text-primary-foreground" : "rounded-bl-lg border border-border bg-card")}>
                      {m.text}<span className="ml-2 text-[10px] opacity-60">{m.time}</span>
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
            <div ref={endRef} />
          </div>

          <div className="flex items-center gap-2 border-t border-border p-3">
            <button className="grid size-11 place-items-center rounded-2xl bg-muted" aria-label="Attach" onClick={() => toast("File picker opens in the desktop app")}><Paperclip className="size-4" /></button>
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Write a message…" className="h-11 flex-1 rounded-2xl bg-muted px-4 text-sm outline-none" />
            <motion.button whileTap={{ scale: 0.9, rotate: -12 }} onClick={send} className="grid size-11 place-items-center rounded-2xl bg-primary text-primary-foreground" aria-label="Send"><Send className="size-4" /></motion.button>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProposalCard({ m, onAccept, onReject, onCounter }: { m: Msg; onAccept: () => void; onReject: () => void; onCounter: () => void }) {
  const pr = m.proposal!;
  return (
    <motion.div layout className={cn("w-80 overflow-hidden rounded-3xl border-2 bg-card shadow-lift", pr.state === "accepted" ? "border-success" : pr.state === "rejected" ? "border-destructive" : "border-primary")}>
      <div className="flex items-center justify-between bg-primary-soft px-4 py-2.5">
        <span className="text-xs font-bold uppercase tracking-wider text-primary">{m.from === "me" ? "Your counteroffer" : "Resource proposal"}</span>
        {pr.state !== "open" && <Pill tone={pr.state === "accepted" ? "success" : "destructive"}>{pr.state}</Pill>}
      </div>
      <div className="grid grid-cols-4 gap-1 p-4 text-center">
        {[["CPU", pr.cpu], ["RAM", `${pr.ram}G`], ["GPU", pr.gpu], ["Hours", pr.hours]].map(([k, v]) => (
          <div key={k}><p className="font-display text-xl font-bold">{v}</p><p className="text-[10px] text-muted-foreground">{k}</p></div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <span className="text-sm text-muted-foreground">Agreed price</span>
        <span className="font-display text-xl font-bold">{pr.price.toFixed(2)} cr</span>
      </div>
      {pr.state === "open" && m.from === "them" && (
        <div className="grid grid-cols-3 gap-1.5 p-3 pt-0">
          <button onClick={onAccept} className="flex items-center justify-center gap-1 rounded-xl bg-success py-2 text-xs font-bold text-primary-foreground"><Check className="size-3.5" />Accept</button>
          <button onClick={onCounter} className="flex items-center justify-center gap-1 rounded-xl bg-muted py-2 text-xs font-bold"><Repeat className="size-3.5" />Counter</button>
          <button onClick={onReject} className="flex items-center justify-center gap-1 rounded-xl bg-destructive-soft py-2 text-xs font-bold text-destructive"><X className="size-3.5" />Reject</button>
        </div>
      )}
    </motion.div>
  );
}

import React, { useEffect, useState } from 'react';
import { X, Send, Handshake, RefreshCw } from 'lucide-react';

export default function NegotiationChat({ sessionId, counterpartyName = 'Provider', onClose }) {
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [offer, setOffer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [nextSession, nextMessages] = await Promise.all([
          window.c3.getNegotiationSession(sessionId),
          window.c3.getNegotiationMessages(sessionId),
        ]);
        if (mounted) {
          setSession(nextSession);
          setMessages(nextMessages || []);
          setError('');
        }
      } catch (err) {
        if (mounted) setError(err.message || 'Chat service is unavailable.');
      }
    };
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => { mounted = false; clearInterval(timer); };
  }, [sessionId]);

  const send = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await window.c3.sendNegotiationMessage({ sessionId, text, offerPerHour: offer || null });
      setText('');
      setOffer('');
      const nextMessages = await window.c3.getNegotiationMessages(sessionId);
      setMessages(nextMessages || []);
    } catch (err) {
      setError(err.message || 'Message could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const acceptOffer = async price => {
    setBusy(true);
    setError('');
    try {
      await window.c3.acceptNegotiatedOffer(sessionId, price);
      const [nextSession, nextMessages] = await Promise.all([
        window.c3.getNegotiationSession(sessionId),
        window.c3.getNegotiationMessages(sessionId),
      ]);
      setSession(nextSession);
      setMessages(nextMessages || []);
    } catch (err) {
      setError(err.message || 'Offer could not be accepted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="w-full rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden flex flex-col min-h-[22rem] max-h-[34rem]" role="tabpanel" aria-label="Provider request chat tab">
        <header className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold tracking-[0.16em] text-indigo-600 uppercase">Provider request · price negotiation</p>
            <h2 className="text-lg font-bold text-slate-900">{counterpartyName}</h2>
            <p className="text-xs text-slate-500 font-mono">Request {sessionId} · {session?.status || 'Loading status'}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-500" aria-label="Close chat"><X className="w-5 h-5" /></button>
        </header>

        <div className="px-4 py-2.5 bg-amber-50 text-amber-900 text-xs flex items-start gap-2">
          <Handshake className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Quotes are stored in chat for agreement only. C3 does not charge, settle, or pay credits yet.</span>
        </div>

        {session?.agreedPriceCreditsPerHour != null && (
          <div className="px-4 py-2.5 border-b border-emerald-100 bg-emerald-50 text-sm text-emerald-800 font-semibold">
            Price agreed: {session.agreedPriceCreditsPerHour} C3 test credits/hour
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {!messages.length && !error && <p className="text-sm text-slate-500 text-center py-10">No messages yet. Send a question or make a price offer.</p>}
          {messages.map(message => {
            const mine = message.senderId === session?.currentUserId;
            const isOffer = message.type === 'OFFER';
            const isAccepted = message.type === 'ACCEPTED_OFFER';
            return (
              <div key={message.messageId || message.timestamp} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${isAccepted ? 'bg-emerald-50 border border-emerald-200 text-emerald-900' : mine ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-800'}`}>
                  <div className="flex items-center gap-2 text-[10px] opacity-75 mb-1">
                    <span>{mine ? 'You' : message.senderName || counterpartyName}</span>
                    <time>{message.createdAt ? new Date(message.createdAt).toLocaleTimeString() : ''}</time>
                  </div>
                  {isOffer && <div className="font-bold text-sm mb-1">Offer: {message.offerPerHour} test credits/hour</div>}
                  <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
                  {isOffer && !mine && session?.agreedPriceCreditsPerHour == null && (
                    <button type="button" disabled={busy} onClick={() => acceptOffer(message.offerPerHour)} className="mt-3 px-3 py-1.5 rounded-lg bg-white text-indigo-700 text-xs font-bold disabled:opacity-50">
                      Accept quote
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {error && <p role="alert" className="text-xs text-rose-700 bg-rose-50 p-3 rounded-xl">{error}</p>}
        </div>

        <form onSubmit={send} className="p-3 border-t border-slate-100 bg-slate-50">
          <div className="flex flex-col sm:flex-row gap-2">
            <input value={text} onChange={e => setText(e.target.value)} maxLength={2000} placeholder="Ask a question or add a note…" className="flex-1 min-w-0 px-3 py-2.5 bg-white rounded-xl border border-slate-200 text-sm outline-none focus:border-indigo-400" />
            <input type="number" min="0.01" max="1000000" step="0.01" value={offer} onChange={e => setOffer(e.target.value)} placeholder="Credits/hr" aria-label="Price offer in test credits per hour" className="w-full sm:w-32 px-3 py-2.5 bg-white rounded-xl border border-slate-200 text-sm outline-none focus:border-indigo-400" />
            <button disabled={busy || (!text.trim() && !offer)} className="h-10 px-4 self-end rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50" aria-label="Send message or offer"><Send className="w-4 h-4" /></button>
          </div>
          <div className="mt-2 text-[10px] text-slate-500 flex items-center gap-1"><RefreshCw className="w-3 h-3" />Messages refresh from DynamoDB every 2.5 seconds.</div>
        </form>
    </section>
  );
}

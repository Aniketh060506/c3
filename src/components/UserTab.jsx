import React, { useState, useEffect, useRef } from 'react';
import ChatPanel from './ChatPanel';


/* ── Tilt helper ── */
const tilt = (e, el) => {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const rx = ((y - r.height / 2) / (r.height / 2)) * -6;
  const ry = ((x - r.width  / 2) / (r.width  / 2)) *  6;
  el.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-5px)`;
};
const untilt = (el) => { if (el) el.style.transform = ''; };

/* ── Real SSH Terminal (Electron only) ── */
function SSHWorkspace({ session, onCancel }) {
  const termRef   = useRef(null);
  const xtermRef  = useRef(null);
  const [connecting, setConnecting] = useState(true);
  const [connErr, setConnErr]       = useState('');

  useEffect(() => {
    let mounted = true;

    async function init() {
      if (!window.c3?.connectSSH) {
        setConnecting(false);
        setConnErr('No SSH bridge available (window.c3.connectSSH missing).');
        return;
      }

      // Dynamically import xterm.js (bundled with the app)
      let Terminal, FitAddon;
      try {
        const xt = await import('xterm');
        const fa = await import('xterm-addon-fit');
        Terminal = xt.Terminal;
        FitAddon = fa.FitAddon;
      } catch {
        setConnecting(false);
        setConnErr('xterm.js not available.');
        return;
      }

      if (!mounted || !termRef.current) return;

      const term = new Terminal({
        theme: { background: '#09090c', foreground: '#e2e8f0', cursor: '#ffffff', selection: 'rgba(255,255,255,0.2)' },
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 14,
        cursorBlink: true,
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(termRef.current);
      fit.fit();
      xtermRef.current = term;

      // Resize observer
      const ro = new ResizeObserver(() => fit.fit());
      ro.observe(termRef.current);

      term.write('\x1b[90mConnecting to session...\x1b[0m\r\n');

      // Wire IPC events
      window.c3.onTerminalData(data => { if (mounted) term.write(data); });
      window.c3.onTerminalClose(() => { if (mounted) term.write('\r\n\x1b[31mSession closed.\x1b[0m\r\n'); });
      term.onData(data => window.c3.sendTermInput(data));

      // Actually connect
      try {
        await window.c3.connectSSH(session.sessionId);
        if (mounted) { setConnecting(false); term.write('\x1b[32mConnected!\x1b[0m\r\n'); }
      } catch (err) {
        if (mounted) { setConnecting(false); setConnErr(err.message || 'SSH connection failed'); }
      }

      const handleResize = () => {
        fit.fit();
        window.c3.resizeTerminal(term.cols, term.rows);
      };
      window.addEventListener('resize', handleResize);

      return () => {
        ro.disconnect();
        window.removeEventListener('resize', handleResize);
        term.dispose();
      };
    }

    const cleanup = init();
    return () => {
      mounted = false;
      cleanup.then(fn => fn?.()).catch(() => {});
    };
  }, [session.sessionId]);

  const handleCancel = () => {
    if (window.c3?.disconnectSSH) window.c3.disconnectSSH().catch(() => {});
    if (xtermRef.current) { xtermRef.current.dispose(); xtermRef.current = null; }
    onCancel();
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 20, gap: 12, boxSizing: 'border-box' }}>
      {/* Terminal header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18 }}>🔗 {session.displayName || 'Remote Session'}</div>
          <div style={{ fontSize: 12, color: '#71717a', marginTop: 2 }}>
            {connecting ? 'Connecting…' : connErr ? 'Connection failed' : 'SSH Session Active'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {!connErr && !connecting && (
            <button className="btn btn-ghost" style={{ fontSize: 12 }}
              onClick={() => { window.c3?.disconnectSSH?.(); window.c3?.connectSSH?.(session.sessionId); }}>
              Reconnect
            </button>
          )}
          <button className="btn btn-danger" onClick={handleCancel}>End Session</button>
        </div>
      </div>

      {/* Terminal wrapper */}
      <div style={{ flex: 1, background: '#09090c', borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Traffic lights bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', background: '#0a0a0d', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          {['#ef4444','#f59e0b','#22c55e'].map(c => <div key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c }} />)}
          <div style={{ marginLeft: 8, fontSize: 11, color: '#52525b', fontFamily: 'monospace' }}>
            {session.displayName || 'node'} — bash
          </div>
        </div>

        {connecting && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
            <div style={{ width: 32, height: 32, border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <div style={{ color: '#71717a', fontSize: 13 }}>Establishing SSH connection…</div>
          </div>
        )}

        {connErr && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 28 }}>⚠️</div>
            <div style={{ color: '#fca5a5', fontWeight: 700, fontSize: 15 }}>Connection Failed</div>
            <div style={{ color: '#71717a', fontSize: 12, maxWidth: 400, textAlign: 'center' }}>{connErr}</div>
          </div>
        )}

        {/* The actual terminal div */}
        <div ref={termRef} style={{ flex: 1, minHeight: 0, display: connecting || connErr ? 'none' : 'block' }} />
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}} .xterm{height:100%;padding:8px;}`}</style>
    </div>
  );
}

/* ── Declined notification ── */
function DeclinedNotice({ onDismiss }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', padding: '48px 40px', maxWidth: 380, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 20 }}>
        <div style={{ fontSize: 52, marginBottom: 16 }}>❌</div>
        <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 8, color: '#fca5a5' }}>Session Declined</div>
        <div style={{ fontSize: 14, color: '#71717a', lineHeight: 1.6, marginBottom: 24 }}>
          The provider declined your session request. Try requesting from a different node.
        </div>
        <button className="btn btn-primary" onClick={onDismiss}>Browse Marketplace</button>
      </div>
    </div>
  );
}

export default function UserTab({ user }) {
  const [providers, setProviders]       = useState([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [waiting, setWaiting]           = useState(false);
  const [activeSession, setActiveSession] = useState(null);
  const [declined, setDeclined]         = useState(false);
  const [chatTarget, setChatTarget]     = useState(null); // { userId, displayName }

  const fetchProviders = async () => {
    if (!window.c3?.getProviders) { setLoading(false); return; }
    setLoading(true);
    try {
      const list = await window.c3.getProviders();
      setProviders(list || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    fetchProviders();

    if (window.c3?.onSessionReady) {
      window.c3.onSessionReady((session) => {
        setWaiting(false);
        // DECLINED or COMPLETED → show declined notice, NOT the terminal
        if (session.status === 'DECLINED' || session.status === 'COMPLETED') {
          setDeclined(true);
          setActiveSession(null);
        } else if (session.sshHost && session.sessionId) {
          // Only open terminal if we actually have an SSH endpoint
          setActiveSession(session);
          setDeclined(false);
        }
      });
    }

    const t = window.c3 ? setInterval(fetchProviders, 30_000) : null;
    return () => { if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestSession = async (node) => {
    if (!window.c3?.sendSessionReq) {
      // Dev preview: don't fake a session
      alert('C3 Desktop app required to request sessions.');
      return;
    }
    try {
      setWaiting(true);
      setDeclined(false);
      await window.c3.sendSessionReq({
        providerId:    node.userId,
        environment:   'base',
        cpuCores:      2,
        ramGb:         4,
        durationHours: 1,
        cudaRequested: node.hasCuda || false,
      });
    } catch (e) { setWaiting(false); alert(e.message); }
  };

  /* ── Routing ── */
  if (declined) return <DeclinedNotice onDismiss={() => { setDeclined(false); fetchProviders(); }} />;
  if (activeSession) return <SSHWorkspace session={activeSession} onCancel={() => { setActiveSession(null); fetchProviders(); }} />;

  if (waiting) return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', padding: '48px 40px', maxWidth: 380, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20 }}>
        <div style={{ width: 44, height: 44, border: '3px solid rgba(255,255,255,0.1)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 20px' }} />
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>Waiting for Provider</div>
        <div style={{ fontSize: 13, color: '#71717a', lineHeight: 1.6, marginBottom: 24 }}>
          Your session request was sent. The provider will accept or decline shortly.
        </div>
        <button className="btn btn-ghost" onClick={() => setWaiting(false)}>Cancel</button>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (!window.c3) return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', padding: '48px 40px', maxWidth: 400 }}>
        <div style={{ fontSize: 52, marginBottom: 16 }}>🖥️</div>
        <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 10 }}>Desktop Client Required</div>
        <div style={{ fontSize: 14, color: '#71717a', lineHeight: 1.6 }}>Open C3 in the Electron desktop app to browse and connect to the compute marketplace.</div>
      </div>
    </div>
  );

  const filtered = providers.filter(p =>
    (p.displayName || '').toLowerCase().includes(search.toLowerCase()) ||
    (p.location || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding: '28px 32px', minHeight: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
        <div>
          <h2 style={{ margin: '0 0 5px', fontSize: 28, fontWeight: 800, letterSpacing: '-1px' }}>Compute Marketplace</h2>
          <div style={{ fontSize: 14, color: '#71717a' }}>Browse active nodes worldwide • Live</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input className="input" placeholder="🔍 Search node or location..." value={search}
            onChange={e => setSearch(e.target.value)} style={{ width: 260, fontSize: 14 }} />
          <button className="btn btn-ghost" onClick={fetchProviders}>
            {loading ? <div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.15)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> : '↻'}
            Refresh
          </button>
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
          {[1,2,3,4,5,6].map(i => (
            <div key={i} className="node-card" style={{ height: 220, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[70, 40, 100, 60].map((w, j) => (
                <div key={j} style={{ height: 14, background: 'rgba(255,255,255,0.05)', borderRadius: 7, width: `${w}%`, animation: 'pulse 1.5s ease infinite', animationDelay: `${j * 0.15}s` }} />
              ))}
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 80 }}>
          <div style={{ textAlign: 'center', padding: '56px 48px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20 }}>
            <div style={{ fontSize: 56, marginBottom: 16 }}>🏜️</div>
            <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 8 }}>No nodes online</div>
            <div style={{ fontSize: 14, color: '#71717a', marginBottom: 24 }}>No active providers right now.</div>
            <button className="btn btn-primary" onClick={fetchProviders}>Refresh Marketplace</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18 }}>
          {filtered.map((node, i) => (
            <div key={node.userId || i}
              className={`node-card anim-up d${(i % 6) + 1}`}
              onMouseMove={e => tilt(e, e.currentTarget)}
              onMouseLeave={e => untilt(e.currentTarget)}>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                  <div className="dot-g" style={{ flexShrink: 0 }} />
                  <div style={{ fontWeight: 700, fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.displayName || 'Anonymous Node'}</div>
                </div>
                <div style={{ flexShrink: 0, marginLeft: 8, textAlign: 'right' }}>
                  <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: '-1px' }}>{(node.benchmarkScore || 8500).toLocaleString()}</div>
                  <div style={{ fontSize: 9, color: '#52525b', fontWeight: 700, letterSpacing: '0.8px' }}>SCORE</div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 100, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#a1a1aa' }}>📍 {node.location || 'Unknown'}</span>
                {node.hasCuda && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 100, background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)', color: '#22c55e' }}>CUDA ✓</span>}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <div className="spec-chip"><div className="spec-chip-val">{node.cpuCores || '—'}C</div><div className="spec-chip-lbl">CPU</div></div>
                <div className="spec-chip"><div className="spec-chip-val">{node.totalRamGB || '—'}G</div><div className="spec-chip-lbl">RAM</div></div>
                <div className="spec-chip" style={{ flex: 2 }}>
                  <div className="spec-chip-val" style={{ fontSize: 11, textAlign: 'center' }}>{node.gpuName ? node.gpuName.split(' ').slice(-2).join(' ') : 'No GPU'}</div>
                  <div className="spec-chip-lbl">GPU</div>
                </div>
              </div>

              <div className="pbar-track">
                <div className="pbar-fill green" style={{ width: `${Math.min(100, ((node.benchmarkScore || 8500) / 10000) * 100)}%` }} />
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                <button className="btn btn-ghost" style={{ flex: 1, fontSize: 13 }}
                  onClick={() => setChatTarget({ userId: node.userId, displayName: node.displayName || 'Provider' })}>
                  💬 Chat
                </button>
                <button className="btn btn-primary" style={{ flex: 2, fontSize: 13 }} onClick={() => requestSession(node)}>⚡ Request Session</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes pulse{0%,100%{opacity:0.5}50%{opacity:1}}`}</style>

      {/* Chat panel — rendered outside the grid so it overlays properly */}
      {chatTarget && (
        <ChatPanel
          myId={user?.userId}
          myEmail={user?.email}
          toUserId={chatTarget.userId}
          toName={chatTarget.displayName}
          onClose={() => setChatTarget(null)}
        />
      )}
    </div>
  );
}

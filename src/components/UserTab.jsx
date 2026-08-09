import React, { useState, useEffect } from 'react';
import ChatPanel from './ChatPanel';
import SSHWorkspace from './SSHWorkspace';

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
        // Clear the renderer-side backup poll if it was running
        if (window._c3BackupPoll) { clearInterval(window._c3BackupPoll); window._c3BackupPoll = null; }
        setWaiting(false);
        // DECLINED or COMPLETED → show declined notice, NOT the terminal
        if (session.status === 'DECLINED' || session.status === 'COMPLETED') {
          setDeclined(true);
          setActiveSession(null);
        } else if (session.sessionId) {
          // Only open terminal if we actually have a sessionId
          setActiveSession(session);
          setDeclined(false);
        }
      });
    }

    const t = window.c3 ? setInterval(fetchProviders, 30_000) : null;
    return () => { if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selectedNode, setSelectedNode] = useState(null);

  const confirmRequest = async (config) => {
    if (!window.c3?.sendSessionReq || !selectedNode) return;
    try {
      const node = selectedNode;
      setSelectedNode(null);
      setWaiting(true);
      setDeclined(false);
      const { sessionId } = await window.c3.sendSessionReq({
        providerId:    node.userId,
        environment:   config.environment,
        cpuCores:      config.cpuCores,
        ramGb:         config.ramGb,
        durationHours: config.durationHours,
        cudaRequested: config.cudaRequested,
      });

      // Renderer-side backup poll — in case the IPC session:ready event is missed
      // (can happen on slow connections or race conditions)
      if (sessionId && window.c3?.getSession) {
        const backupPoll = setInterval(async () => {
          try {
            const session = await window.c3.getSession(sessionId);
            if (!session) return;
            if (session.status === 'READY' || session.status === 'DECLINED' || session.status === 'COMPLETED') {
              clearInterval(backupPoll);
              if (session.status === 'READY') {
                setWaiting(false);
                setActiveSession({ ...session, sessionId });
                setDeclined(false);
              } else {
                setWaiting(false);
                setDeclined(true);
                setActiveSession(null);
              }
            }
          } catch (_) {}
        }, 1500);
        // Store so we can clear it if session:ready fires first
        window._c3BackupPoll = backupPoll;
      }
    } catch (e) { setWaiting(false); alert(e.message); }
  };

  const requestSession = (node) => {
    if (!window.c3?.sendSessionReq) {
      alert('C3 Desktop app required to request sessions.');
      return;
    }
    setSelectedNode(node);
  };

  /* ── Routing ── */
  if (declined) return <DeclinedNotice onDismiss={() => { setDeclined(false); fetchProviders(); }} />;
  if (activeSession) return <SSHWorkspace sessionId={activeSession.sessionId} provider={activeSession} onEnd={() => { setActiveSession(null); fetchProviders(); }} />;

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

      {/* Chat panel */}
      {chatTarget && (
        <ChatPanel
          myId={user?.userId}
          myEmail={user?.email}
          toUserId={chatTarget.userId}
          toName={chatTarget.displayName}
          onClose={() => setChatTarget(null)}
        />
      )}

      {/* Request Configuration Modal */}
      {selectedNode && (
        <RequestConfigModal
          node={selectedNode}
          onConfirm={confirmRequest}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}

function RequestConfigModal({ node, onConfirm, onClose }) {
  const maxCores = node.cpuCores || 8;
  const maxRam   = node.totalRamGB || 16;
  const [cpuCores, setCpuCores]           = useState(Math.min(4, maxCores));
  const [ramGb, setRamGb]                 = useState(Math.min(8, maxRam));
  const [cudaRequested, setCudaRequested] = useState(!!node.hasCuda);
  const [environment, setEnvironment]     = useState('base');
  const [durationHours, setDurationHours] = useState(1);

  const coreOptions = [2, 4, 8, 16, 32].filter(c => c <= maxCores || c === 2);
  const ramOptions  = [4, 8, 16, 32, 64].filter(r => r <= maxRam || r === 4);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(10px)', zIndex: 100 }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        zIndex: 101, width: 480, maxWidth: '92vw',
        background: '#0e0e12', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 24,
        padding: 28, boxShadow: '0 24px 80px rgba(0,0,0,0.8)', color: '#f8fafc'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: '-0.5px' }}>Configure Compute Session</div>
            <div style={{ fontSize: 12, color: '#71717a', marginTop: 4 }}>Node: {node.displayName || 'Remote Node'}</div>
          </div>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', color: '#a1a1aa', borderRadius: '50%', width: 28, height: 28, cursor: 'pointer', fontSize: 15 }}>×</button>
        </div>

        {/* CPU Cores */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#a1a1aa', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
            <span>CPU Cores</span>
            <span style={{ color: '#fff' }}>{cpuCores} Cores</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {coreOptions.map(c => (
              <button key={c} onClick={() => setCpuCores(c)}
                style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: cpuCores === c ? '1.5px solid #22c55e' : '1px solid rgba(255,255,255,0.1)', background: cpuCores === c ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.03)', color: cpuCores === c ? '#22c55e' : '#a1a1aa', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {c}C
              </button>
            ))}
          </div>
        </div>

        {/* RAM */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#a1a1aa', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
            <span>Memory (RAM)</span>
            <span style={{ color: '#fff' }}>{ramGb} GB RAM</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {ramOptions.map(r => (
              <button key={r} onClick={() => setRamGb(r)}
                style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: ramGb === r ? '1.5px solid #3b82f6' : '1px solid rgba(255,255,255,0.1)', background: ramGb === r ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.03)', color: ramGb === r ? '#60a5fa' : '#a1a1aa', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {r}GB
              </button>
            ))}
          </div>
        </div>

        {/* GPU Toggle */}
        <div style={{ marginBottom: 18, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>NVIDIA GPU Acceleration</div>
            <div style={{ fontSize: 11, color: '#71717a', marginTop: 2 }}>{node.gpuName || 'CUDA acceleration'}</div>
          </div>
          <input
            type="checkbox"
            checked={cudaRequested}
            disabled={!node.hasCuda}
            onChange={e => setCudaRequested(e.target.checked)}
            style={{ width: 18, height: 18, accentColor: '#22c55e', cursor: node.hasCuda ? 'pointer' : 'not-allowed' }}
          />
        </div>

        {/* Duration */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#a1a1aa', marginBottom: 8 }}>Session Duration</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[1, 2, 4, 8].map(h => (
              <button key={h} onClick={() => setDurationHours(h)}
                style={{ flex: 1, padding: '8px 0', borderRadius: 10, border: durationHours === h ? '1.5px solid #fff' : '1px solid rgba(255,255,255,0.1)', background: durationHours === h ? '#fff' : 'rgba(255,255,255,0.03)', color: durationHours === h ? '#000' : '#a1a1aa', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                {h}h
              </button>
            ))}
          </div>
        </div>

        {/* Submit */}
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={onClose} style={{ flex: 1, padding: '12px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => onConfirm({ cpuCores, ramGb, cudaRequested, environment, durationHours })}
            style={{ flex: 2, padding: '12px', borderRadius: 12, border: 'none', background: '#fff', color: '#000', fontWeight: 800, fontSize: 14, cursor: 'pointer', boxShadow: '0 4px 20px rgba(255,255,255,0.2)' }}>
            🚀 Confirm & Launch
          </button>
        </div>
      </div>
    </>
  );
}

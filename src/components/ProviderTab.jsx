import React, { useState, useEffect, useRef } from 'react';
import ChatPanel from './ChatPanel';


const STORAGE_KEY = 'c3_provider_profile';
const saved = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; } };
const persist = (data) => localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
const fmt = s => `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

function Toggle({ on, onToggle }) {
  return (
    <div onClick={onToggle} style={{ width: 60, height: 32, borderRadius: 100, background: on ? '#22c55e' : 'rgba(255,255,255,0.1)', cursor: 'pointer', position: 'relative', transition: 'background 0.28s ease', flexShrink: 0, boxShadow: on ? '0 0 20px rgba(34,197,94,0.3)' : 'none' }}>
      <div style={{ position: 'absolute', top: 4, left: on ? 30 : 4, width: 24, height: 24, borderRadius: '50%', background: '#fff', transition: 'left 0.22s cubic-bezier(.16,1,.3,1)', boxShadow: '0 2px 8px rgba(0,0,0,0.4)' }} />
    </div>
  );
}

function HardwareCard({ icon, label, value, sub, color = '#fff' }) {
  return (
    <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 20, padding: '24px 22px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', transition: 'border-color 0.2s, background 0.2s', cursor: 'default', minHeight: 130 }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)'; e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}>
      <div style={{ fontSize: 28 }}>{icon}</div>
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 5 }}>{label}</div>
        <div style={{ fontSize: 16, fontWeight: 800, color, lineHeight: 1.2, letterSpacing: '-0.4px' }}>{value}</div>
        {sub && <div style={{ fontSize: 11, color: '#71717a', marginTop: 4 }}>{sub}</div>}
      </div>
    </div>
  );
}

export default function ProviderTab({ user, active, setActive }) {
  const cache = saved();
  const [specs, setSpecs]           = useState(cache?.specs || null);
  const [docker, setDocker]         = useState(false);
  const [registered, setRegistered] = useState(!!cache?.registered);
  const [profile, setProfile]       = useState(cache?.profile || { displayName: '', location: '' });
  const [score, setScore]           = useState(cache?.score || 0);
  const [benching, setBenching]     = useState(false);
  const [activeSession, setSession] = useState(null);
  const [live, setLive]             = useState({ cpuLoad: 0, ramPct: 0, ramUsedGB: 0, ramTotalGB: 0 });
  const [pending, setPending]       = useState([]);
  const [elapsed, setElapsed]       = useState(0);
  const elRef = useRef(null);
  const [registering, setRegistering] = useState(false);
  const [chatTarget, setChatTarget]   = useState(null);

  useEffect(() => {
    if (!window.c3) return;
    window.c3.isDockerRunning().then(r => setDocker(r)).catch(() => {});
    if (!specs) window.c3.getHardwareSpecs().then(s => { setSpecs(s); persist({ ...cache, specs: s }); }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active || !registered || !window.c3?.getPendingReqs) return;
    const t = setInterval(() => window.c3.getPendingReqs().then(r => r && setPending(r)).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [active, registered]);

  useEffect(() => {
    if (!activeSession || !window.c3?.getLiveStats) return;
    const t = setInterval(() => window.c3.getLiveStats().then(s => setLive(s)).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [activeSession]);

  useEffect(() => {
    if (activeSession) { setElapsed(0); elRef.current = setInterval(() => setElapsed(n => n+1), 1000); }
    else if (elRef.current) clearInterval(elRef.current);
    return () => { if (elRef.current) clearInterval(elRef.current); };
  }, [activeSession]);

  const toggleActive = () => {
    const n = !active;
    setActive(n); // updates App-level state + localStorage immediately
    if (window.c3?.toggleStatus) {
      window.c3.toggleStatus(n)
        .then(() => console.log('[C3] Provider status set to', n ? 'ACTIVE' : 'INACTIVE'))
        .catch(err => console.error('[C3] toggleStatus failed:', err));
    }
  };

  const runBench = async () => {
    if (benching || !window.c3?.runBenchmark) return;
    setBenching(true); setScore(0);
    try { const r = await window.c3.runBenchmark(); setScore(r); persist({ registered, profile, specs, score: r }); }
    catch (_) {} finally { setBenching(false); }
  };

  const handleRegister = async () => {
    if (!profile.displayName.trim()) return;
    setRegistering(true);
    if (window.c3?.registerProvider) {
      try { await window.c3.registerProvider({ ...profile, ...specs }); } catch (e) { console.error(e); }
    }
    setRegistered(true);
    persist({ registered: true, profile, specs, score });
    setRegistering(false);
  };

  const acceptReq = async (req) => {
    if (window.c3?.acceptRequest) { try { await window.c3.acceptRequest(req.sessionId, req); } catch (e) { alert(e.message); return; } }
    setPending(p => p.filter(r => r.sessionId !== req.sessionId));
    setSession(req);
  };

  const declineReq = (req) => {
    if (window.c3?.declineRequest) window.c3.declineRequest(req.sessionId).catch(() => {});
    setPending(p => p.filter(r => r.sessionId !== req.sessionId));
  };

  const endSession = () => {
    if (window.c3?.endSession && activeSession) window.c3.endSession(activeSession.sessionId).catch(() => {});
    setSession(null);
  };

  if (!window.c3) return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', padding: '56px 48px', maxWidth: 420 }}>
        <div style={{ fontSize: 64, marginBottom: 20 }}>🖥️</div>
        <div style={{ fontWeight: 800, fontSize: 24, marginBottom: 10 }}>Desktop Client Required</div>
        <div style={{ fontSize: 15, color: '#71717a', lineHeight: 1.6 }}>Run C3 in the Electron app to share hardware and earn credits.</div>
      </div>
    </div>
  );

  const cpuShort = specs?.cpuModel?.replace(/\s*\(\d+ Cores\)/, '') || '…';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0' }}>

      {/* ── TOP HERO STRIP ── */}
      <div style={{ padding: '28px 32px 0', flexShrink: 0 }}>
        <div style={{
          background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 24, padding: '28px 32px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 32,
          position: 'relative', overflow: 'hidden',
        }}>
          {/* shimmer top line */}
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, background: 'linear-gradient(90deg,transparent,rgba(255,255,255,0.12),transparent)', animation: 'shimmerLine 5s ease-in-out infinite' }} />

          {/* Left: identity */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flex: 1, minWidth: 0 }}>
            {/* Status orb */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: active ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.05)', border: `2px solid ${active ? 'rgba(34,197,94,0.4)' : 'rgba(255,255,255,0.1)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.3s ease', boxShadow: active ? '0 0 24px rgba(34,197,94,0.2)' : 'none' }}>
                <div style={{ width: 16, height: 16, borderRadius: '50%', background: active ? '#22c55e' : '#52525b', transition: 'all 0.3s ease', boxShadow: active ? '0 0 10px rgba(34,197,94,0.8)' : 'none', animation: active ? 'greenPulse 2s ease-in-out infinite' : 'none' }} />
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 900, fontSize: 28, letterSpacing: '-1px', lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {registered ? (profile.displayName || 'My Node') : 'Unregistered Node'}
              </div>
              <div style={{ fontSize: 13, color: '#71717a', marginTop: 4, display: 'flex', gap: 14, alignItems: 'center' }}>
                {registered && <span>📍 {profile.location || 'Location not set'}</span>}
                <span style={{ padding: '2px 10px', borderRadius: 100, fontSize: 11, fontWeight: 700, background: active ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.05)', color: active ? '#22c55e' : '#71717a', border: `1px solid ${active ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.08)'}` }}>
                  {active ? '● ONLINE' : '○ OFFLINE'}
                </span>
                <span style={{ padding: '2px 10px', borderRadius: 100, fontSize: 11, fontWeight: 700, background: docker ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)', color: docker ? '#22c55e' : '#ef4444', border: `1px solid ${docker ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)'}` }}>
                  🐳 {docker ? 'Docker OK' : 'Docker Stopped'}
                </span>
              </div>
            </div>
          </div>

          {/* Center: Score */}
          <div style={{ textAlign: 'center', flexShrink: 0, padding: '0 32px', borderLeft: '1px solid rgba(255,255,255,0.07)', borderRight: '1px solid rgba(255,255,255,0.07)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 6 }}>C3 Performance Score</div>
            <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: '-2px', lineHeight: 1, background: 'linear-gradient(135deg, #f8fafc, #71717a)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
              {score ? score.toLocaleString() : '—'}
            </div>
            <div style={{ marginTop: 10, width: 160, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 100, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 100, width: `${(score/10000)*100}%`, background: 'linear-gradient(90deg,rgba(255,255,255,0.3),rgba(255,255,255,0.9))', transition: 'width 1s cubic-bezier(.16,1,.3,1)' }} />
            </div>
          </div>

          {/* Right: controls */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-end', flexShrink: 0 }}>
            {registered && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 13, color: '#71717a' }}>{active ? 'Go Offline' : 'Go Online'}</div>
                <Toggle on={active} onToggle={toggleActive} />
              </div>
            )}
            <button className="btn btn-ghost" onClick={runBench} disabled={benching} style={{ fontSize: 13 }}>
              {benching
                ? <><div style={{ width: 16, height: 16, border: '2px solid rgba(255,255,255,0.15)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> Running…</>
                : '⚡ Run Benchmark'}
            </button>
          </div>
        </div>
      </div>

      {/* ── MAIN BODY ── */}
      <div style={{ flex: 1, padding: '20px 32px 28px', display: 'flex', flexDirection: 'column', gap: 18, overflow: 'hidden' }}>

        {/* Hardware Cards Row */}
        <div style={{ display: 'flex', gap: 14, flexShrink: 0 }}>
          <HardwareCard icon="⚙️" label="CPU" value={cpuShort} sub={specs ? `${specs.cpuCores} Cores` : 'Detecting…'} />
          <HardwareCard icon="🧠" label="RAM" value={specs ? `${specs.totalRamGB} GB` : '…'} sub="System Memory" />
          <HardwareCard icon="🎮" label="GPU" value={specs?.gpuName || 'No GPU Detected'} sub={specs?.gpuVram || ''} color={specs?.hasCuda ? '#22c55e' : '#fff'} />
          <HardwareCard icon="💿" label="OS" value={specs?.os?.split(' ').slice(0,3).join(' ') || '…'} sub={specs?.arch || ''} />
        </div>

        {/* ── Bottom section: fills remaining space ── */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>

          {/* PENDING REQUESTS (if any) */}
          {pending.length > 0 && (
            <div style={{ flexShrink: 0 }}>
              {pending.map(req => (
                <div key={req.sessionId} style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderLeft: '4px solid #f59e0b', borderRadius: 16, padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6 }}>⚡ Incoming Session Request</div>
                    <div style={{ fontSize: 13, color: '#a1a1aa', display: 'flex', gap: 16 }}>
                      <span>👤 {req.userId?.slice(0,16)}…</span>
                      <span>🐳 {req.environment || 'base'}</span>
                      <span>💻 {req.cpuCores}c / {req.ramGb}GB RAM</span>
                      <span>⏱ {req.durationHours}h</span>
                      {req.cudaRequested && <span style={{ color: '#22c55e' }}>CUDA ✓</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 13 }}
                      onClick={() => setChatTarget({ userId: req.userId, displayName: req.userId?.slice(0,10) + '…' })}>
                      💬 Chat
                    </button>
                    <button className="btn btn-ghost" onClick={() => declineReq(req)}>Decline</button>
                    <button className="btn btn-primary" onClick={() => acceptReq(req)}>Accept Session →</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ACTIVE SESSION */}
          {activeSession ? (
            <div style={{ flex: 1, background: 'rgba(34,197,94,0.04)', border: '1px solid rgba(34,197,94,0.15)', borderRadius: 24, padding: '28px 32px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 22, letterSpacing: '-0.5px' }}>Active Session Running</div>
                  <div style={{ fontSize: 14, color: '#71717a', marginTop: 4 }}>User is connected • {activeSession.environment || 'base'} environment</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                  <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 700, color: '#22c55e' }}>{fmt(elapsed)}</div>
                  <button className="btn btn-danger" onClick={endSession}>End Session</button>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                {[
                  { label: 'CPU Usage', val: live.cpuLoad, unit: '%', sub: `${live.cpuLoad}% utilization`, color: 'green' },
                  { label: 'RAM Usage', val: live.ramPct, unit: '%', sub: `${live.ramUsedGB} / ${live.ramTotalGB} GB used`, color: 'amber' },
                ].map(s => (
                  <div key={s.label} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 16, padding: '18px 20px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ fontSize: 13, color: '#a1a1aa', fontWeight: 600 }}>{s.label}</span>
                      <span style={{ fontWeight: 800, fontSize: 18 }}>{s.val}{s.unit}</span>
                    </div>
                    <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 100, overflow: 'hidden' }}>
                      <div className={`pbar-fill ${s.color}`} style={{ width: `${s.val}%`, height: '100%', transition: 'width 1s ease' }} />
                    </div>
                    <div style={{ fontSize: 11, color: '#52525b', marginTop: 8 }}>{s.sub}</div>
                  </div>
                ))}
              </div>
            </div>

          ) : !registered ? (
            /* REGISTER FORM */
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: '100%', maxWidth: 640, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 24, padding: '40px 44px' }}>
                <div style={{ marginBottom: 32 }}>
                  <div style={{ fontWeight: 900, fontSize: 26, letterSpacing: '-0.8px', marginBottom: 8 }}>Register Your Node</div>
                  <div style={{ fontSize: 15, color: '#71717a', lineHeight: 1.6 }}>Set a name for your node so users can find it in the marketplace. You'll start earning C3 credits for every accepted session.</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.9px', marginBottom: 8 }}>Node Display Name</div>
                    <input className="input" style={{ fontSize: 16, padding: '14px 16px' }} placeholder="e.g. Aniketh's RTX Beast" value={profile.displayName} onChange={e => setProfile(p => ({ ...p, displayName: e.target.value }))} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.9px', marginBottom: 8 }}>Location</div>
                    <input className="input" style={{ fontSize: 16, padding: '14px 16px' }} placeholder="e.g. Mumbai, India" value={profile.location} onChange={e => setProfile(p => ({ ...p, location: e.target.value }))} />
                  </div>
                  <button className="btn btn-primary" style={{ fontSize: 15, padding: '14px 28px', marginTop: 8, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 10 }} onClick={handleRegister} disabled={registering || !profile.displayName.trim()}>
                    {registering ? <div style={{ width: 18, height: 18, border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#000', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} /> : '🚀'}
                    Register My Node → Earn Credits
                  </button>
                </div>
              </div>
            </div>

          ) : (
            /* REGISTERED, IDLE STATE */
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ textAlign: 'center', maxWidth: 480 }}>
                <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, margin: '0 auto 24px' }}>
                  {active ? '📡' : '💤'}
                </div>
                <div style={{ fontWeight: 800, fontSize: 22, letterSpacing: '-0.5px', marginBottom: 10 }}>
                  {active ? 'Listening for requests…' : 'Node is Offline'}
                </div>
                <div style={{ fontSize: 14, color: '#71717a', lineHeight: 1.6, marginBottom: 28 }}>
                  {active
                    ? 'Your node is visible in the marketplace. Incoming session requests will appear here automatically.'
                    : 'Toggle the switch in the header to go online and start accepting compute sessions.'}
                </div>
                {active && (
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                    {[`⚙️ ${specs?.cpuCores || '?'} CPU Cores`, `🧠 ${specs?.totalRamGB || '?'} GB RAM`, specs?.gpuName ? `🎮 ${specs.gpuName.split(' ').slice(-2).join(' ')}` : null].filter(Boolean).map(t => (
                      <span key={t} style={{ padding: '6px 14px', borderRadius: 100, fontSize: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#a1a1aa' }}>{t}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes shimmerLine { 0%,100%{transform:translateX(-100%);opacity:0} 50%{transform:translateX(100%);opacity:1} }
        @keyframes greenPulse { 0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,0.5)} 70%{box-shadow:0 0 0 8px rgba(34,197,94,0)} }
      `}</style>

      {/* Chat panel with this session's user */}
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

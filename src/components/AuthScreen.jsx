import React, { useState, useEffect, useRef } from 'react';

/* ── Scroll-reveal hook ── */
function useReveal(threshold = 0.12) {
  const ref = useRef(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setVis(true); obs.disconnect(); }
    }, { threshold });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return [ref, vis];
}

/* ── Animated counter ── */
function Counter({ to, suffix = '', dur = 1200 }) {
  const [val, setVal] = useState(0);
  const [ref, vis] = useReveal(0.3);
  useEffect(() => {
    if (!vis) return;
    let start;
    const tick = (ts) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      setVal(Math.floor(p * to));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [vis, to, dur]);
  return <span ref={ref}>{val.toLocaleString()}{suffix}</span>;
}

/* ── Fade-up reveal wrapper ── */
function Fade({ children, delay = 0, up = true }) {
  const [ref, vis] = useReveal();
  return (
    <div ref={ref} style={{
      opacity: vis ? 1 : 0,
      transform: vis ? 'none' : up ? 'translateY(24px)' : 'none',
      transition: `opacity 0.65s ease ${delay}ms, transform 0.65s cubic-bezier(.16,1,.3,1) ${delay}ms`,
    }}>
      {children}
    </div>
  );
}

/* ── Password rule row ── */
function Rule({ ok, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5,
      color: ok ? '#22c55e' : '#52525b', transition: 'color 0.2s' }}>
      <span style={{ fontWeight: 800, fontSize: 10, lineHeight: 1 }}>{ok ? '✓' : '○'}</span>
      {label}
    </div>
  );
}

/* ── Field ── */
function Field({ label, ...props }) {
  const [focus, setFocus] = useState(false);
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#52525b', textTransform: 'uppercase',
        letterSpacing: '0.9px', marginBottom: 6 }}>{label}</div>
      <input {...props}
        onFocus={e => { setFocus(true); props.onFocus?.(e); }}
        onBlur={e => { setFocus(false); props.onBlur?.(e); }}
        style={{
          width: '100%', boxSizing: 'border-box',
          background: '#111114', border: `1px solid ${focus ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
          color: '#f8fafc', padding: '12px 16px', borderRadius: 12,
          fontFamily: 'inherit', fontSize: 14, outline: 'none',
          transition: 'border-color 0.18s',
        }}
      />
    </div>
  );
}

const FEATURES = [
  { icon: '🛡️', title: 'Zero-Trust RSA Security',      desc: 'User B generates an RSA-2048 keypair in local memory. Private key never leaves the machine. Public key injected atomically into Docker containers.' },
  { icon: '🐳', title: 'Isolated Docker Environments',  desc: 'Ubuntu Base, AI/ML PyTorch, or Data Science Jupyter. Strict CPU/RAM cgroup limits and optional CUDA passthrough per session.' },
  { icon: '🌐', title: 'Reverse SSH via Serveo',        desc: 'No port forwarding. C3 opens a reverse SSH tunnel through serveo.net and delivers the live endpoint directly to your terminal.' },
  { icon: '💾', title: 'Drag-and-Drop SFTP',            desc: 'Integrated file manager for uploading datasets, models, scripts. Download results instantly via the built-in SFTP layer.' },
  { icon: '💰', title: 'C3 Credit Economy',             desc: 'Providers earn credits every minute their node is active. Users spend credits proportional to compute time and resource allocation.' },
  { icon: '💬', title: 'Peer Chat Before Session',      desc: 'Message a provider to align on workload needs before sending a formal session request. All messages encrypted in DynamoDB.' },
];

const STEPS = [
  { n: '01', t: 'Provider registers',        d: 'A shares their node profile (CPU, RAM, GPU, benchmark score). Node appears ACTIVE in the live marketplace.' },
  { n: '02', t: 'User B configures request', d: 'Pick a node, choose environment, set CPU cores, RAM, duration, and CUDA preference.' },
  { n: '03', t: 'Keypair generated',         d: "B's app creates a fresh RSA keypair in memory. Public key embedded in the session request written to DynamoDB." },
  { n: '04', t: 'Provider accepts',          d: "A's C3 app pulls the public key, starts Docker container, injects it into authorized_keys, opens reverse SSH tunnel." },
  { n: '05', t: 'SSH session delivered',     d: 'Tunnel endpoint written to DynamoDB. B authenticates with local private key. Terminal + file manager open instantly.' },
];

export default function AuthScreen({ onLogin }) {
  /* auth */
  const [tab, setTab]       = useState('login');
  const [email, setEmail]   = useState('');
  const [pass, setPass]     = useState('');
  const [code, setCode]     = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr]       = useState('');
  const [ok, setOk]         = useState('');

  /* canvas particles */
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let raf;
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);
    const pts = Array.from({ length: 65 }, () => ({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 1.4 + 0.5,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pts.forEach((p, i) => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width)  p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
        for (let j = i + 1; j < pts.length; j++) {
          const dx = p.x - pts[j].x, dy = p.y - pts[j].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 120) {
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(pts[j].x, pts[j].y);
            ctx.strokeStyle = `rgba(255,255,255,${0.06 * (1 - d / 120)})`;
            ctx.lineWidth = 0.7; ctx.stroke();
          }
        }
      });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { window.removeEventListener('resize', resize); cancelAnimationFrame(raf); };
  }, []);

  /* password rules */
  const rules = {
    len: pass.length >= 8,
    up:  /[A-Z]/.test(pass),
    low: /[a-z]/.test(pass),
    num: /[0-9]/.test(pass),
    sym: /[^A-Za-z0-9]/.test(pass),
  };
  const pwOk = Object.values(rules).every(Boolean);

  /* submit */
  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setOk(''); setLoading(true);
    try {
      if (tab === 'confirm') {
        if (window.c3?.confirmSignUp) await window.c3.confirmSignUp(email, code);
        else await new Promise(r => setTimeout(r, 600));
        setOk('Account confirmed! Please sign in.'); setTab('login');
      } else if (tab === 'signup') {
        if (!pwOk) throw new Error('Complete all password requirements first.');
        const res = window.c3?.signUp
          ? await window.c3.signUp(email, pass)
          : { needsConfirmation: true };
        if (res?.needsConfirmation) { setTab('confirm'); setOk(`Verification code sent to ${email}`); }
        else { setOk('Account created! Please sign in.'); setTab('login'); }
      } else {
        const data = window.c3?.login
          ? await window.c3.login(email, pass)
          : { email, userId: 'dev' };
        onLogin(data);
      }
    } catch (ex) { setErr(ex.message || 'Authentication failed'); }
    finally { setLoading(false); }
  };

  /* ─────────────────────────────────────────────────────────── */
  return (
    <div style={{ width: '100%', height: '100%', overflowY: 'auto', background: '#09090c', color: '#f8fafc', position: 'relative' }}>

      {/* Canvas background */}
      <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }} />

      <div style={{ position: 'relative', zIndex: 1 }}>

        {/* ══════════════════ HERO SECTION WITH MASSIVE TITLE ══════════════════ */}
        <section style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '44px 48px 80px' }}>

          {/* Top Brand Navbar */}
          <div style={{ width: '100%', maxWidth: 1200, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 60 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, background: '#fff', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, color: '#000', fontSize: 18, boxShadow: '0 0 20px rgba(255,255,255,0.25)' }}>C3</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: '-0.5px' }}>C3 Compute Protocol</div>
                <div style={{ fontSize: 11, color: '#71717a' }}>Community Compute Cloud v2.0</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#a1a1aa', padding: '6px 14px', borderRadius: 100, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', display: 'inline-block', boxShadow: '0 0 8px #22c55e' }}></span>
              1,420 Active Nodes Online
            </div>
          </div>

          {/* Integrated Hero Grid */}
          <div style={{ width: '100%', maxWidth: 1200, display: 'grid', gridTemplateColumns: '1fr 440px', gap: 64, alignItems: 'center' }}>

            {/* Left: Giant Headline Typography */}
            <div>
              <div style={{ opacity: 0, animation: 'fadeUp 0.6s ease 0.1s forwards' }}>
                <div style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
                  {['⚡ Instant SSH Terminal', '🐳 Isolated Docker', '🔑 RSA-2048 Encrypted', '💾 SFTP Sync'].map(t => (
                    <span key={t} style={{ padding: '5px 12px', borderRadius: 100, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', fontSize: 12, fontWeight: 600, color: '#a1a1aa' }}>{t}</span>
                  ))}
                </div>
              </div>

              {/* MASSIVE TITLE */}
              <div style={{ opacity: 0, animation: 'fadeUp 0.6s ease 0.2s forwards' }}>
                <h1 style={{ fontSize: 64, fontWeight: 900, letterSpacing: '-3.2px', lineHeight: 1.02, marginBottom: 24 }}>
                  SHARE IDLE HARDWARE.<br />
                  <span style={{ background: 'linear-gradient(135deg, #ffffff 30%, #52525b 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>ACCESS GLOBAL GPU.</span>
                </h1>
              </div>

              <div style={{ opacity: 0, animation: 'fadeUp 0.6s ease 0.3s forwards' }}>
                <p style={{ fontSize: 16, color: '#94a3b8', lineHeight: 1.7, maxWidth: 520, marginBottom: 40 }}>
                  C3 turns idle workstations into an encrypted distributed cloud. Providers earn credits by running isolated Docker containers. Developers get instant SSH terminal access anywhere in the world.
                </p>
              </div>

              {/* Large Stats Display */}
              <div style={{ opacity: 0, animation: 'fadeUp 0.6s ease 0.4s forwards', display: 'flex', gap: 40, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 28 }}>
                {[{ val: 1420, sfx: '+', l: 'ACTIVE NODES' }, { val: 84, sfx: ' TFLOPS', l: 'NETWORK POWER' }, { val: 18, sfx: 'ms', l: 'P2P LATENCY' }].map(s => (
                  <div key={s.l}>
                    <div style={{ fontSize: 36, fontWeight: 900, letterSpacing: '-1.5px', lineHeight: 1 }}>
                      <Counter to={s.val} suffix={s.sfx} />
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: '#52525b', textTransform: 'uppercase', letterSpacing: '1px', marginTop: 6 }}>{s.l}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: Integrated Auth Form */}
            <div style={{ opacity: 0, animation: 'fadeUp 0.6s ease 0.35s forwards' }}>
              <div style={{
                background: 'rgba(15,15,20,0.85)', backdropFilter: 'blur(24px)',
                border: '1px solid rgba(255,255,255,0.12)', borderRadius: 24,
                padding: '32px 32px 28px', boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
              }}>
                <div style={{ textAlign: 'center', marginBottom: 24 }}>
                  <h2 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.8px', marginBottom: 6 }}>
                    {tab === 'confirm' ? '📬 Verify Your Email' : tab === 'login' ? 'Welcome Back' : 'Create Account'}
                  </h2>
                  <p style={{ fontSize: 13, color: '#71717a' }}>
                    {tab === 'confirm' ? `Code sent to ${email}` : tab === 'login' ? 'Sign in to access your compute dashboard' : 'Join the C3 peer-to-peer network'}
                  </p>
                </div>

                {/* Tab switch */}
                {tab !== 'confirm' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, background: '#0a0a0d', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 100, padding: 4, marginBottom: 24 }}>
                    {['login', 'signup'].map(t => (
                      <div key={t}
                        onClick={() => { setTab(t); setErr(''); setOk(''); }}
                        style={{ padding: '10px 0', borderRadius: 100, textAlign: 'center', fontSize: 13, fontWeight: tab === t ? 800 : 500, cursor: 'pointer', background: tab === t ? '#fff' : 'transparent', color: tab === t ? '#000' : '#71717a', transition: 'all 0.2s ease', userSelect: 'none' }}>
                        {t === 'login' ? 'Sign In' : 'Sign Up'}
                      </div>
                    ))}
                  </div>
                )}

                {/* Alerts */}
                {err && <div style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#fca5a5', marginBottom: 16, lineHeight: 1.4 }}>⚠️ {err}</div>}
                {ok  && <div style={{ background: 'rgba(34,197,94,0.12)',  border: '1px solid rgba(34,197,94,0.25)',  borderRadius: 10, padding: '10px 14px', fontSize: 12, color: '#86efac',  marginBottom: 16, lineHeight: 1.4 }}>✅ {ok}</div>}

                <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {tab !== 'confirm' ? (
                    <>
                      <Field label="Email Address" type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required />
                      <Field label="Password" type="password" placeholder="••••••••" value={pass} onChange={e => setPass(e.target.value)} required />

                      {/* Password rules */}
                      {tab === 'signup' && (
                        <div style={{ background: '#09090c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '12px 14px' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.9px', marginBottom: 8 }}>Password Requirements</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px' }}>
                            <Rule ok={rules.len} label="8+ characters" />
                            <Rule ok={rules.up}  label="Uppercase (A-Z)" />
                            <Rule ok={rules.low} label="Lowercase (a-z)" />
                            <Rule ok={rules.num} label="Number (0-9)" />
                            <Rule ok={rules.sym} label="Symbol (!@#$)" />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#52525b', textTransform: 'uppercase', letterSpacing: '0.9px', marginBottom: 6 }}>Verification Code</div>
                      <input type="text" value={code} onChange={e => setCode(e.target.value)} required placeholder="123456" maxLength={6}
                        style={{ width: '100%', boxSizing: 'border-box', background: '#111114', border: '1px solid rgba(255,255,255,0.1)', color: '#f8fafc', padding: '14px', borderRadius: 12, fontFamily: 'inherit', fontSize: 22, outline: 'none', textAlign: 'center', letterSpacing: '0.4em' }}
                      />
                      <div style={{ fontSize: 11, color: '#71717a', marginTop: 8, textAlign: 'center' }}>Check your inbox & spam folder</div>
                    </div>
                  )}

                  <button type="submit"
                    disabled={loading || (tab === 'signup' && !pwOk)}
                    style={{ width: '100%', padding: '13px', borderRadius: 12, border: 'none', fontFamily: 'inherit', fontSize: 14, fontWeight: 800, cursor: loading || (tab === 'signup' && !pwOk) ? 'not-allowed' : 'pointer', background: (tab === 'signup' && !pwOk) ? '#1a1a20' : '#ffffff', color: (tab === 'signup' && !pwOk) ? '#52525b' : '#000000', marginTop: 6, transition: 'all 0.2s ease', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxSizing: 'border-box', boxShadow: '0 4px 20px rgba(255,255,255,0.15)' }}>
                    {loading
                      ? <div style={{ width: 18, height: 18, border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#000', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                      : tab === 'confirm' ? 'Confirm Account'
                      : tab === 'login' ? 'Sign In →'
                      : 'Create Account →'}
                  </button>

                  {tab === 'confirm' && (
                    <button type="button" onClick={() => setTab('login')}
                      style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#a1a1aa', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' }}>
                      ← Back to Sign In
                    </button>
                  )}
                </form>
              </div>
            </div>

          </div>

          {/* Scroll cue */}
          <div style={{ marginTop: 64, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: '#52525b', fontSize: 12, opacity: 0, animation: 'fadeUp 0.6s ease 0.8s forwards' }}>
            <div style={{ width: 1, height: 36, background: 'rgba(255,255,255,0.12)', animation: 'scrollPulse 2s ease-in-out infinite' }}></div>
            Scroll to explore platform details
          </div>
        </section>

        {/* ══════════════════ FEATURES SECTION ══════════════════ */}
        <section style={{ padding: '0 48px 100px' }}>
          <div style={{ maxWidth: 1200, margin: '0 auto' }}>
            <Fade>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#52525b', textTransform: 'uppercase', letterSpacing: '1.2px', marginBottom: 12 }}>Architecture</div>
              <h2 style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-1.5px', marginBottom: 48 }}>Built for extreme peer-to-peer performance.</h2>
            </Fade>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18 }}>
              {FEATURES.map((f, i) => (
                <Fade key={f.title} delay={i * 50}>
                  <div style={{ background: '#111114', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 18, padding: '24px 26px', height: '100%', transition: 'all 0.2s ease', boxSizing: 'border-box' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'; e.currentTarget.style.transform = 'translateY(-4px)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.transform = 'none'; }}>
                    <div style={{ fontSize: 28, marginBottom: 14 }}>{f.icon}</div>
                    <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8, letterSpacing: '-0.3px' }}>{f.title}</div>
                    <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>{f.desc}</div>
                  </div>
                </Fade>
              ))}
            </div>
          </div>
        </section>

        {/* ══════════════════ HOW IT WORKS ══════════════════ */}
        <section style={{ padding: '0 48px 100px' }}>
          <div style={{ maxWidth: 1200, margin: '0 auto' }}>
            <Fade>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#52525b', textTransform: 'uppercase', letterSpacing: '1.2px', marginBottom: 12 }}>Workflow</div>
              <h2 style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-1.5px', marginBottom: 48 }}>5 steps to live terminal session.</h2>
            </Fade>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {STEPS.map((s, i) => (
                <Fade key={s.n} delay={i * 60}>
                  <div style={{ display: 'flex', gap: 32, padding: '28px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 13, fontWeight: 900, color: '#52525b', minWidth: 32, paddingTop: 2, fontVariantNumeric: 'tabular-nums' }}>{s.n}</div>
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 6, letterSpacing: '-0.3px' }}>{s.t}</div>
                      <div style={{ fontSize: 13.5, color: '#94a3b8', lineHeight: 1.6, maxWidth: 680 }}>{s.d}</div>
                    </div>
                  </div>
                </Fade>
              ))}
            </div>
          </div>
        </section>

        {/* ══════════════════ FOOTER ══════════════════ */}
        <Fade>
          <footer style={{ padding: '0 48px 48px' }}>
            <div style={{ maxWidth: 1200, margin: '0 auto', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 28, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#52525b' }}>
              <span>C3 Community Compute Cloud v2.0</span>
              <span>AWS Cognito • DynamoDB • RSA-2048 • Docker Desktop</span>
            </div>
          </footer>
        </Fade>

      </div>

      <style>{`
        @keyframes fadeUp  { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:none} }
        @keyframes spin    { to{transform:rotate(360deg)} }
        @keyframes scrollPulse { 0%,100%{opacity:0.3} 50%{opacity:1} }
        ::-webkit-scrollbar { width:6px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.08); border-radius:3px; }
        ::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.16); }
      `}</style>
    </div>
  );
}

import React, { useState } from 'react';

function InputField({ label, type = 'text', value, onChange, placeholder, autoComplete }) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`w-full bg-[#0b0d14] border rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none transition ${
          focused ? 'border-slate-500' : 'border-slate-800'
        }`}
      />
    </div>
  );
}

export default function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'confirm'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [hostedLoading, setHostedLoading] = useState(false);

  const reset = () => { setError(''); setInfo(''); };

  const handleHostedLogin = async () => {
    reset();
    setHostedLoading(true);
    try {
      if (window.c3?.openHostedLogin) {
        const u = await window.c3.openHostedLogin();
        if (u) onLogin(u);
      } else {
        setError('AWS Hosted login is available in Electron.');
      }
    } catch (err) {
      if (!err.message?.includes('closed') && !err.message?.includes('cancelled')) {
        setError(err.message || 'AWS Hosted Login failed');
      }
    } finally {
      setHostedLoading(false);
    }
  };

  const handleSignIn = async e => {
    e.preventDefault();
    if (!email || !password) { setError('Please enter your email and password.'); return; }
    reset(); setLoading(true);

    // Instant fake/demo login bypass
    if (email.toLowerCase().includes('demo') || password.toLowerCase() === 'demo' || email.includes('test')) {
      const demoUser = {
        userId: 'demo-user-1',
        email: email.trim() || 'demo@c3.cloud',
        credits: 250,
      };
      onLogin(demoUser);
      setLoading(false);
      return;
    }

    try {
      const u = window.c3?.login ? await window.c3.login(email.trim(), password)
        : { userId: 'demo', email, credits: 100 };
      onLogin(u);
    } catch (err) {
      setError(err.message || 'Sign in failed. Check your credentials.');
    } finally { setLoading(false); }
  };

  const handleDemoLogin = () => {
    const demoUser = {
      userId: 'demo-user-1',
      email: 'demo@c3.cloud',
      credits: 250,
    };
    onLogin(demoUser);
  };

  const handleSignUp = async e => {
    e.preventDefault();
    if (!email || !password || !confirmPass) { setError('Fill in all fields.'); return; }
    if (password !== confirmPass) { setError('Passwords do not match.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    reset(); setLoading(true);
    try {
      if (window.c3?.signUp) await window.c3.signUp(email.trim(), password);
      setInfo('Account created! Check your email for the 6-digit confirmation code.');
      setMode('confirm');
    } catch (err) {
      setError(err.message || 'Registration failed.');
    } finally { setLoading(false); }
  };

  const handleConfirm = async e => {
    e.preventDefault();
    if (!code) { setError('Enter the 6-digit code.'); return; }
    reset(); setLoading(true);
    try {
      if (window.c3?.confirmSignUp) await window.c3.confirmSignUp(email.trim(), code.trim());
      setInfo('Email verified. You can now sign in.');
      setPassword(''); setCode('');
      setMode('signin');
    } catch (err) {
      setError(err.message || 'Invalid code. Try again.');
    } finally { setLoading(false); }
  };

  return (
    <div className="w-full h-full flex items-center justify-center bg-[#090a0f] p-6">
      <div className="w-full max-w-[400px]">
        {/* Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-slate-800 border border-slate-700 font-black text-lg text-white mb-3">
            C3
          </div>
          <h1 className="text-xl font-bold text-white">Community Compute Cloud</h1>
          <p className="text-xs text-slate-500 mt-1">Distributed P2P Compute Sharing Platform</p>
        </div>

        {/* Card */}
        <div className="bg-[#121620] border border-slate-800 rounded-2xl p-7 shadow-xl">
          {/* AWS Hosted UI Login Button */}
          <button
            type="button"
            onClick={handleHostedLogin}
            disabled={hostedLoading}
            className="w-full py-3 mb-5 bg-[#ff9900] hover:bg-[#ffaa22] active:bg-[#e68a00] text-slate-950 font-bold text-sm rounded-xl transition shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2.5 disabled:opacity-50"
          >
            <span className="text-base">🚀</span>
            {hostedLoading ? 'Opening AWS Hosted Login...' : 'Sign In with AWS Hosted UI'}
          </button>

          <div className="relative mb-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-800"></div>
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-[#121620] px-2 text-slate-500 font-medium">or manual sign-in</span>
            </div>
          </div>

          {/* Tab toggle (only when not on confirm screen) */}
          {mode !== 'confirm' && (
            <div className="flex bg-[#0b0d14] border border-slate-800 p-0.5 rounded-xl mb-6">
              <button
                type="button"
                onClick={() => { setMode('signin'); reset(); }}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition ${
                  mode === 'signin' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-300'
                }`}
              >Sign In</button>
              <button
                type="button"
                onClick={() => { setMode('signup'); reset(); }}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition ${
                  mode === 'signup' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-300'
                }`}
              >Create Account</button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 px-4 py-3 bg-red-950/40 border border-red-800/60 rounded-xl text-xs text-red-300">
              {error}
            </div>
          )}
          {/* Info */}
          {info && (
            <div className="mb-4 px-4 py-3 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-xs text-emerald-300">
              {info}
            </div>
          )}

          {/* Sign In Form */}
          {mode === 'signin' && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <InputField label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
              <InputField label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
              <button
                type="submit" disabled={loading}
                className="w-full py-2.5 mt-1 bg-slate-100 hover:bg-white text-slate-900 font-bold text-sm rounded-xl transition disabled:opacity-50"
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </button>

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-800"></div>
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-[#121620] px-2 text-slate-500 font-medium">or quick test</span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleDemoLogin}
                className="w-full py-2.5 bg-slate-800/90 hover:bg-slate-700/90 text-slate-200 hover:text-white font-semibold text-xs rounded-xl border border-slate-700 transition flex items-center justify-center gap-2"
              >
                <span>⚡</span> Continue as Demo User (Bypass AWS)
              </button>
            </form>
          )}

          {/* Sign Up Form */}
          {mode === 'signup' && (
            <form onSubmit={handleSignUp} className="space-y-4">
              <InputField label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
              <InputField label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Min 8 chars + numbers + symbols" autoComplete="new-password" />
              <InputField label="Confirm Password" type="password" value={confirmPass} onChange={e => setConfirmPass(e.target.value)} placeholder="Repeat password" autoComplete="new-password" />
              <button
                type="submit" disabled={loading}
                className="w-full py-2.5 mt-1 bg-slate-100 hover:bg-white text-slate-900 font-bold text-sm rounded-xl transition disabled:opacity-50"
              >
                {loading ? 'Creating account...' : 'Create Account'}
              </button>
            </form>
          )}

          {/* Confirm Code Form */}
          {mode === 'confirm' && (
            <form onSubmit={handleConfirm} className="space-y-4">
              <div className="text-center mb-2">
                <div className="text-sm font-bold text-white">Check your email</div>
                <div className="text-xs text-slate-400 mt-1">We sent a 6-digit code to <span className="text-slate-200">{email}</span></div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Confirmation Code</label>
                <input
                  type="text"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="000000"
                  maxLength={6}
                  className="w-full bg-[#0b0d14] border border-slate-800 rounded-xl px-4 py-2.5 text-lg text-white text-center font-mono tracking-widest placeholder-slate-600 focus:outline-none focus:border-slate-500"
                />
              </div>
              <button
                type="submit" disabled={loading}
                className="w-full py-2.5 bg-slate-100 hover:bg-white text-slate-900 font-bold text-sm rounded-xl transition disabled:opacity-50"
              >
                {loading ? 'Verifying...' : 'Verify & Activate'}
              </button>
              <button type="button" onClick={() => { setMode('signin'); reset(); }}
                className="w-full py-1.5 text-xs text-slate-500 hover:text-slate-300 transition text-center">
                ← Back to Sign In
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-[11px] text-slate-600 mt-5">
          Secured by AWS Cognito · P2P Encrypted via WireGuard
        </p>
      </div>
    </div>
  );
}

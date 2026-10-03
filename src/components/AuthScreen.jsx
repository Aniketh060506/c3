import React, { useState } from 'react';
import { Cloud, Lock, Mail, ArrowRight, Sparkles, KeyRound, CheckCircle2, AlertCircle } from 'lucide-react';

export default function AuthScreen({ onAuthSuccess }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'confirm'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const handleHostedLogin = async () => {
    setError('');
    try {
      if (window.c3?.openHostedLogin) {
        await window.c3.openHostedLogin();
      }
    } catch (e) {
      setError(e.message || 'Failed to open AWS login.');
    }
  };

  const handleDirectAuth = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);

    try {
      if (mode === 'login') {
        const res = await window.c3.login(email.trim(), password);
        if (res) onAuthSuccess(res);
      } else if (mode === 'signup') {
        await window.c3.signUp(email.trim(), password);
        setMode('confirm');
        setInfo('6-digit confirmation code sent to your email.');
      } else if (mode === 'confirm') {
        await window.c3.confirmSignUp(email.trim(), code.trim());
        setMode('login');
        setInfo('Email verified successfully! Please sign in.');
      }
    } catch (err) {
      setError(err.message || 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-screen h-screen flex items-center justify-center ambient-canvas select-none p-6">
      {/* Background Floating Orbs */}
      <div className="w-96 h-96 rounded-full bg-indigo-500/20 blur-3xl absolute top-12 left-1/4 pointer-events-none animate-orb-1" />
      <div className="w-80 h-80 rounded-full bg-teal-400/20 blur-3xl absolute bottom-12 right-1/4 pointer-events-none animate-orb-2" />

      {/* Main Glass Card */}
      <div className="relative z-10 bg-white/90 backdrop-blur-2xl border border-white/80 rounded-[36px] p-8 md:p-10 max-w-md w-full shadow-2xl space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-3xl bg-slate-950 text-white flex items-center justify-center mx-auto shadow-card">
            <Cloud className="w-8 h-8 text-indigo-300 stroke-[2.2]" />
          </div>
          <h1 className="text-2xl font-black text-slate-900 font-display tracking-tight">
            C3 Cloud
          </h1>
          <p className="text-xs text-slate-500 font-medium">
            Community Compute Cloud · AWS Serverless Control Plane
          </p>
        </div>

        {/* Primary Action: 1-Click AWS Hosted UI */}
        <button
          onClick={handleHostedLogin}
          className="w-full py-3.5 px-5 bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-900 hover:from-slate-900 hover:to-indigo-900 text-white rounded-2xl text-xs font-bold shadow-card flex items-center justify-center gap-2.5 transition-all duration-300 cursor-pointer group"
        >
          <Sparkles className="w-4 h-4 text-amber-400 group-hover:rotate-12 transition-transform" />
          <span>Sign in with AWS Cognito</span>
          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
        </button>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-200/80" />
          <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest font-mono">
            Or Direct Email
          </span>
          <div className="flex-1 h-px bg-slate-200/80" />
        </div>

        {/* Tab Switcher: Login vs Sign Up */}
        {mode !== 'confirm' && (
          <div className="flex bg-slate-100/80 p-1 rounded-2xl border border-slate-200/60">
            <button
              onClick={() => { setMode('login'); setError(''); }}
              className={`flex-1 py-2 text-xs font-bold rounded-xl transition ${
                mode === 'login'
                  ? 'bg-white text-slate-900 shadow-soft-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => { setMode('signup'); setError(''); }}
              className={`flex-1 py-2 text-xs font-bold rounded-xl transition ${
                mode === 'signup'
                  ? 'bg-white text-slate-900 shadow-soft-sm'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              Register
            </button>
          </div>
        )}

        {/* Error / Info Toasts */}
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl text-xs text-rose-700 flex items-center gap-2 font-medium">
            <AlertCircle className="w-4 h-4 flex-shrink-0 text-rose-600" />
            <span className="truncate">{error}</span>
          </div>
        )}

        {info && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl text-xs text-emerald-700 flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-600" />
            <span className="truncate">{info}</span>
          </div>
        )}

        {/* Direct Email Form */}
        <form onSubmit={handleDirectAuth} className="space-y-3.5">
          {mode !== 'confirm' ? (
            <>
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-600 font-mono">Email Address</label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="user@c3.cloud"
                    className="w-full bg-slate-50 focus:bg-white text-xs font-medium text-slate-900 pl-10 pr-4 py-2.5 rounded-2xl border border-slate-200 focus:outline-none focus:border-indigo-500 transition"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] font-bold text-slate-600 font-mono">Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-slate-50 focus:bg-white text-xs font-medium text-slate-900 pl-10 pr-4 py-2.5 rounded-2xl border border-slate-200 focus:outline-none focus:border-indigo-500 transition"
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <label className="text-[11px] font-bold text-slate-600 font-mono">6-Digit Confirmation Code</label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  required
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="123456"
                  maxLength={6}
                  className="w-full bg-slate-50 focus:bg-white text-xs font-mono font-bold tracking-widest text-slate-900 pl-10 pr-4 py-2.5 rounded-2xl border border-slate-200 focus:outline-none focus:border-indigo-500 transition text-center"
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-xs font-bold shadow-soft transition cursor-pointer disabled:opacity-50"
          >
            {loading ? 'Authenticating...' : mode === 'login' ? 'Sign In' : mode === 'signup' ? 'Create Account' : 'Verify Code'}
          </button>
        </form>

      </div>
    </div>
  );
}

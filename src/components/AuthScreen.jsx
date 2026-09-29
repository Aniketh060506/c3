import React, { useState, useEffect } from 'react';
import iconImg from '../assets/icon.png';

export default function AuthScreen({ onLogin }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const launchAwsLogin = async () => {
    setError('');
    setLoading(true);
    try {
      if (window.c3?.openAwsLogin) {
        await window.c3.openAwsLogin();
      } else if (window.c3?.openHostedLogin) {
        const u = await window.c3.openHostedLogin();
        if (u) onLogin(u);
      } else {
        setError('AWS Login requires running inside the C3 desktop application.');
      }
    } catch (err) {
      if (!err.message?.includes('closed') && !err.message?.includes('cancelled')) {
        setError(err.message || 'AWS Login failed. Please retry.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Automatically trigger direct AWS login upon displaying this screen
    launchAwsLogin();
  }, []);

  return (
    <div className="w-full h-full flex items-center justify-center bg-slate-50 p-6 select-none">
      <div className="w-full max-w-[420px] text-center">
        {/* Brand */}
        <img src={iconImg} alt="C3 Cloud" className="w-24 h-24 object-contain mx-auto mb-4 drop-shadow-md" />
        <h1 className="text-2xl font-black text-slate-900 tracking-tight">Community Compute Cloud</h1>
        <p className="text-xs text-slate-500 mt-1 mb-6">Distributed Kubernetes &amp; P2P Hardware Mesh</p>

        {/* Card */}
        <div className="bg-white border border-slate-200/90 rounded-3xl p-8 shadow-xl space-y-5">
          <div className="space-y-2">
            <h2 className="text-base font-bold text-slate-800">Direct AWS Authentication</h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Sign in with your AWS Cognito account to join the compute mesh and manage cluster nodes.
            </p>
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-xs font-semibold text-red-700">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={launchAwsLogin}
            disabled={loading}
            className="w-full py-4 bg-[#ff9900] hover:bg-[#ffaa22] active:bg-[#e68a00] text-slate-950 font-black text-sm rounded-2xl transition shadow-lg shadow-amber-500/25 flex items-center justify-center gap-2.5 disabled:opacity-50 cursor-pointer"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-slate-900/30 border-t-slate-900 rounded-full animate-spin" />
                <span>Opening AWS Hosted Login...</span>
              </>
            ) : (
              <>
                <span className="text-base">🔐</span>
                <span>Sign In with AWS Cognito</span>
              </>
            )}
          </button>

          <p className="text-[11px] text-slate-400">
            Securely authenticated via Amazon Cognito &amp; DynamoDB
          </p>
        </div>
      </div>
    </div>
  );
}

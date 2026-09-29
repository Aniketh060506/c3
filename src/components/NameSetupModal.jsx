import React, { useState } from 'react';
import iconImg from '../assets/icon.png';

export default function NameSetupModal({ userEmail, defaultName, onSave }) {
  const [name, setName] = useState(defaultName || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const clean = (name || '').trim();
    if (!clean) {
      setError('Please enter a name for this machine.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (window.c3?.setName) {
        const res = await window.c3.setName(clean);
        onSave(res?.user || { displayName: clean, email: userEmail });
      } else {
        onSave({ displayName: clean, email: userEmail });
      }
    } catch (err) {
      setError(err.message || 'Failed to save machine name.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-6 select-none animate-in fade-in duration-200">
      <div className="bg-white border border-slate-200/90 rounded-3xl shadow-2xl max-w-md w-full p-8 space-y-6 text-slate-800">
        {/* Header Icon & Account Badge */}
        <div className="flex flex-col items-center text-center">
          <img src={iconImg} alt="C3 Cloud" className="w-20 h-20 object-contain mb-3 drop-shadow-md" />
          
          {userEmail && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 mb-2">
              <span>👤</span> {userEmail}
            </div>
          )}

          <h2 className="text-2xl font-black text-slate-900 tracking-tight">Name This Machine</h2>
          <p className="text-xs text-slate-500 mt-1.5 max-w-xs leading-relaxed">
            Give this machine a unique display name for your account (e.g. <span className="font-semibold text-slate-700">Rog-Laptop</span>, <span className="font-semibold text-slate-700">Workstation</span>) so you and your cluster nodes can identify it.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">
              Machine / Node Nickname
            </label>
            <input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="e.g. Rog-Zephyrus, Worker-Node-1"
              className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 focus:border-blue-600 focus:bg-white rounded-xl text-sm font-semibold text-slate-900 placeholder-slate-400 outline-none transition shadow-sm"
            />
            {error && (
              <p className="text-xs font-semibold text-rose-600 mt-2 flex items-center gap-1">
                <span>⚠️</span> {error}
              </p>
            )}
          </div>

          <div className="bg-slate-50/80 border border-slate-100 rounded-xl p-3 text-[11px] text-slate-500 flex items-center gap-2">
            <span className="text-emerald-600 font-bold">✓</span>
            <span>You can rename this machine anytime from the dashboard header.</span>
          </div>

          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="w-full py-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-2xl text-sm font-black transition shadow-lg shadow-blue-500/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Saving Machine Name...</span>
              </>
            ) : (
              <span>Confirm &amp; Launch App →</span>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

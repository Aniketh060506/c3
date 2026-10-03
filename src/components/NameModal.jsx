import React, { useState } from 'react';
import { Laptop, X } from 'lucide-react';

export default function NameModal({ currentName, onSave, onClose }) {
  const [name, setName] = useState(currentName || '');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (window.c3?.setName) {
        await window.c3.setName(name.trim());
      }
      onSave(name.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="diagnostic-dialog bg-white rounded-[26px] p-6 max-w-sm w-full shadow-2xl border border-slate-200 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <Laptop className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-extrabold text-slate-900 font-display">
              Name This Machine
            </h3>
          </div>
          <button
            onClick={onClose}
            className="icon-control w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-900"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-500 leading-relaxed">
          Give this node a recognizable name so other computers on your network or mesh can identify it.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Gaming-Rig-RTX or MacBook-Pro"
            className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-2.5 text-xs font-semibold text-slate-800 focus:border-indigo-500 focus:bg-white transition"
            autoFocus
          />

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-2xl transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="flex-1 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-2xl shadow-sm transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Name'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

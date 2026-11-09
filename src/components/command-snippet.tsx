import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CommandSnippet({ label, command, detail }: { label: string; command: string; detail?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return <div className="min-w-0 rounded-xl border border-border bg-white p-3 shadow-sm">
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="text-xs font-semibold">{label}</span>
      <button type="button" onClick={() => void copy()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-muted" aria-label={`Copy ${label}`}>
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy"}
      </button>
    </div>
    <code className="block overflow-x-auto whitespace-pre rounded-lg bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100">{command}</code>
    {detail && <p className="mt-2 text-xs text-muted-foreground">{detail}</p>}
  </div>;
}

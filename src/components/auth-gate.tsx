import { useEffect, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { Boxes, LoaderCircle, LogOut, ShieldCheck } from "lucide-react";
import { authService, isTauri, type AuthStatus } from "@/lib/platform";
import { Panel } from "@/components/kit";

export function AuthGate({ children }: { children: (props: { username: string; signOut: () => Promise<void> }) => ReactNode }) {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [listenersReady, setListenersReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setChecking(false);
      setError("Open ComputePool in its Windows desktop app to sign in with Amazon Cognito.");
      return;
    }
    let unlistenComplete: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let disposed = false;
    void Promise.all([
      listen<AuthStatus>("cognito-auth-complete", (event) => { setAuth(event.payload); setError(null); setBusy(false); }),
      listen<string>("cognito-auth-error", (event) => { setError(event.payload || "Cognito sign-in failed."); setBusy(false); }),
    ]).then(([complete, failed]) => {
      if (disposed) { complete(); failed(); return; }
      unlistenComplete = complete;
      unlistenError = failed;
    }).catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : "Could not prepare the Cognito sign-in callback."); }).finally(() => { if (!disposed) setListenersReady(true); });
    void authService.status()
      .then((status) => { if (!disposed) setAuth(status); })
      .catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : "Could not read the saved Cognito session."); })
      .finally(() => { if (!disposed) setChecking(false); });
    return () => { disposed = true; unlistenComplete?.(); unlistenError?.(); };
  }, []);

  const beginSignIn = async () => {
    setBusy(true);
    setError(null);
    try { await authService.beginHostedLogin(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not open Cognito sign-in."); setBusy(false); }
  };
  const signOut = async () => { await authService.signOut(); setAuth({ authenticated: false }); };

  if (checking) return <div className="grid min-h-screen place-items-center bg-background"><LoaderCircle className="size-6 animate-spin text-primary" /></div>;
  if (auth?.authenticated && auth.username) return children({ username: auth.displayName || auth.username, signOut });

  return <div className="grid min-h-screen place-items-center bg-background px-4 py-10"><Panel className="w-full max-w-md p-7">
    <div className="mb-6 flex items-center gap-3"><span className="grid size-11 place-items-center rounded-2xl bg-primary text-primary-foreground"><Boxes className="size-6" /></span><div><p className="font-display text-xl font-bold">ComputePool</p><p className="text-xs text-muted-foreground">Phase 1 · Cognito and desktop discovery</p></div></div>
    <div className="mb-5 flex items-start gap-3 rounded-2xl bg-muted p-4"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" /><div><h1 className="font-semibold">Sign in to your account</h1><p className="mt-1 text-sm text-muted-foreground">Amazon Cognito · ap-south-1</p></div></div>
    {error && <p role="alert" className="mb-4 whitespace-pre-line rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <button type="button" onClick={() => void beginSignIn()} disabled={busy || !isTauri() || !listenersReady} className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">{busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}{busy ? "Waiting for Cognito…" : "Continue with Amazon Cognito"}</button>
    <p className="mt-5 text-center text-[11px] text-muted-foreground">Your Cognito session stays in app memory until you close ComputePool.</p>
  </Panel></div>;
}

export function SignOutButton({ username, onSignOut }: { username: string; onSignOut: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <button onClick={() => { setBusy(true); void onSignOut().finally(() => setBusy(false)); }} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"><span className="max-w-40 truncate">{username}</span>{busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}Sign out</button>;
}

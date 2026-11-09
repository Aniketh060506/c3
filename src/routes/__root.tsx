import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Boxes, RefreshCw } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { AuthGate } from "@/components/auth-gate";
import { Toaster } from "@/components/ui/sonner";
import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  const errorMessage = error instanceof Error ? error.message : String(error);
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-5 py-10 text-slate-950">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(59,130,246,0.12),transparent_42%),radial-gradient(ellipse_at_bottom_right,rgba(6,182,212,0.1),transparent_38%)]" />
      <section role="alert" className="relative w-full max-w-xl rounded-3xl border border-slate-200 bg-white/95 p-7 shadow-[0_24px_80px_-36px_rgba(15,23,42,0.28)] sm:p-9">
        <div className="flex items-center gap-3 border-b border-slate-100 pb-5">
          <div className="grid size-11 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20"><Boxes className="size-5" /></div>
          <div><p className="font-bold tracking-tight">ComputePool</p><p className="text-xs text-slate-500">Desktop workspace</p></div>
        </div>
        <div className="pt-7">
          <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-amber-50 text-amber-600"><AlertTriangle className="size-6" /></div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-600">Page recovery</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">This page couldn’t load</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">The page hit an error. Your sign-in and other app screens are still available. Retry this page or return to the workspace.</p>
          <details className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold text-slate-600">Show error details</summary>
            <pre className="mt-3 max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-700">{errorMessage}</pre>
          </details>
          <div className="mt-6 flex flex-wrap gap-3">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700"
          >
              <RefreshCw className="size-4" />Try again
          </button>
          <a
            href="/"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
          >
              <ArrowLeft className="size-4" />Go home
          </a>
        </div>
        </div>
      </section>
    </main>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ComputePool" },
      { name: "description", content: "Share and rent spare CPU, RAM and GPU power." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=JetBrains+Mono:wght@400;600&family=Manrope:wght@400..800&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <AuthGate>{({ username, signOut }) => <AppShell username={username} signOut={signOut}><Outlet /></AppShell>}</AuthGate>
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  );
}

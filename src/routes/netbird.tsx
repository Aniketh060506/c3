import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LoaderCircle, Network, RefreshCw, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { PageHeader, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { netbirdService, type NetBirdPeer, type NetBirdStatus } from "@/lib/platform";

export const Route = createFileRoute("/netbird")({ head: () => ({ meta: [{ title: "Private network · ComputePool" }] }), component: NetBirdSetup });

function NetBirdSetup() {
  const [status, setStatus] = useState<NetBirdStatus | null>(null);
  const [peers, setPeers] = useState<NetBirdPeer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const refresh = async () => {
    setError(null);
    const [state, list] = await Promise.allSettled([netbirdService.status(), netbirdService.peers()]);
    if (state.status === "fulfilled") setStatus(state.value); else setStatus(null);
    if (list.status === "fulfilled") setPeers(list.value); else setPeers(null);
    const rejected = [state, list].find((item) => item.status === "rejected");
    if (rejected?.status === "rejected") setError(rejected.reason instanceof Error ? rejected.reason.message : "Could not read the NetBird client status.");
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, []);

  const connect = async () => {
    setConnecting(true); setError(null);
    try { await netbirdService.connect(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not enroll this laptop in the private network."); }
    finally { setConnecting(false); }
  };

  return <div className="mx-auto max-w-5xl">
    <PageHeader eyebrow="Private peer network · automatic enrollment" title="ComputePool network">
      <Button variant="outline" className="rounded-xl" onClick={() => void refresh()}><RefreshCw className="mr-2 size-4" />Refresh live status</Button>
    </PageHeader>
    <Panel className={`mb-5 ${status?.connected ? "border-success/40 bg-success-soft/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-4">
        <div className={`grid size-12 place-items-center rounded-2xl ${status?.connected ? "bg-success text-white" : "bg-muted text-muted-foreground"}`}>{status?.connected ? <Wifi className="size-5" /> : <WifiOff className="size-5" />}</div>
        <div className="min-w-56 flex-1"><p className="font-bold">{status?.connected ? "This laptop is enrolled and connected" : status?.installed ? "NetBird is installed; enrollment is ready" : "NetBird client is required"}</p><p className="mt-1 text-sm text-muted-foreground">{status?.peerIp ? `Private IP ${status.peerIp}` : "Status refreshes automatically every 5 seconds."}{status?.version ? ` · Client ${status.version}` : ""}</p></div>
        {!status?.connected && <Button className="rounded-xl" onClick={() => void connect()} disabled={connecting || !status?.installed}>{connecting ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Network className="mr-2 size-4" />}{connecting ? "Enrolling this laptop…" : "Connect through ComputePool"}</Button>}
      </div>
      {error && <p role="status" className="mt-4 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm text-muted-foreground">{error}</p>}
    </Panel>

    <div className="grid gap-4 lg:grid-cols-2">
      <Panel><h2 className="font-bold">One-time setup for each laptop</h2><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground"><li>Install the NetBird Windows client. ComputePool detects the local service.</li><li>Sign in to ComputePool with your Cognito email and password.</li><li>Click <strong>Connect through ComputePool</strong>, or enable provider sharing. ComputePool requests a one-use enrollment key from its AWS service and enrolls this laptop automatically.</li><li>Keep the NetBird service running while sharing or using compute. You do not create NetBird accounts, invite users, or sign in to NetBird for each negotiation.</li></ol><p className="mt-4 text-xs text-muted-foreground">If this laptop is connected to another NetBird network, ComputePool switches it to its managed network when you connect. That disconnects the other NetBird profile on this laptop.</p><a className="mt-3 inline-flex font-semibold text-primary" href="https://docs.netbird.io/get-started/install/windows" target="_blank" rel="noreferrer">NetBird Windows install guide</a></Panel>
      <Panel><div className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" /><h2 className="font-bold">Access is opened after acceptance</h2></div><p className="mt-3 text-sm leading-relaxed text-muted-foreground">Provider discovery and chat use the Cognito-protected ComputePool API. After the provider accepts, the consumer starts the session. ComputePool then enrolls the consumer if needed, creates a NetBird group and access policy for only the accepted consumer and provider peers, and joins the K3s workers. Ending the session removes that policy and group.</p><p className="mt-3 text-xs leading-relaxed text-muted-foreground">ComputePool will not edit or delete existing NetBird policies. If an enabled policy grants access through the built-in All group, session setup stops and explains that the workspace policy must be narrowed in the NetBird dashboard first.</p><div className="mt-4 rounded-xl bg-muted p-3 text-xs text-muted-foreground">{peers === null ? "Peer status is unavailable." : `${peers.filter((peer) => peer.connected).length} connected peer(s) are currently visible to this client.`}</div></Panel>
    </div>
  </div>;
}

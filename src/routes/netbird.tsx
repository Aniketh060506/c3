import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Info, LoaderCircle, Network, RefreshCw, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { LoadingPanel, PageHeader, Panel } from "@/components/kit";
import { IconTile } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { netbirdService, type NetBirdPeer, type NetBirdStatus } from "@/lib/platform";

export const Route = createFileRoute("/netbird")({ head: () => ({ meta: [{ title: "Private network · ComputePool" }] }), component: NetBirdSetup });

function NetBirdSetup() {
  const [status, setStatus] = useState<NetBirdStatus | null>(null);
  const [peers, setPeers] = useState<NetBirdPeer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (status === null && peers === null) setLoading(true);
    setError(null);
    const [state, list] = await Promise.allSettled([netbirdService.status(), netbirdService.peers()]);
    if (state.status === "fulfilled") setStatus(state.value); else setStatus(null);
    if (list.status === "fulfilled") setPeers(list.value); else setPeers(null);
    const rejected = [state, list].find((item) => item.status === "rejected");
    if (rejected?.status === "rejected") setError(rejected.reason instanceof Error ? rejected.reason.message : "Could not read the NetBird client status.");
    setLoading(false);
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5000); return () => window.clearInterval(timer); }, []);

  const connect = async () => {
    setConnecting(true); setError(null);
    try { await netbirdService.connect(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not enroll this laptop in the private network."); }
    finally { setConnecting(false); }
  };

  return <div className="w-full min-w-0">
    <PageHeader eyebrow="Private peer network · automatic enrollment" title="ComputePool network">
      <Button variant="outline" className="rounded-xl" onClick={() => void refresh()}><RefreshCw className="mr-2 size-4" />Refresh live status</Button>
    </PageHeader>
    {loading && status === null && peers === null ? <LoadingPanel label="Checking NetBird connection and visible peers" className="mb-5" /> : <Panel className={`mb-5 ${status?.connected ? "border-success/40 bg-success-soft/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-4">
        <IconTile icon={status?.connected ? Wifi : WifiOff} tone={status?.connected ? "green" : "slate"} size="md" />
        <div className="min-w-56 flex-1"><p className="font-bold">{status?.connected ? "This laptop is enrolled and connected" : status?.installed ? "NetBird is installed; enrollment is ready" : "NetBird client is required"}</p><p className="mt-1 text-sm text-muted-foreground">{status?.peerIp ? `Private IP ${status.peerIp}` : "Status refreshes automatically every 5 seconds."}{status?.version ? ` · Client ${status.version}` : ""}</p></div>
        {!status?.connected && <Button className="rounded-xl" onClick={() => void connect()} disabled={connecting || !status?.installed}>{connecting ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Network className="mr-2 size-4" />}{connecting ? "Enrolling this laptop…" : "Connect through ComputePool"}</Button>}
      </div>
      {error && <p role="status" className="mt-4 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm text-muted-foreground">{error}</p>}
    </Panel>}

    <div className="grid gap-4 lg:grid-cols-2">
      <Panel><div className="flex items-center gap-3"><IconTile icon={Network} tone="blue" size="md" /><h2 className="font-bold">One-time setup for each laptop</h2></div><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground"><li>Install the NetBird Windows client. ComputePool detects the local service.</li><li>Sign in to ComputePool with your Cognito email and password.</li><li>Click <strong>Connect through ComputePool</strong>, or enable provider sharing. ComputePool requests a one-use enrollment key from its AWS service and enrolls this laptop automatically.</li><li>Keep the NetBird service running while sharing or using compute. You do not create NetBird accounts, invite users, or sign in to NetBird for each negotiation.</li></ol><p className="mt-4 text-xs text-muted-foreground">If this laptop is connected to another NetBird network, ComputePool switches it to its managed network when you connect. That disconnects the other NetBird profile on this laptop.</p><a className="mt-3 inline-flex font-semibold text-primary" href="https://docs.netbird.io/get-started/install/windows" target="_blank" rel="noreferrer">NetBird Windows install guide</a></Panel>
      <Panel>
        <div className="flex items-center gap-3"><IconTile icon={ShieldCheck} tone="violet" size="md" /><h2 className="font-bold">Access is opened after acceptance</h2></div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Provider discovery and chat use the Cognito-protected ComputePool API. After the provider accepts, the consumer starts the session. ComputePool then enrolls the consumer if needed, creates a NetBird group and access policy for only the accepted consumer and provider peers, and joins the K3s workers. Ending the session removes that policy and group.</p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">ComputePool will not edit or delete existing NetBird policies. If an enabled policy grants access through the built-in All group, session setup stops and explains that the workspace policy must be narrowed in the NetBird dashboard first.</p>
        <div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="flex items-start gap-2"><Info className="mt-0.5 size-4 shrink-0 text-primary" /><div>
            <p className="text-sm font-semibold">Why NetBird can say Connected while showing no peers</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Connected confirms this laptop is enrolled in a workspace; the desktop Peers list only shows peers currently allowed by an active access policy. Before an accepted session starts, or after a failed or ended session removes its temporary policy, an empty list is expected.</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">To verify enrollment, open the NetBird dashboard → Peers and search each laptop’s NetBird IP. Team → Users shows peers for one user and may omit devices enrolled with a setup key. During an active ComputePool session, refresh this screen; if it still shows no peers, inspect the session’s “Grant session-only peer access” step and the NetBird workspace access policy.</p>
          </div></div>
        </div>
        <div className="mt-3 rounded-xl bg-muted p-3 text-xs text-muted-foreground">{peers === null ? "Peer status is unavailable." : peers.length === 0 ? "No peers are visible under the current access policy." : `${peers.filter((peer) => peer.connected).length} of ${peers.length} policy-visible peer(s) are connected.`}</div>
        {peers && peers.length > 0 && <div className="mt-3 space-y-2">{peers.map((peer) => <div key={peer.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border/70 px-3 py-2 text-sm"><span className={`size-2 rounded-full ${peer.connected ? "bg-success" : "bg-muted-foreground/40"}`} /><span className="min-w-0 flex-1 truncate font-medium">{peer.displayName || "NetBird peer"}</span><span className="font-mono text-xs text-muted-foreground">{peer.netbirdIp ?? "IP unavailable"}</span><span className="text-xs text-muted-foreground">{peer.connected ? "Connected" : "Offline"}</span></div>)}</div>}
      </Panel>
    </div>
  </div>;
}

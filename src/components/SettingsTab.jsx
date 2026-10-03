import React, { useState, useEffect } from 'react';
import {
  Wrench,
  Coins,
  Shield,
  Trash2,
  RefreshCw,
  Server,
  Cpu,
  Globe,
  Radio,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Edit3,
  Zap,
  Clock,
  ArrowDownRight,
  ArrowUpRight,
  HardDrive,
} from 'lucide-react';

export default function SettingsTab({
  user,
  onUpdateUser,
  specs,
  onOpenHealthReport,
  onRenameMachine,
  onSignOut,
}) {
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetSuccess, setFaucetSuccess] = useState(false);
  const [faucetError, setFaucetError] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [containerStatus, setContainerStatus] = useState(null);
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState(null);
  const [networkDiag, setNetworkDiag] = useState(null);
  const [socketProbe, setSocketProbe] = useState(null);
  const [probingSocket, setProbingSocket] = useState(false);
  const [targetHost, setTargetHost] = useState('127.0.0.1');

  useEffect(() => {
    const bestAddress = specs?.tailscaleIp || specs?.primaryNetwork?.ip;
    if (bestAddress && targetHost === '127.0.0.1') setTargetHost(bestAddress);
  }, [specs?.tailscaleIp, specs?.primaryNetwork?.ip]);

  // Load initial settings telemetry
  useEffect(() => {
    async function loadData() {
      try {
        if (window.c3?.getTransactions) {
          const txs = await window.c3.getTransactions();
          if (txs) setTransactions(txs);
        }
        if (window.c3?.getContainerStatus) {
          const cs = await window.c3.getContainerStatus();
          if (cs) setContainerStatus(cs);
        }
        if (window.c3?.getNetworkDiagnostics) {
          const nd = await window.c3.getNetworkDiagnostics();
          if (nd) setNetworkDiag(nd);
        }
      } catch (err) {
        console.error('[Settings] Error loading diagnostics:', err);
      }
    }
    loadData();
  }, []);

  // Claim Faucet Credits (+500 C3)
  const handleClaimFaucet = async () => {
    setFaucetLoading(true);
    setFaucetSuccess(false);
    setFaucetError(null);
    try {
      if (window.c3?.claimFaucetCredits) {
        const res = await window.c3.claimFaucetCredits(500);
        if (res?.ok) {
          setFaucetSuccess(true);
          if (res.transactions) setTransactions(res.transactions);
          if (onUpdateUser && res.newBalance !== undefined) {
            onUpdateUser({ ...user, credits: res.newBalance, faucetEligible: false, faucetClaimedAt: new Date().toISOString() });
          }
          setTimeout(() => setFaucetSuccess(false), 4000);
        } else {
          setFaucetError(res?.error || 'Cloud credit ledger did not confirm the grant.');
          if (res?.faucetEligible === false && onUpdateUser) onUpdateUser({ ...user, faucetEligible: false });
        }
      }
    } catch (err) {
      setFaucetError(err.message);
    } finally {
      setFaucetLoading(false);
    }
  };

  // 1-Click Prune C3 Containers
  const handlePruneContainers = async () => {
    setPruning(true);
    setPruneResult(null);
    try {
      if (window.c3?.pruneContainers) {
        const res = await window.c3.pruneContainers();
        setPruneResult(res);
        if (window.c3?.getContainerStatus) {
          const cs = await window.c3.getContainerStatus();
          if (cs) setContainerStatus(cs);
        }
      }
    } catch (err) {
      setPruneResult({ ok: false, error: err.message });
    } finally {
      setPruning(false);
    }
  };

  // Run P2P Socket Connectivity Probe
  const handleProbeSocket = async () => {
    setProbingSocket(true);
    try {
      if (window.c3?.testP2PConnectivity) {
        const res = await window.c3.testP2PConnectivity(targetHost, 44344);
        setSocketProbe(res);
      }
    } catch (err) {
      setSocketProbe({ ok: false, message: err.message, latencyMs: null });
    } finally {
      setProbingSocket(false);
    }
  };

  return (
    <div className="workspace-page w-full h-full flex flex-col p-6 md:p-8 space-y-6 select-none ambient-canvas overflow-y-auto">
      {/* ── Top Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-indigo-600 animate-pulse" />
            <span className="text-[10px] font-extrabold uppercase font-mono tracking-wider text-slate-500">
              PHASE 7 · SYSTEM ARCHITECTURE &amp; LEDGER
            </span>
          </div>
          <h1 className="text-2xl font-black text-slate-900 font-display flex items-center gap-2">
              <span>Credits &amp; system</span>
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onOpenHealthReport}
            className="expand-card px-4 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-bold rounded-full shadow-soft-sm transition cursor-pointer flex items-center gap-1.5"
          >
            <Shield className="w-3.5 h-3.5 text-indigo-600" />
            <span>Node Diagnostics</span>
          </button>

        </div>
      </div>

      {/* ───────────────────────────────────────────────────────────── */}
      {/* ── SECTION 1: C3 CREDITS LEDGER & FAUCET ── */}
      {/* ───────────────────────────────────────────────────────────── */}
      <div className="bg-white/90 border border-slate-200/80 rounded-[32px] p-6 shadow-soft space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 shadow-soft-sm">
              <Coins className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-black text-slate-900">C3 Compute Credits Wallet</h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/10 text-amber-700 border border-amber-500/20">
                  TESTNET
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Managed securely in Amazon DynamoDB (<code className="font-mono text-slate-600">c3_users</code>)
              </p>
            </div>
          </div>

          {/* Current Balance Display & Faucet Action */}
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-xs font-mono font-bold text-slate-400 uppercase">Current Balance</div>
              <div className="text-2xl font-black font-mono text-amber-600">
                {user?.credits == null ? '—' : Number(user.credits).toLocaleString()} <span className="text-sm font-sans text-slate-600">C3</span>
              </div>
            </div>

            <button
              onClick={handleClaimFaucet}
              disabled={faucetLoading || user?.cloudIdentityReady !== true || user?.faucetEligible !== true}
              className="expand-card px-5 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded-2xl text-xs font-bold shadow-soft transition cursor-pointer flex items-center gap-2 disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5 fill-white" />
              <span>{faucetLoading ? 'Claiming…' : user?.cloudIdentityReady !== true ? 'Cloud access unavailable' : user?.faucetEligible === true ? 'Claim +500 credits' : user?.faucetEligible === false ? 'Already claimed' : 'Checking eligibility…'}</span>
            </button>
          </div>
        </div>

        {user?.cloudIdentityReady === false && (
          <div role="alert" className="px-4 py-3 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-900">
            <div className="font-semibold">Cognito sign-in succeeded, but AWS temporary credentials are unavailable.</div>
            <div className="mt-1">The balance and claim eligibility are unknown until the Cognito Identity Pool issues credentials. Check that the pool trusts this user pool/app, then review its authenticated IAM role and DynamoDB permissions.</div>
            {user?.cloudIdentityError && <div className="mt-2 rounded-lg border border-amber-200/80 bg-white/70 px-3 py-2 font-mono text-xs">Identity Pool error: {user.cloudIdentityError}</div>}
          </div>
        )}
        {user?.cloudIdentityReady === true && user?.faucetEligible === false && (
          <div role="status" className="px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-600">
            The test faucet is limited to one +500 C3 claim per account. Existing credits are preserved.
          </div>
        )}

        {faucetSuccess && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center gap-2 text-xs font-bold text-emerald-800 animate-fadeIn">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>500 C3 test credits were written to the DynamoDB ledger.</span>
          </div>
        )}
        {faucetError && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl flex items-center gap-2 text-xs font-bold text-rose-800">
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            <span>Credit grant failed: {faucetError}</span>
          </div>
        )}

        {/* Transactions Table */}
        <div>
          <h4 className="text-xs font-black font-display text-slate-900 uppercase tracking-wider mb-3">
            Recent Ledger Transactions
          </h4>
          <div className="bg-slate-50/70 border border-slate-200/60 rounded-2xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] font-mono font-bold uppercase text-slate-400 bg-slate-100/50">
                  <th className="py-2.5 px-4">Transaction ID</th>
                  <th className="py-2.5 px-4">Type</th>
                  <th className="py-2.5 px-4">Description</th>
                  <th className="py-2.5 px-4">Amount</th>
                  <th className="py-2.5 px-4">Time</th>
                  <th className="py-2.5 px-4 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs font-mono">
                {transactions.length === 0 ? (
                  <tr>
                    <td colSpan="6" className="py-6 text-center text-slate-400">
                      No transaction history recorded yet.
                    </td>
                  </tr>
                ) : (
                  transactions.slice(0, 5).map((tx) => (
                    <tr key={tx.id} className="hover:bg-white/80 transition">
                      <td className="py-2.5 px-4 text-slate-500 font-bold">{tx.id}</td>
                      <td className="py-2.5 px-4">
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-200 text-slate-700">
                          {tx.type}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 font-sans text-slate-700">{tx.description}</td>
                      <td className="py-2.5 px-4 font-bold text-amber-600">{tx.amount} C3</td>
                      <td className="py-2.5 px-4 text-slate-400">
                        {new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                          {tx.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <details className="group rounded-2xl border border-slate-200 bg-white shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 font-semibold text-slate-800 marker:hidden">
          <span>Advanced diagnostics and maintenance</span>
          <span className="text-xs font-medium text-slate-500 group-open:hidden">Network probes · container cleanup · node identity</span>
        </summary>
        <div className="space-y-6 border-t border-slate-100 p-5">
      {/* ───────────────────────────────────────────────────────────── */}
      {/* ── SECTION 2: CONTAINER & COMPUTE MAINTENANCE ── */}
      {/* ───────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white/90 border border-slate-200/80 rounded-[32px] p-6 shadow-soft space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-5 h-5 text-indigo-600" />
              <h3 className="text-base font-black text-slate-900">Cluster Container Lifecycle</h3>
            </div>
            <button
              onClick={handlePruneContainers}
              disabled={pruning}
              className="expand-card px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full text-xs font-bold transition cursor-pointer flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-500" />
              <span>{pruning ? 'Pruning...' : 'Prune Inactive Containers'}</span>
            </button>
          </div>

          <p className="text-xs text-slate-500">
            Removes stopped C3 containers only. Running clusters are detected and preserved so this action cannot terminate active work.
          </p>

          <div className="space-y-2">
            <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200/60 flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="text-xs font-bold text-slate-800">K3s Orchestrator Master</div>
                <div className="text-[11px] font-mono text-slate-500">c3-k3s-master · Port 6443</div>
              </div>
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                containerStatus?.master?.running
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-slate-200 text-slate-600'
              }`}>
                {containerStatus?.master?.running ? 'RUNNING' : 'STOPPED / NONE'}
              </span>
            </div>

            <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200/60 flex items-center justify-between">
              <div className="space-y-0.5">
                <div className="text-xs font-bold text-slate-800">K3s Hardware Worker</div>
                <div className="text-[11px] font-mono text-slate-500">c3-k3s-worker · Privileged container</div>
              </div>
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                containerStatus?.worker?.running
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-slate-200 text-slate-600'
              }`}>
                {containerStatus?.worker?.running ? 'RUNNING' : 'STOPPED / NONE'}
              </span>
            </div>
          </div>

          {pruneResult && (
            <div className={`p-3 rounded-2xl text-xs font-mono ${
              pruneResult.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'
            }`}>
              {pruneResult.logs?.join('\n') || (pruneResult.ok ? 'Containers pruned cleanly.' : pruneResult.error)}
            </div>
          )}
        </div>

        {/* ───────────────────────────────────────────────────────────── */}
        {/* ── SECTION 3: P2P SOCKET & PORT DIAGNOSTICS ── */}
        {/* ───────────────────────────────────────────────────────────── */}
        <div className="bg-white/90 border border-slate-200/80 rounded-[32px] p-6 shadow-soft space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2.5">
              <Radio className="w-5 h-5 text-indigo-600" />
              <h3 className="text-base font-black text-slate-900">P2P Socket Probe</h3>
            </div>
            <div className="text-[11px] font-mono text-slate-400">
              RPC Port 44344
            </div>
          </div>

          <p className="text-xs text-slate-500">
            Test direct libuv TCP socket latency to local daemon or peer IP address across the subnet/mesh.
          </p>
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            Port 44344 is expected to show “No listener” while Provider is in standby. Start Provider → Start Sharing before probing; a local K3s API listener does not mean provider sharing is active.
          </p>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={targetHost}
              onChange={(e) => setTargetHost(e.target.value)}
              placeholder="127.0.0.1 or Tailscale IP"
              className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono font-bold text-slate-800 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={handleProbeSocket}
              disabled={probingSocket}
              className="expand-card px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold shadow-soft transition cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${probingSocket ? 'animate-spin' : ''}`} />
              <span>{probingSocket ? 'Probing...' : 'Probe Socket'}</span>
            </button>
          </div>

          {socketProbe && (
            <div className={`p-3 rounded-2xl text-xs font-mono ${
              socketProbe.ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-amber-50 text-amber-800 border border-amber-200'
            }`}>
              <div className="font-bold flex items-center justify-between">
                <span>Target: {socketProbe.host}:{socketProbe.port}</span>
                {socketProbe.latencyMs !== null && <span>{socketProbe.latencyMs} ms latency</span>}
              </div>
              <div className="text-[11px] mt-1">{socketProbe.message}</div>
            </div>
          )}

          {/* Port Bindings Table */}
          <div className="space-y-1.5 pt-2">
            {(networkDiag?.ports || []).slice(0, 3).map((p) => (
              <div key={p.port} className="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-slate-50">
                <span className="font-bold text-slate-700">{p.name}</span>
                <span className={`font-mono font-bold ${p.listening === true ? 'text-emerald-700' : p.listening === false ? 'text-rose-700' : 'text-slate-500'}`}>
                  {p.proto} {p.port} · {p.listening === true ? 'Listening' : p.listening === false ? 'No listener' : 'Not probed'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ───────────────────────────────────────────────────────────── */}
      {/* ── SECTION 4: IDENTITY & AWS FEDERATION ── */}
      {/* ───────────────────────────────────────────────────────────── */}
      <div className="bg-white/90 border border-slate-200/80 rounded-[32px] p-6 shadow-soft space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <Globe className="w-5 h-5 text-indigo-600" />
            <h3 className="text-base font-black text-slate-900">Node Identity &amp; AWS Federation</h3>
          </div>
          <button
            onClick={onRenameMachine}
            className="expand-card px-3.5 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-full text-xs font-bold transition cursor-pointer flex items-center gap-1.5"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Rename Node</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/60">
            <div className="text-[10px] font-mono font-bold uppercase text-slate-400">Node Name</div>
            <div className="text-sm font-black text-slate-900 mt-1">{user?.displayName || 'C3-Node'}</div>
            <div className="text-[11px] font-mono text-slate-500 mt-0.5">{user?.email}</div>
          </div>

          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/60">
            <div className="text-[10px] font-mono font-bold uppercase text-slate-400">AWS Region &amp; Cloud</div>
            <div className="text-sm font-black text-slate-900 mt-1">ap-south-1 (Mumbai)</div>
            <div className={`text-[11px] font-mono mt-0.5 ${user?.cloudIdentityReady ? 'text-emerald-700' : 'text-amber-700'}`}>{user?.cloudIdentityReady ? 'AWS temporary credentials available' : 'AWS temporary credentials unavailable'}</div>
          </div>

          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/60">
            <div className="text-[10px] font-mono font-bold uppercase text-slate-400">Tailscale Mesh</div>
            <div className="text-sm font-black text-slate-900 mt-1">{networkDiag?.tailscaleStatus || 'Not checked'}</div>
            <div className="text-[11px] font-mono text-slate-500 mt-0.5">{networkDiag?.tailscaleIp || 'No active Tailscale IP'}</div>
          </div>
        </div>
      </div>
        </div>
      </details>
    </div>
  );
}

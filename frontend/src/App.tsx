import { useEffect, useMemo, useState } from "react";
import {
  BRIDGE_REFUSAL,
  CROSS_VM_PRECOMPILE,
  CROSS_VM_SELECTOR,
  DEMO,
  WDT_CONTRACT,
  claimableAt,
  fmtDuration,
  fmtTime,
  fmtUnits,
  transferPayload,
  vestedAt,
  type ClaimRecord,
  type Schedule,
} from "./lib/vesting";
import {
  BRIDGE_ADDRESS,
  VESTCROSS_ADDRESS,
  fetchLiveState,
  isLiveConfigured,
  type LiveState,
} from "./lib/chain";

/**
 * VestCross — frontend.
 *
 * DEMO MODE (default): a faithful in-memory simulation of VestCross.sol —
 * the same vesting math, the same CW20 payload, the same claim ordering
 * (Native leg first, EVM bookkeeping only after success). A toggle
 * simulates the bridge refusing the Native call so judges can watch the
 * atomic revert: the claim fails and NOTHING changes on either side.
 *
 * LIVE MODE: when VITE_VESTCROSS_ADDRESS is set, the app reads schedule
 * state straight from Diana through @qorechain/evm (read-only; claiming
 * needs a wallet + scoped window, see README).
 */

const DAY = 86400;

function seedSchedules(now: number): Schedule[] {
  return [
    {
      id: 0,
      funder: DEMO.funder,
      beneficiary: DEMO.beneficiary,
      beneficiaryNative: DEMO.beneficiaryNative,
      totalAmount: 1_000_000n,
      claimedAmount: 0n,
      start: now - 5 * DAY, // 5 days in: cliff (1d) passed, 50% vested
      cliffSeconds: 1 * DAY,
      durationSeconds: 10 * DAY,
      revocable: true,
      revoked: false,
    },
    {
      id: 1,
      funder: DEMO.funder,
      beneficiary: DEMO.beneficiary,
      beneficiaryNative: DEMO.beneficiaryNative,
      totalAmount: 500_000n,
      claimedAmount: 0n,
      start: now - 12 * 3600, // 12h in: cliff (2d) NOT reached yet
      cliffSeconds: 2 * DAY,
      durationSeconds: 20 * DAY,
      revocable: true,
      revoked: false,
    },
  ];
}

function ProgressBar({ s, now }: { s: Schedule; now: number }) {
  const vested = vestedAt(s, now);
  const total = Number(s.totalAmount);
  const claimedPct = (Number(s.claimedAmount) / total) * 100;
  const vestedPct = (Number(vested - s.claimedAmount) / total) * 100;
  return (
    <div>
      <div className="bar">
        <div className="seg claimed" style={{ width: `${claimedPct}%` }} />
        <div className="seg vested" style={{ width: `${vestedPct}%` }} />
      </div>
      <div className="barlegend">
        <span>Paid {fmtUnits(s.claimedAmount)}</span>
        <span>
          Vested {fmtUnits(vested)} / {fmtUnits(s.totalAmount)} WDT
        </span>
      </div>
    </div>
  );
}

function ScheduleCard({
  s,
  now,
  claimable,
  onClaim,
  onRevoke,
  readOnly,
}: {
  s: Schedule;
  now: number;
  claimable: bigint;
  onClaim?: (s: Schedule) => void;
  onRevoke?: (s: Schedule) => void;
  readOnly?: boolean;
}) {
  const canRevoke =
    s.revocable && !s.revoked && now < s.start + s.cliffSeconds;
  return (
    <div className="card">
      <div className="cardhead">
        <strong>Schedule #{s.id}</strong>
        {s.revoked ? (
          <span className="badge bad">REVOKED</span>
        ) : claimable > 0n ? (
          <span className="badge ok">CLAIMABLE</span>
        ) : now < s.start + s.cliffSeconds ? (
          <span className="badge warn">NOT YET AT CLIFF</span>
        ) : (
          <span className="badge">IN PROGRESS</span>
        )}
      </div>
      <ProgressBar s={s} now={now} />
      <dl className="kv">
        <div><dt>Beneficiary (EVM)</dt><dd className="mono">{s.beneficiary}</dd></div>
        <div><dt>Beneficiary (Native)</dt><dd className="mono">{s.beneficiaryNative}</dd></div>
        <div><dt>Funder</dt><dd className="mono">{s.funder}</dd></div>
        <div><dt>Cliff / Duration</dt><dd>{fmtDuration(s.cliffSeconds)} / {fmtDuration(s.durationSeconds)}</dd></div>
        <div><dt>Start</dt><dd>{fmtTime(s.start)}</dd></div>
        <div><dt>Claimable</dt><dd><strong>{fmtUnits(claimable)} WDT</strong></dd></div>
      </dl>
      {!readOnly && (
        <div className="actions">
          <button
            className="primary"
            disabled={claimable === 0n || s.revoked}
            onClick={() => onClaim?.(s)}
          >
            Claim via Cross-VM Bridge
          </button>
          <button
            className="ghost"
            disabled={!canRevoke}
            title={
              canRevoke
                ? "Revoke is only possible before the cliff"
                : "Past the cliff / not revocable / already revoked"
            }
            onClick={() => onRevoke?.(s)}
          >
            Revoke (pre-cliff)
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<"demo" | "live">(
    isLiveConfigured ? "live" : "demo"
  );
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [schedules, setSchedules] = useState<Schedule[]>(() =>
    seedSchedules(Math.floor(Date.now() / 1000))
  );
  const [escrowBalance, setEscrowBalance] = useState<bigint>(1_500_000n);
  const [nativeBalances, setNativeBalances] = useState<Record<string, bigint>>(
    {}
  );
  const [history, setHistory] = useState<ClaimRecord[]>([]);
  const [bridgeFailure, setBridgeFailure] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);

  // form state
  const [fNative, setFNative] = useState(DEMO.beneficiaryNative);
  const [fTotal, setFTotal] = useState("250000");
  const [fCliffDays, setFCliffDays] = useState("1");
  const [fDurDays, setFDurDays] = useState("30");
  const [fRevocable, setFRevocable] = useState(true);

  useEffect(() => {
    const t = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    fetchLiveState()
      .then((st) => {
        if (!cancelled) {
          setLive(st);
          setLiveError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setLiveError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const totalReserved = useMemo(
    () =>
      schedules.reduce(
        (acc, s) => acc + (s.revoked ? 0n : s.totalAmount - s.claimedAmount),
        0n
      ),
    [schedules]
  );

  function doClaim(s: Schedule) {
    const amount = claimableAt(s, now);
    if (amount === 0n) return;
    if (bridgeFailure) {
      // Simulate the bridge refusing the Native execution: the WHOLE claim
      // reverts, and no state changes on either side (atomicity).
      setHistory((h) => [
        {
          id: h.length,
          scheduleId: s.id,
          at: now,
          amount: 0n,
          totalClaimed: s.claimedAmount,
          status: "reverted",
          evmSide: `tx revert — CrossVmCallFailed("${BRIDGE_REFUSAL}")`,
          nativeSide: "no change — the CW20 transfer was never executed / was rolled back",
        },
        ...h,
      ]);
      setNotice(
        `Claim for schedule #${s.id} REVERTED atomically: the bridge refused the Native call, ` +
          `the claim was not recorded and neither side's balance changed.`
      );
      return;
    }
    const payload = transferPayload(s.beneficiaryNative, amount);
    setSchedules((all) =>
      all.map((x) =>
        x.id === s.id ? { ...x, claimedAmount: x.claimedAmount + amount } : x
      )
    );
    setEscrowBalance((b) => b - amount);
    setNativeBalances((m) => ({
      ...m,
      [s.beneficiaryNative]: (m[s.beneficiaryNative] ?? 0n) + amount,
    }));
    setHistory((h) => [
      {
        id: h.length,
        scheduleId: s.id,
        at: now,
        amount,
        totalClaimed: s.claimedAmount + amount,
        status: "success",
        evmSide: "VestingClaimed event recorded AFTER the bridge succeeded",
        nativeSide: `CW20 WDT transfer escrow → beneficiary: +${fmtUnits(amount)} WDT`,
        payload,
      },
      ...h,
    ]);
    setNotice(
      `Claim for schedule #${s.id} succeeded: ${fmtUnits(amount)} WDT moved on the Native lane ` +
        `within the same EVM transaction.`
    );
  }

  function doRevoke(s: Schedule) {
    setSchedules((all) =>
      all.map((x) => (x.id === s.id ? { ...x, revoked: true } : x))
    );
    setNotice(
      `Schedule #${s.id} was revoked by the funder before the cliff — a reservation of ` +
        `${fmtUnits(s.totalAmount - s.claimedAmount)} WDT was released and nothing was paid out.`
    );
  }

  function doCreate(e: React.FormEvent) {
    e.preventDefault();
    const total = BigInt(fTotal || "0");
    const cliff = Number(fCliffDays) * DAY;
    const dur = Number(fDurDays) * DAY;
    if (total <= 0n || !fNative.trim()) {
      setNotice("Invalid form: total must be > 0 and the Native address is required (mirrors the contract's validation).");
      return;
    }
    if (cliff > dur) {
      setNotice("Invalid form: the cliff must not exceed the duration (the contract would revert with CliffExceedsDuration).");
      return;
    }
    const s: Schedule = {
      id: schedules.length,
      funder: DEMO.funder,
      beneficiary: DEMO.beneficiary,
      beneficiaryNative: fNative.trim(),
      totalAmount: total,
      claimedAmount: 0n,
      start: now,
      cliffSeconds: cliff,
      durationSeconds: dur,
      revocable: fRevocable,
      revoked: false,
    };
    setSchedules((all) => [...all, s]);
    setEscrowBalance((b) => b + total); // demo: the funder "tops up" the Native escrow
    setNotice(`Schedule #${s.id} created; the demo Native escrow was topped up with ${fmtUnits(total)} WDT.`);
  }

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>VestCross</h1>
          <p className="sub">
            Cross-VM WDT vesting: the schedule lives on the EVM, the token on
            Native (CW20), paid atomically through the CrossVM Bridge precompile.
          </p>
        </div>
        <div className="badges">
          {mode === "demo" ? (
            <span className="badge warn">DEMO MODE — local simulation</span>
          ) : (
            <span className="badge ok">LIVE READ — Diana testnet</span>
          )}
          {isLiveConfigured && (
            <button className="ghost" onClick={() => setMode(mode === "demo" ? "live" : "demo")}>
              {mode === "demo" ? "View live data" : "Back to demo"}
            </button>
          )}
        </div>
      </header>

      <div className="chips">
        <span className="chip">Bridge <span className="mono">{CROSS_VM_PRECOMPILE}</span></span>
        <span className="chip">Selector <span className="mono">{CROSS_VM_SELECTOR}</span></span>
        <span className="chip">Target VM 1 (Native)</span>
        <span className="chip">CW20 WDT <span className="mono">{WDT_CONTRACT.slice(0, 20)}…</span></span>
        <span className="chip">Atomic: revert EVM = rollback Native</span>
      </div>

      {mode === "live" ? (
        <section>
          <div className="panel">
            <h2>Live data from Diana (@qorechain/evm)</h2>
            <p className="mono small">VestCross: {VESTCROSS_ADDRESS}</p>
            <p className="mono small">Bridge (from @qorechain/evm PRECOMPILE_ADDRESSES): {BRIDGE_ADDRESS}</p>
            {liveError && <p className="bad-text">Failed to read the chain: {liveError}</p>}
            {!live && !liveError && <p>Loading…</p>}
            {live && (
              <>
                <p>
                  WDT contract: <span className="mono">{live.wdtContract}</span><br />
                  Native escrow: <span className="mono">{live.escrowNative || "(not set)"}</span><br />
                  Total reserved: <strong>{fmtUnits(live.totalReserved)} WDT</strong>
                </p>
                <div className="grid">
                  {live.schedules.map((s, i) => (
                    <ScheduleCard
                      key={s.id}
                      s={s}
                      now={Math.floor(Date.now() / 1000)}
                      claimable={live.claimable[i] ?? 0n}
                      readOnly
                    />
                  ))}
                </div>
                {live.schedules.length === 0 && <p>No schedules on-chain yet.</p>}
              </>
            )}
            <p className="small muted">
              Live mode is read-only. Claiming from the browser requires a
              wallet with an active scoped EVM window — see the README.
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="panel controls">
            <div>
              <strong>Demo clock:</strong> {fmtTime(now)}{" "}
              <span className="muted small">(runs in real time; jump ahead to test the cliff)</span>
            </div>
            <div className="actions">
              <button className="ghost" onClick={() => setNow((n) => n + 3600)}>+1 hour</button>
              <button className="ghost" onClick={() => setNow((n) => n + DAY)}>+1 day</button>
              <button className="ghost" onClick={() => setNow((n) => n + 10 * DAY)}>+10 days</button>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={bridgeFailure}
                onChange={(e) => setBridgeFailure(e.target.checked)}
              />
              Simulate a Native refusal (bridge refuse) — the next claim must
              revert atomically
            </label>
          </div>

          <div className="stats">
            <div className="stat">
              <span>Native escrow (demo)</span>
              <strong>{fmtUnits(escrowBalance)} WDT</strong>
              <span className="mono small">{DEMO.escrowNative}</span>
            </div>
            <div className="stat">
              <span>Total reserved</span>
              <strong>{fmtUnits(totalReserved)} WDT</strong>
              <span className="small muted">sum of (total − paid) across active schedules</span>
            </div>
            <div className="stat">
              <span>Beneficiary Native balance</span>
              <strong>{fmtUnits(nativeBalances[DEMO.beneficiaryNative] ?? 0n)} WDT</strong>
              <span className="mono small">{DEMO.beneficiaryNative}</span>
            </div>
          </div>

          {notice && <div className="notice">{notice}</div>}

          <h2>Vesting schedules</h2>
          <div className="grid">
            {schedules.map((s) => (
              <ScheduleCard
                key={s.id}
                s={s}
                now={now}
                claimable={claimableAt(s, now)}
                onClaim={doClaim}
                onRevoke={doRevoke}
              />
            ))}
          </div>

          <div className="panel">
            <h2>Create new schedule</h2>
            <form className="form" onSubmit={doCreate}>
              <label>
                Beneficiary Native address (qor1…)
                <input value={fNative} onChange={(e) => setFNative(e.target.value)} />
              </label>
              <label>
                Total (base unit WDT)
                <input value={fTotal} onChange={(e) => setFTotal(e.target.value.replace(/[^0-9]/g, ""))} />
              </label>
              <label>
                Cliff (days)
                <input value={fCliffDays} onChange={(e) => setFCliffDays(e.target.value.replace(/[^0-9]/g, ""))} />
              </label>
              <label>
                Duration (days)
                <input value={fDurDays} onChange={(e) => setFDurDays(e.target.value.replace(/[^0-9]/g, ""))} />
              </label>
              <label className="switch">
                <input type="checkbox" checked={fRevocable} onChange={(e) => setFRevocable(e.target.checked)} />
                Revocable (only before the cliff)
              </label>
              <button className="primary" type="submit">Create schedule</button>
            </form>
            <p className="small muted">
              In this demo the EVM beneficiary is always the demo account; in
              the real contract, the EVM and Native addresses are two forms of
              the same account (one account, two address formats).
            </p>
          </div>

          <h2>Claim history — two-sided proof</h2>
          <div className="panel">
            {history.length === 0 && (
              <p className="muted">No claims yet. Move past schedule #0's cliff, then click Claim.</p>
            )}
            {history.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th><th>Schedule</th><th>Amount</th><th>Status</th>
                    <th>EVM side</th><th>Native side</th><th>Bridge payload</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtTime(r.at)}</td>
                      <td>#{r.scheduleId}</td>
                      <td>{r.status === "success" ? `${fmtUnits(r.amount)} WDT` : "—"}</td>
                      <td>
                        {r.status === "success" ? (
                          <span className="badge ok">SUCCESS</span>
                        ) : (
                          <span className="badge bad">REVERTED (atomic)</span>
                        )}
                      </td>
                      <td className="small">{r.evmSide}</td>
                      <td className="small">{r.nativeSide}</td>
                      <td className="mono small" title={r.payload ?? ""}>
                        {r.payload ? `${r.payload.slice(0, 42)}…` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="small muted">
              On a live deployment, every successful row is proven by two
              on-chain artifacts: the <span className="mono">VestingClaimed</span> event
              on the EVM transaction and the beneficiary's CW20 balance change
              on the Native lane (queried via REST) — see
              scripts/plan-live-proof.md step 5.
            </p>
          </div>
        </>
      )}

      <footer className="foot muted small">
        VestCross — QoreChain Developer Fest “Build Before Q-Day”, Cross-VM
        category. Diana testnet (EVM chain ID 9800). The local demo does not
        touch the chain; no real funds move.
      </footer>
    </div>
  );
}

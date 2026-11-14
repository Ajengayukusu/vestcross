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
        <span>Terbayar {fmtUnits(s.claimedAmount)}</span>
        <span>
          Tervesting {fmtUnits(vested)} / {fmtUnits(s.totalAmount)} WDT
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
        <strong>Jadwal #{s.id}</strong>
        {s.revoked ? (
          <span className="badge bad">DIREVOKASI</span>
        ) : claimable > 0n ? (
          <span className="badge ok">BISA DIKLAIM</span>
        ) : now < s.start + s.cliffSeconds ? (
          <span className="badge warn">BELUM CLIFF</span>
        ) : (
          <span className="badge">BERJALAN</span>
        )}
      </div>
      <ProgressBar s={s} now={now} />
      <dl className="kv">
        <div><dt>Beneficiary (EVM)</dt><dd className="mono">{s.beneficiary}</dd></div>
        <div><dt>Beneficiary (Native)</dt><dd className="mono">{s.beneficiaryNative}</dd></div>
        <div><dt>Funder</dt><dd className="mono">{s.funder}</dd></div>
        <div><dt>Cliff / Durasi</dt><dd>{fmtDuration(s.cliffSeconds)} / {fmtDuration(s.durationSeconds)}</dd></div>
        <div><dt>Mulai</dt><dd>{fmtTime(s.start)}</dd></div>
        <div><dt>Dapat diklaim</dt><dd><strong>{fmtUnits(claimable)} WDT</strong></dd></div>
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
                ? "Revoke hanya bisa sebelum cliff"
                : "Sudah lewat cliff / tidak revocable / sudah direvokasi"
            }
            onClick={() => onRevoke?.(s)}
          >
            Revoke (pra-cliff)
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
      // Simulasikan bridge menolak eksekusi Native: SELURUH claim revert,
      // tidak ada state yang berubah di kedua sisi (atomicity).
      setHistory((h) => [
        {
          id: h.length,
          scheduleId: s.id,
          at: now,
          amount: 0n,
          totalClaimed: s.claimedAmount,
          status: "reverted",
          evmSide: `tx revert — CrossVmCallFailed("${BRIDGE_REFUSAL}")`,
          nativeSide: "tidak ada perubahan — transfer CW20 tidak pernah dieksekusi / ter-rollback",
        },
        ...h,
      ]);
      setNotice(
        `Claim jadwal #${s.id} REVERT secara atomik: bridge menolak panggilan Native, ` +
          `klaim tidak tercatat dan saldo kedua sisi tidak berubah.`
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
        evmSide: "event VestingClaimed tercatat SETELAH bridge sukses",
        nativeSide: `CW20 WDT transfer escrow → beneficiary: +${fmtUnits(amount)} WDT`,
        payload,
      },
      ...h,
    ]);
    setNotice(
      `Claim jadwal #${s.id} sukses: ${fmtUnits(amount)} WDT berpindah di Native lane ` +
        `dalam tx EVM yang sama.`
    );
  }

  function doRevoke(s: Schedule) {
    setSchedules((all) =>
      all.map((x) => (x.id === s.id ? { ...x, revoked: true } : x))
    );
    setNotice(
      `Jadwal #${s.id} direvokasi funder sebelum cliff — reservasi ` +
        `${fmtUnits(s.totalAmount - s.claimedAmount)} WDT dilepas, tidak ada yang terbayar.`
    );
  }

  function doCreate(e: React.FormEvent) {
    e.preventDefault();
    const total = BigInt(fTotal || "0");
    const cliff = Number(fCliffDays) * DAY;
    const dur = Number(fDurDays) * DAY;
    if (total <= 0n || !fNative.trim()) {
      setNotice("Form tidak valid: total harus > 0 dan alamat Native wajib diisi (meniru validasi kontrak).");
      return;
    }
    if (cliff > dur) {
      setNotice("Form tidak valid: cliff tidak boleh melebihi durasi (kontrak akan revert CliffExceedsDuration).");
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
    setEscrowBalance((b) => b + total); // demo: funder "mengisi" escrow Native
    setNotice(`Jadwal #${s.id} dibuat; escrow Native demo ditambah ${fmtUnits(total)} WDT.`);
  }

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>VestCross</h1>
          <p className="sub">
            Vesting WDT lintas-VM: jadwal di EVM, token di Native (CW20),
            dibayar atomik lewat CrossVM Bridge precompile.
          </p>
        </div>
        <div className="badges">
          {mode === "demo" ? (
            <span className="badge warn">MODE DEMO — simulasi lokal</span>
          ) : (
            <span className="badge ok">LIVE READ — Diana testnet</span>
          )}
          {isLiveConfigured && (
            <button className="ghost" onClick={() => setMode(mode === "demo" ? "live" : "demo")}>
              {mode === "demo" ? "Lihat data live" : "Kembali ke demo"}
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
            <h2>Data live dari Diana (@qorechain/evm)</h2>
            <p className="mono small">VestCross: {VESTCROSS_ADDRESS}</p>
            <p className="mono small">Bridge (dari @qorechain/evm PRECOMPILE_ADDRESSES): {BRIDGE_ADDRESS}</p>
            {liveError && <p className="bad-text">Gagal membaca chain: {liveError}</p>}
            {!live && !liveError && <p>Membaca…</p>}
            {live && (
              <>
                <p>
                  WDT contract: <span className="mono">{live.wdtContract}</span><br />
                  Escrow Native: <span className="mono">{live.escrowNative || "(belum di-set)"}</span><br />
                  Total ter-reserve: <strong>{fmtUnits(live.totalReserved)} WDT</strong>
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
                {live.schedules.length === 0 && <p>Belum ada jadwal on-chain.</p>}
              </>
            )}
            <p className="small muted">
              Mode live bersifat read-only. Claim dari browser membutuhkan wallet
              dengan scoped EVM window aktif — lihat README.
            </p>
          </div>
        </section>
      ) : (
        <>
          <div className="panel controls">
            <div>
              <strong>Jam demo:</strong> {fmtTime(now)}{" "}
              <span className="muted small">(berjalan real-time; lompat untuk uji cliff)</span>
            </div>
            <div className="actions">
              <button className="ghost" onClick={() => setNow((n) => n + 3600)}>+1 jam</button>
              <button className="ghost" onClick={() => setNow((n) => n + DAY)}>+1 hari</button>
              <button className="ghost" onClick={() => setNow((n) => n + 10 * DAY)}>+10 hari</button>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={bridgeFailure}
                onChange={(e) => setBridgeFailure(e.target.checked)}
              />
              Simulasikan penolakan Native (bridge refuse) — claim berikutnya
              harus revert atomik
            </label>
          </div>

          <div className="stats">
            <div className="stat">
              <span>Escrow Native (demo)</span>
              <strong>{fmtUnits(escrowBalance)} WDT</strong>
              <span className="mono small">{DEMO.escrowNative}</span>
            </div>
            <div className="stat">
              <span>Total ter-reserve</span>
              <strong>{fmtUnits(totalReserved)} WDT</strong>
              <span className="small muted">jumlah (total − terbayar) jadwal aktif</span>
            </div>
            <div className="stat">
              <span>Saldo Native beneficiary</span>
              <strong>{fmtUnits(nativeBalances[DEMO.beneficiaryNative] ?? 0n)} WDT</strong>
              <span className="mono small">{DEMO.beneficiaryNative}</span>
            </div>
          </div>

          {notice && <div className="notice">{notice}</div>}

          <h2>Jadwal vesting</h2>
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
            <h2>Buat jadwal baru</h2>
            <form className="form" onSubmit={doCreate}>
              <label>
                Alamat Native beneficiary (qor1…)
                <input value={fNative} onChange={(e) => setFNative(e.target.value)} />
              </label>
              <label>
                Total (base unit WDT)
                <input value={fTotal} onChange={(e) => setFTotal(e.target.value.replace(/[^0-9]/g, ""))} />
              </label>
              <label>
                Cliff (hari)
                <input value={fCliffDays} onChange={(e) => setFCliffDays(e.target.value.replace(/[^0-9]/g, ""))} />
              </label>
              <label>
                Durasi (hari)
                <input value={fDurDays} onChange={(e) => setFDurDays(e.target.value.replace(/[^0-9]/g, ""))} />
              </label>
              <label className="switch">
                <input type="checkbox" checked={fRevocable} onChange={(e) => setFRevocable(e.target.checked)} />
                Revocable (hanya sebelum cliff)
              </label>
              <button className="primary" type="submit">Buat jadwal</button>
            </form>
            <p className="small muted">
              Di demo ini beneficiary EVM selalu akun demo; di kontrak asli,
              alamat EVM + Native adalah pasangan akun yang sama (satu akun,
              dua bentuk alamat).
            </p>
          </div>

          <h2>Riwayat klaim — bukti dua sisi</h2>
          <div className="panel">
            {history.length === 0 && (
              <p className="muted">Belum ada klaim. Lewati cliff jadwal #0 lalu klik Claim.</p>
            )}
            {history.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Waktu</th><th>Jadwal</th><th>Jumlah</th><th>Status</th>
                    <th>Sisi EVM</th><th>Sisi Native</th><th>Payload bridge</th>
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
                          <span className="badge ok">SUKSES</span>
                        ) : (
                          <span className="badge bad">REVERT (atomik)</span>
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
              Pada deployment live, setiap baris sukses dibuktikan oleh dua
              artefak on-chain: event <span className="mono">VestingClaimed</span> pada
              tx EVM dan perubahan saldo CW20 beneficiary di Native lane
              (diquery via REST) — lihat scripts/plan-live-proof.md langkah 5.
            </p>
          </div>
        </>
      )}

      <footer className="foot muted small">
        VestCross — QoreChain Developer Fest “Build Before Q-Day”, kategori
        Cross-VM. Testnet Diana (EVM chain ID 9800). Demo lokal tidak
        menyentuh chain; tidak ada dana asli yang bergerak.
      </footer>
    </div>
  );
}

# VIDEO SCRIPT — VestCross (Cross-VM)

- **Kategori:** Cross-VM · **Status:** JUJUR — bridge pre-flight LIVE lolos; deployment TERTAHAN (escrow tidak bisa didanai WDT, lihat Segmen 4)
- **Kontrak:** `VestCross` — **BELUM ter-deploy** (tidak ada alamat; JANGAN tampilkan alamat karangan apa pun)
- **Target WDT (CW20, allowlist code id 1):** `qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt` · **Precompile:** `0x0901`
- **Target durasi:** 2:30–2:55 (maksimum contest 3:00) · **Kecepatan baca acuan:** ~130 kata/menit
- **Jumlah kata narasi:** 374 kata · **Estimasi durasi baca:** ±2:53
- **Bahasa narasi:** Inggris (juri internasional). Naskah ini membingkai status tertahan sebagai temuan terverifikasi — tanpa satu pun klaim deploy.

## Tabel segmen

| Segmen | Waktu | Durasi | Isi | Kata |
|---|---|---|---|---|
| 1 | 0:00–0:16 | ±16 dtk | Hook — dua lane, satu payout | 35 |
| 2 | 0:16–1:48 | ±92 dtk | Demo — vesting + atomicity lokal | 200 |
| 3 | 1:48–2:20 | ±32 dtk | Bukti live — probe bridge di Diana | 69 |
| 4 | 2:20–2:42 | ±22 dtk | Temuan — kenapa belum deploy (jujur) | 47 |
| 5 | 2:42–2:53 | ±11 dtk | Penutup — syarat kategori | 23 |

---

## Naskah narasi (voice-over)

### [0:00–0:16] Segmen 1 — Hook

> Vesting logic is easy on EVM. But the WDT token lives on QoreChain's Native lane — and a payout recorded on one lane but failed on the other is worse than no payout at all.

### [0:16–1:48] Segmen 2 — Demo alur utama

> VestCross keeps the schedule on EVM: beneficiary, total amount, cliff, linear vesting. Here in the demo frontend, a beneficiary's schedule is partway through its vesting curve. When she claims, the contract computes the vested amount, then calls the CrossVM bridge precompile — zero-nine-zero-one — which executes a CW20 transfer on the allowlisted WDT contract, from the contract's own Native escrow account to her Native address. Only after the bridge confirms success does the contract record the claim. Watch the refusal toggle: we force the bridge to reject the Native execution — and the entire EVM transaction reverts. Claimed amount: unchanged. Native balance: unchanged. The two lanes can never disagree, because the bridge journals the Native execution against the EVM frame. Thirty-three tests prove this locally, including an atomicity block: bridge refusal, an inactive precompile's empty reply, and an underfunded escrow — each asserting both sides stay as they were. The payload is a CW20 execute message — transfer, recipient, amount — encoded as UTF-8 JSON, and the contract guards the bridge's reply, because since chain version three point two point five a success always returns at least sixty-four bytes: an empty reply is treated as no payout, never as success.

### [1:48–2:20] Segmen 3 — Bukti live (probe bridge)

> Now the live part — and we show our work. Before any deployment, we probed the real bridge on Diana with read-only calls. A non-allowlisted target: refused by name. The WDT target with an empty payload: a CW20 parse error — proof the call reaches the token contract. A transfer payload: a CW20 insufficient-balance error — proof the bridge spends from the calling account. Three outcomes, discriminated as designed.

### [2:20–2:42] Segmen 4 — Temuan (pengganti segmen serangan: status jujur)

> Why is it not deployed, then? The escrow cannot be funded: WDT's entire supply sits untouched in the minter's account — a chain-team test account, the token's only holder. The faucet dispenses other assets, no WDT pool exists, and minting is minter-only. Six routes: investigated, documented, closed.

### [2:42–2:53] Segmen 5 — Penutup

> The moment any WDT reaches an account we control, deployment runs unchanged — every other step is pre-verified. VestCross, for the Cross-VM track.

---

## Shot list per segmen

**Segmen 1 — Hook (0:00–0:16)**
- Layar: featured image; diagram dua lane dari README (EVM ↔ Native via bridge 0x0901).

**Segmen 2 — Demo (0:16–1:48)**
- Layar: frontend demo lokal (`cd frontend && npm run dev`, http://localhost:5173):
  - Dashboard jadwal vesting: progress bar tervesting sebagian, tombol **Claim** aktif.
  - Klik Claim (bridge sukses): riwayat klaim dua sisi bertambah — sisi EVM (tx + claimed) dan sisi Native (payload CW20 + saldo berubah).
  - Aktifkan **toggle penolakan bridge** → klik Claim lagi: tx revert total; sorot claimed tetap & saldo Native tetap (inilah bukti atomicity yang divisualkan).
  - Buat jadwal baru singkat (form) bila waktu cukup di awal segmen.
- Potong ke terminal: `npx hardhat test` → "33 passing", sorot blok atomicity di `test/VestCross.test.ts`.

**Segmen 3 — Bukti live (1:48–2:20)**
- Layar: terminal/REST menampilkan hasil probe (dari `deployments.testnet.json` → `liveProofPreflight.ethCallProbes`, file terbuka di editor):
  1. Target non-allowlist → `cross-VM bridge call refused: target … is not allowlisted`
  2. Target WDT payload `{}` → error parse `cw20::msg::Cw20ExecuteMsg` (panggilan SAMPAI ke kontrak WDT)
  3. Payload transfer asli (dari alamat kontrak prediksi `0xF5aea48e87bF4DDcbFD961BFE3332dFf0f20E4e2`) → `Overflow: Cannot Sub with 0 and 1000` (saldo CW20 nol — bukan penolakan bridge)
- Tampilkan juga params bridge: `GET https://api-testnet.qore.host/qorechain/crossvm/v1/params` → WDT allowlisted, code id 1, enabled true.

**Segmen 4 — Temuan (2:20–2:42)**
- Layar: query pemegang WDT (all_accounts) — hanya SATU akun: minter `qor1sxsu7z3r8wgw3623nxpqwgq8q4hz5g92vnkk48` memegang seluruh total_supply 1.000.000.000; token_info: minter sama, cap null.
- Tampilkan daftar 6 rute akuisisi yang diselidiki (`liveProofPreflight.wdtAcquisition.routesInvestigated`) sekilas di editor.

**Segmen 5 — Penutup (2:42–2:53)**
- Layar: `scripts/plan-live-proof.md` (langkah 2–7 siap jalan) + alamat kontrak WDT; fade out.

---

## Aset yang disiapkan sebelum rekam

1. Tab REST terbuka: `https://api-testnet.qore.host/qorechain/crossvm/v1/params` (bridge params: WDT allowlisted code id 1).
2. File `deployments.testnet.json` terbuka di editor pada bagian `liveProofPreflight` (ethCallProbes + wdtAcquisition) — sumber semua shot Segmen 3–4; JANGAN menampilkan alamat deploy (memang null).
3. Query CosmWasm siap paste untuk WDT `qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt`: `token_info`, `minter`, `all_accounts` via REST smart-query Diana.
4. Frontend demo lokal berjalan (port 5173), state: satu jadwal tervesting sebagian + toggle penolakan bridge siap didemokan; run cadangan terekam.
5. Terminal siap: `npx hardhat test` → 33 passing (sorot blok atomicity).
6. `scripts/plan-live-proof.md` siap ditampilkan untuk shot penutup.
7. Larangan keras saat rekam/improvisasi: jangan menyebut VestCross "live/deployed", jangan menampilkan alamat kontrak atau hash deploy apa pun — statusnya adalah temuan terverifikasi + kesiapan penuh, dan justru kejujuran itu isi Segmen 4.

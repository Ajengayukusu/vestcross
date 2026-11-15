# VestCross — Cross-VM Token Vesting (EVM schedules → Native CW20 payouts)

[![Built on QoreChain](https://build.qorechain.io/badge/vestcross.svg)](https://build.qorechain.io/p/vestcross)

**Live demo:** https://ajengayukusu.github.io/vestcross/

**Demo video (≤ 3 min):** https://www.youtube.com/watch?v=59U5AUgLYoY

> **A vesting contract on the EVM lane that pays out a CosmWasm token on the
> Native lane — atomically, in one transaction, through the CrossVM Bridge.**
> Built for the **QoreChain Developer Fest "Build Before Q-Day"** — **Cross-VM** category.
> Testnet: **QoreChain Diana** (EVM chain ID 9800) · Contract: Solidity 0.8.24 · License: MIT

---

## ⏱ Judge path — 3 minutes

1. **The problem (30 s).** QoreChain runs three VMs side by side, but real
   assets live on different lanes: the CW20 token **WDT** lives on the Native
   (CosmWasm) lane, while composable contract logic is easiest to ship on the
   EVM lane. A vesting schedule for a Native token therefore has to *reach
   across VMs* — and a payout that is recorded on one lane but fails on the
   other is worse than no payout at all.
2. **The fix (30 s).** `VestCross.sol` keeps the vesting schedule on EVM and
   pays claims by calling the **CrossVM Bridge precompile (`0x0901`)**, which
   executes a CW20 `transfer` on the allowlisted WDT contract from the
   contract's own Native escrow account. The bridge **journals** the nested
   Native execution against the EVM frame: if either side fails, **both
   revert**. `claimedAmount` is written *only after* the bridge confirms the
   Native transfer succeeded — the two lanes can never disagree.
3. **Proof it works (60 s).** Run the test suite — **33 tests**, including a
   dedicated atomicity block (bridge refusal, inactive-precompile empty
   reply, underfunded escrow — each asserting *both* sides stay untouched):
   ```bash
   npm install && npx hardhat test
   ```
4. **See it (60 s).** Open the hosted demo at https://ajengayukusu.github.io/vestcross/
   — schedules, vesting progress, claim flow, a bridge-refusal toggle that
   demonstrates the atomic revert, and a two-sided claim history. Or run it
   locally:
   ```bash
   cd frontend && npm install && npm run dev   # http://localhost:5173
   ```
5. **Deployment status.** **NOT DEPLOYED — the live phase ran on
   2026-11-15 and is PAUSED at the escrow-funding step, for a documented
   chain-side reason.** The read-only bridge pre-flight
   (`scripts/plan-live-proof.md` step 0) **PASSED**: WDT is still
   allowlisted (code id 1) and the `eth_call` probes discriminated all
   three outcomes exactly as designed — bridge refusal
   (`… is not allowlisted`) for a non-allowlisted target, a CW20 parse
   error proving the call reaches WDT, and a CW20 insufficient-balance
   error (`Cannot Sub with 0 and 1000`) proving the bridge spends from
   the calling account. **But the escrow cannot be funded:** the entire
   WDT supply (1,000,000,000 base units) sits untouched in the token
   minter's account — a QoreChain team test account — and the token's
   `all_accounts` query lists it as the *only holder in existence*. The
   fest faucet dispenses only QOR/fUSD/fETH/fBTC, the Native AMM trades
   only bank denoms (no WDT pool can exist), and vanilla cw20-base mint
   is minter-only. Six acquisition routes were investigated and are
   recorded with their evidence in `deployments.testnet.json`
   (`liveProofPreflight.wdtAcquisition`). The moment any WDT reaches an
   account we control, plan steps 2–7 execute unchanged — bridge, ABI,
   sender identity and account windows are all pre-verified. This README
   and `deployments.testnet.json` contain no invented address or hash.

---

## How it works

```
   EVM lane (Diana, chain 9800)                     Native lane (CosmWasm)
 ┌───────────────────────────────┐
 │ VestCross.sol                 │
 │  schedule: beneficiary,       │   claim()
 │  cliff, duration, claimed     │ ─────────────┐
 └───────────────────────────────┘              │
                                                 ▼
                              CrossVM Bridge precompile 0x0901
                              executeCrossVMCall(1, WDT, payload)
                              payload = {"transfer":{"recipient":"qor1…",
                                                 "amount":"…"}}  (UTF-8 JSON)
                                                 │
                                                 ▼
                              CW20 WDT contract (allowlisted, code id 1)
                              transfer FROM VestCross's Native escrow account
                              TO the beneficiary's Native address
                                                 │
              ┌──────────────────────────────────┘
              ▼  success (reply ≥ 64 bytes, abi.encode(bytes))
   claimedAmount += amount · VestingClaimed(amount, totalClaimed, nativeReply)
              ✗ any failure → whole transaction reverts → NOTHING recorded,
                Native transfer rolled back with it (bridge journaling)
```

**Schedules.** `createSchedule(beneficiaryEvm, beneficiaryNative, total,
cliff, duration, revocable)` — linear vesting from `start`, zero before the
cliff, full at `start + duration`. Amounts are WDT base units.

**Revoke.** The funder may revoke a revocable schedule **only before the
cliff**. Once vesting has begun, the beneficiary's claim is untouchable —
there is no admin key, no pause, and no way to claw back vested WDT.

**Funding.** The WDT lives in the contract's *Native* account (the qor1
form of the contract address). Funding happens on the Native lane
(a CW20 transfer to that address); `setEscrowNativeAddress` records it
one-time, right after deployment, as the public funding target.
`totalReserved` tracks the EVM-side commitments against that account, and
the CW20 contract itself is the final guard: an underfunded escrow makes
the bridge call fail and the claim revert — never overpay.

### The bridge call, exactly as the node decodes it

The interface in `contracts/ICrossVm.sol` is taken from the official
QoreChain documentation (*Multi-VM (cross-VM calls)* /
*Cross-VM Interoperability*), cross-checked against the Diana chain
parameters — not invented:

```solidity
// precompile 0x0000000000000000000000000000000000000901
function executeCrossVMCall(uint8 targetVM, string targetContract, bytes payload)
    returns (bytes)   // selector 0x3c11078c
```

- `targetVM = 1` (QoreChain Native) — the only supported target.
- Since chain v3.2.5 the reply is `abi.encode(bytes)` — always **≥ 64
  bytes** when the precompile is active. VestCross enforces this: on a
  network where the precompile is *inactive*, a call succeeds with empty
  returndata and executes nothing, so the `ok` flag alone proves nothing.
- Refusals revert with `Error(string)` (e.g. *"… is not allowlisted"*);
  VestCross surfaces that reason verbatim in its `CrossVmCallFailed` error.
- ⚠️ **Historical trap, avoided:** `@qorechain/rdk` ≤ 0.5.0 encoded
  `executeCrossVMCall(string,bytes)` — a different selector that never
  reaches the precompile. The test suite pins `crossVmSelector() ==
  0x3c11078c`.

---

## Category requirements → evidence

| Cross-VM requirement | Where VestCross satisfies it | Evidence |
|---|---|---|
| Real EVM → Native composition via the bridge precompile | `claim()` in `contracts/VestCross.sol` calls `0x0901` with `executeCrossVMCall(1, WDT, payload)`; the precompile address and WDT target are constructor-injected so the production wiring is explicit | Contract source + test asserting the mock bridge received targetVM = 1, the real WDT address, and the byte-exact payload |
| The one legal target on Diana | WDT CW20 `qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt` — allowlist entry code 1 in `bridge_allowed_targets`. No self-deployed Native contract (uploads are permissioned shut network-wide) | Plan-live-proof step 0 re-reads `/qorechain/crossvm/v1/params` before anything is deployed |
| Atomicity / two-sided rollback | State written only after bridge success; bridge journals the Native leg against the EVM frame; every failure mode reverts the whole claim | Hardhat "atomicity" block: bridge refusal, empty reply (inactive precompile) and underfunded escrow each assert claimed = 0 **and** Native balances unchanged; on-chain replays of both failure demos are steps 6.1/6.2 of the live-proof plan |
| Correct payload encoding | CW20 execute message as UTF-8 JSON, `Uint128` as string, built by the public `transferPayload()` so frontend/tests/scripts reproduce it byte-for-byte | Test: payload equals `{"transfer":{"recipient":"qor1abc","amount":"100"}}` exactly |
| Tests | Hardhat + TypeScript, positive + negative + atomicity coverage | `npx hardhat test` → **33 passing** |
| Live demo | Frontend demo mode simulates the full flow incl. the refusal/revert path; live mode reads real schedules from Diana via `@qorechain/evm` when `VITE_VESTCROSS_ADDRESS` is set | `frontend/` (build verified: `tsc -b && vite build` clean) |
| Deployed on Diana testnet | `scripts/deploy.ts` targets chain ID 9800 and refuses any other chain; constructor takes the real `0x0901` + WDT | **Pre-flight PASSED live (2026-11-15), deployment PAUSED at escrow funding** — the bridge probes were executed against the real chain and are recorded in `deployments.testnet.json`; deployment itself waits on WDT availability (see Honest limits). No address/hash claimed for steps that did not run |

---

## Run it

```bash
# contracts + tests
npm install
npx hardhat compile
npx hardhat test          # 33 passing

# frontend demo (local, no chain needed)
cd frontend
npm install
npm run dev               # http://localhost:5173
npm run build             # production build check (also enables live-read mode via .env)
```

### Bootstrap order for the live deployment (do NOT reorder)

1. **Faucet** — fund the deployer (coin-type 60) at https://dashboard.qorechain.io/faucet
   (paste the `qor1...` address; 100 QOR / 24 h).
2. **Register the ML-DSA-87 key** — must be the account's **first** transaction
   (MsgRegisterPQCKeyV2 + proof of possession; SDK `ensurePqcRegistered`).
3. **Open a scoped EVM window** (hybrid-signed) covering the deployment.
4. **Pre-flight the bridge** — `scripts/plan-live-proof.md` step 0
   (allowlist + `eth_call` probes; go/no-go).
5. **Deploy:**
   ```bash
   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network diana
   ```
6. Continue with the plan: `setEscrowNativeAddress` → fund escrow with
   WDT → schedule → claim → atomic-failure demos → record every hash in
   `deployments.testnet.json`.

Deploying before step 2/3 is rejected by the EVM lane (pqc codes 26/27/28) —
the script header repeats these prerequisites.

---

## Threat model

| Attack / failure | Defence in VestCross | Test |
|---|---|---|
| **Stranger claims** someone else's vesting | `claim` is `msg.sender == beneficiary` only → `NotBeneficiary` | "reverts for a non-beneficiary" |
| **Double-claim** of the same vested portion | `claimedAmount` is the single source of truth; a second claim at unchanged vesting has claimable = 0 → `NothingToClaim` | "rejects a double-claim of the same vested portion" (coarse-grained schedule, drift-proof) |
| **Claiming more than vested** | Claims pay exactly `vested − claimed` computed on chain; there is no amount parameter to inflate | vesting-math tests + delta-only second claim test |
| **Bridge refuses** (target not allowlisted, circuit breaker, CW20 error) | The revert propagates: `CrossVmCallFailed` carries the chain's own reason string; no state is written | "bridge refusal … leaves both sides untouched" |
| **Inactive precompile** silently no-ops (the mainnet behaviour) | Reply must be ≥ 64 bytes (`abi.encode(bytes)` minimum) or the claim reverts `CrossVmEmptyReply` — a no-op can never be booked as a payout | "an empty reply … is treated as failure" |
| **Underfunded escrow** (funder promises more than the Native account holds) | The CW20 transfer itself fails inside the bridge → atomic revert; the schedule stays claimable for when funding arrives | "an underfunded escrow reverts the claim atomically" |
| **Funder reneges** after vesting starts | Revoke is impossible at/after the cliff (`RevokeAfterCliff`); non-revocable schedules can never be revoked | revoke test block (5 tests) |
| **Owner rewrites the escrow address** after funding | `escrowNativeAddress` is set-once and owner-only; it is informational — the bridge derives the sender from the contract itself, so it cannot redirect funds | "cannot be set twice" · "cannot be set by a non-owner" |
| **Reentrancy** through the payout path | OpenZeppelin `ReentrancyGuard` on `claim`; effects follow the (journaled) bridge call and the CW20 target cannot call back into the EVM lane synchronously | suite-wide state assertions after every claim |

## Honest limits

- **Diana's allowlist is the design's hard boundary.** The bridge reaches
  exactly three Native targets (WDT + two aegis-flight contracts), and
  Native contract upload is permissioned shut — *nobody* can deploy their
  own CosmWasm contract. VestCross is therefore built on the only token
  the bridge can legally move. If governance changes
  `bridge_allowed_targets`, the design must be re-planned (plan step 0
  checks this first).
- **MockCrossVm is not the bridge.** Locally it reproduces the bridge's
  *behaviour contract* (success / `Error(string)` refusal / empty reply /
  CW20 insufficiency) plus a simulated CW20 ledger, so VestCross's logic
  — ordering, reply validation, rollback — is fully testable. The real
  journaling, gas metering and allowlist enforcement are the chain's, and
  are only proven in the live phase (plan steps 0, 5, 6).
- **The bridge ABI has already changed once** (the RDK ≤0.5.0 selector
  trap) and the docs warn it may change again before mainnet activation.
  The selector is pinned by a test and re-probed in plan step 0.
- **Bridge sender identity is verified, not assumed.** Confirmed
  empirically in the 2026-11-15 pre-flight: a transfer probe call from
  the predicted VestCross contract address failed inside the CW20 with
  an insufficient-balance error for an account holding 0 WDT — the
  bridge spends from the calling account's Native form, exactly as this
  design assumes (probe log in `deployments.testnet.json`).
- **WDT acquisition on testnet is IMPOSSIBLE from our accounts today —
  proven, not merely unproven.** Plan step 3 ran on 2026-11-15 and
  established: the full supply (1000 WDT) has never left the minter
  account (`qor1sxsu…vnkk48`, the token creator — a team test account)
  since instantiation at height 65070; it is the only holder returned
  by the token's `all_accounts` query. The faucet dispenses no WDT,
  x/amm cannot list a CW20 (bank denoms only), cw20-base mint is
  minter-only, and contract instantiation is permissioned shut. Six
  routes, each with its on-chain evidence, are documented in
  `deployments.testnet.json`. This is a chain-side distribution fact,
  not a gap in the contract or the plan — and it blocks *every* builder
  equally, since nobody else holds WDT either.
- **Amounts are WDT base units.** The token's `decimals` are read from
  the contract in plan step 0.3 and recorded before any display value is
  claimed anywhere.
- **Not yet deployed — paused at funding, everything upstream proven.**
  The deployment phase executed the plan through step 0 and the step-3
  acquisition investigation (2026-11-15). Deployment, the two-sided live
  evidence table and the on-chain failure demos remain ready to run the
  moment WDT becomes obtainable; their local equivalents are covered by
  the test suite and their on-chain semantics were probed read-only
  against the real bridge. Nothing in this README claims a live address,
  hash or balance that does not exist.

## Repository layout

```
contracts/   VestCross.sol · ICrossVm.sol (the node's real bridge ABI) · MockCrossVm.sol (tests)
test/        VestCross.test.ts — 33 tests (validation, vesting math, claims, atomicity, revoke)
scripts/     deploy.ts — Diana (9800) deployment, refuses other chains
             plan-live-proof.md — the rehearsed live-proof sequence (pre-flight → claim → failure demos)
frontend/    Vite + React + TS dashboard (demo simulation + live read via @qorechain/evm)
deployments.testnet.json — status record (NOT_DEPLOYED until the plan runs)
AI_USAGE.md  How AI was used to build this project, and what humans decided
```

## Credits

Built with the official QoreChain stack and documentation:
`@qorechain/evm` 0.14.0 (precompile registry + read layer), the Diana
CrossVM Bridge precompile (0x0901), OpenZeppelin Contracts 5
(ReentrancyGuard) and Hardhat. Interface references:
docs.qorechain.io/rollups/multi-vm and
docs.qorechain.io/developer-guide/cross-vm-interoperability.
Fest: https://build.qorechain.io — docs: https://docs.qorechain.io/build-before-qday

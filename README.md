# VestCross — Cross-VM Token Vesting (EVM schedules, Native cross-VM journal)

[![Built on QoreChain](https://build.qorechain.io/badge/vestcross.svg)](https://build.qorechain.io/p/vestcross)

**Live demo:** https://ajengayukusu.github.io/vestcross/

**Demo video (≤ 3 min):** https://www.youtube.com/watch?v=XqlzeBx6ufk

> **A vesting contract on the EVM lane whose every claim atomically writes
> a cross-VM journal entry into an approved Native contract through the
> CrossVM Bridge — LIVE on testnet (v2), with the original CW20-payout
> design (v1) preserved and proven locally.**
> Built for the **QoreChain Developer Fest "Build Before Q-Day"** — **Cross-VM** category.
> Testnet: **QoreChain Diana** (EVM chain ID 9800) · Contract: Solidity 0.8.24 · License: MIT
>
> **LIVE (v2):** VestCrossV2 `0x64ab1fABEA011CA0395Ad835EC38B590CF76C295` ·
> VestCrossToken (vDEMO) `0x93B8F1162c7b153A7F5bd9d3341256188C93D796` ·
> evidence in `deployments.testnet.json` (`v2LiveDeployment`).

---

## ⏱ Judge path — 3 minutes

1. **The problem (30 s).** QoreChain runs three VMs side by side, but real
   assets live on different lanes: the CW20 token **WDT** lives on the Native
   (CosmWasm) lane, while composable contract logic is easiest to ship on the
   EVM lane. A vesting schedule for a Native token therefore has to *reach
   across VMs* — and a payout that is recorded on one lane but fails on the
   other is worse than no payout at all.
2. **The fix (30 s).** The vesting schedule lives on EVM. Every claim calls
   the **CrossVM Bridge precompile (`0x0901`)** to write the claimed amount
   into the allowlisted Native WDT contract as an `increase_allowance`
   journal entry for the beneficiary — and pays out the vested ERC20 in
   the *same transaction*. The bridge **journals** the nested Native
   execution against the EVM frame: if either side fails, **both revert**.
   `claimedAmount` is written *only after* both legs succeed, giving a
   three-way invariant anyone can verify: **ERC20 paid == WDT allowance
   == claimedAmount**. (v1, preserved in `contracts/VestCross.sol`, paid
   the CW20 itself the same way — see "Why v2 exists".)
3. **Proof it works (60 s).** Run the test suite — **70 tests** (33 v1 +
   37 v2), including dedicated atomicity blocks asserting *all* sides
   stay untouched on failure:
   ```bash
   npm install && npx hardhat test
   ```
   Then verify the live deployment read-only (`npx ts-node
   scripts/verify-v2.ts`): it re-reads the EVM books and the WDT
   allowance by CosmWasm smart query and checks the invariant.
4. **See it (60 s).** Open the hosted demo at https://ajengayukusu.github.io/vestcross/
   — schedules, vesting progress, claim flow, a bridge-refusal toggle that
   demonstrates the atomic revert, and a two-sided claim history. Or run it
   locally:
   ```bash
   cd frontend && npm install && npm run dev   # http://localhost:5173
   ```
5. **Deployment status — LIVE (v2, deployed 2026-11-16).**
   VestCrossV2 `0x64ab1fABEA011CA0395Ad835EC38B590CF76C295` escrows the
   project ERC20 **vDEMO** (`0x93B8F1162c7b153A7F5bd9d3341256188C93D796`)
   and journals every claim into WDT. Six real claims are on chain
   across four schedules and **two beneficiaries** — **410,000 vDEMO
   claimed in total**; the three-way invariant is verified per
   beneficiary by an independent smart query: for each beneficiary,
   paid == allowance == claimedAmount (210,000,000,000 for the first
   beneficiary; 200,000,000,000 for the second; 410,000,000,000 in
   aggregate). A
   pre-cliff claim and a claim on a throwaway deployment pointed at a
   non-allowlisted target both landed on chain and reverted (status 0),
   moving nothing — the atomicity proof; a second pre-cliff refusal on
   the newest schedule reverted the same way (tx
   `0x985ed493…effd8401`, status 0). **Why not v1's design live?**
   v1 pays WDT itself from a Native escrow, but the entire WDT supply
   sits untouched in its minter's account (the token's only holder),
   every acquisition route is closed, and new CW20 instantiation is
   permissioned shut chain-wide — the full investigation is in
   `deployments.testnet.json` and `SELF_TOKEN_ROUTE.md`. `increase_allowance`
   needs no WDT balance, so v2 runs today; v1 executes unchanged the
   moment any WDT becomes obtainable. No address or hash in this README
   is invented.

---

## How it works — v2 (live)

```
   EVM lane (Diana, chain 9800)                     Native lane (CosmWasm)
 ┌───────────────────────────────┐
 │ VestCrossV2                   │   claim()
 │  schedule: beneficiary,       │ ─────────────┐
 │  cliff, duration, claimed     │              ▼
 │  escrow: vDEMO (ERC20)        │   CrossVM Bridge precompile 0x0901
 └───────────────────────────────┘   executeCrossVMCall(1, WDT, payload)
              ▲                      payload = {"increase_allowance":
              │                        {"spender":"qor1…","amount":"…"}}
              │                                   │
              │                                   ▼
              │              CW20 WDT contract (allowlisted, code id 1)
              │              allowance[owner = VestCrossV2's Native form]
              │                        [spender = beneficiary] += amount
              │                                   │
              └───────────────────────────────────┘
                 journal confirmed (reply ≥ 64 bytes)
   → THEN the ERC20 payout runs, claimedAmount += amount,
     VestingClaimed(amount, totalClaimed, nativeReply)
              ✗ any failure → whole transaction reverts → NOTHING
                recorded on either lane (bridge journaling)
```

**Schedules.** `createSchedule(beneficiaryEvm, beneficiaryNative, total,
cliff, duration, revocable)` — linear vesting from `start`, zero before
the cliff, full at `start + duration`. Amounts are vDEMO base units
(6 decimals, mirroring WDT so the journal and the payout compare 1:1).

**Revoke.** The funder may revoke a revocable schedule **only before the
cliff**. Once vesting has begun, the beneficiary's claim is untouchable —
there is no admin key, no pause, and no way to claw back vested tokens.

**Funding.** Schedules are backed by vDEMO actually held by the contract:
anyone funds it by transferring the token to the contract, and
`createSchedule` reverts (`InsufficientEscrow`) if the unreserved pool
cannot cover the new schedule. `totalReserved` tracks commitments;
`setEscrowNativeAddress` records the contract's qor1 form one-time —
the allowance *owner* identity verifiers query on the Native side.

**v1 (original design, preserved).** `contracts/VestCross.sol` pays the
CW20 WDT itself from the contract's Native escrow via a bridge
`transfer` — identical schedule/revoke/atomicity semantics, proven by
its 33 tests and by read-only bridge probes against the real chain. It
is not deployed because its escrow cannot be funded (see Honest limits);
the plan to run it unchanged is `scripts/plan-live-proof.md`.

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
| Real EVM → Native composition via the bridge precompile | `claim()` in `contracts/v2/VestCrossV2.sol` calls `0x0901` with `executeCrossVMCall(1, WDT, payload)`; the precompile address and WDT target are constructor-injected so the production wiring is explicit | Contract source + test asserting the mock bridge received targetVM = 1, the real WDT address, and the byte-exact payload + **live claims on Diana** (below) |
| The one legal target on Diana | WDT CW20 `qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt` — allowlist entry code 1 in `bridge_allowed_targets`. No self-deployed Native contract (uploads are permissioned shut network-wide) | Live params re-read in the v2 pre-flight (2026-11-16); the fest's own Cross-VM examples list "EVM token with Native vesting" — the v2 shape |
| Atomicity / two-sided rollback | State written only after both legs succeed; bridge journals the Native leg against the EVM frame; every failure mode reverts the whole claim | Hardhat "atomicity" blocks (v1 + v2) **and on-chain proof**: a claim on a throwaway deployment pointed at a non-allowlisted target landed and reverted (tx `0xc3389c73…`, status 0) — payout 0, journal 0, claimed 0 |
| Correct payload encoding | CW20 execute message as UTF-8 JSON, `Uint128` as string, built by the public `increaseAllowancePayload()` so frontend/tests/scripts reproduce it byte-for-byte | Test: payload equals `{"increase_allowance":{"spender":"qor1abc","amount":"100"}}` exactly |
| Tests | Hardhat + TypeScript, positive + negative + atomicity coverage | `npx hardhat test` → **70 passing** (33 v1 + 37 v2) |
| Live demo | Frontend demo mode simulates the full flow incl. the refusal/revert path; live mode reads real schedules from Diana via `@qorechain/evm` when `VITE_VESTCROSS_ADDRESS` is set | `frontend/` (build verified: `tsc -b && vite build` clean) |
| Deployed on Diana testnet | v2: `scripts/deploy-v2.ts` / `resume-v2.ts` target chain ID 9800 only; constructor takes the real `0x0901` + WDT + token | **LIVE (2026-11-16)**: VestCrossV2 `0x64ab1fABEA011CA0395Ad835EC38B590CF76C295`, vDEMO `0x93B8F1162c7b153A7F5bd9d3341256188C93D796`; two claims (txs `0x79cf1caf…`, `0x6f6d84ef…`); three-way invariant re-verified read-only by `scripts/verify-v2.ts` — full record in `deployments.testnet.json` |

---

## Run it

```bash
# contracts + tests
npm install
npx hardhat compile
npx hardhat test          # 70 passing (33 v1 + 37 v2)

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
5. **Deploy:** v2 (as executed live, 2026-11-16):
   ```bash
   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy-v2.ts --network diana
   ```
   then `setEscrowNativeAddress` → fund with vDEMO → schedules → claims →
   refusal demos → verify with `scripts/verify-v2.ts` → record every hash
   in `deployments.testnet.json`. (v1: `scripts/deploy.ts` + the funding
   steps of `scripts/plan-live-proof.md`, unchanged, once WDT exists.)

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
| **Underfunded escrow** (funder promises more than the escrow holds) | v2: `createSchedule` reverts `InsufficientEscrow` unless the contract's token pool covers the reservation. v1: the CW20 transfer itself fails inside the bridge → atomic revert; the schedule stays claimable for when funding arrives | v2 "rejects schedule creation when the escrow pool is unfunded" · v1 "an underfunded escrow reverts the claim atomically" |
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
- **The mocks are not the bridge.** Locally they reproduce the bridge's
  *behaviour contract* (success / `Error(string)` refusal / empty reply /
  CW20 insufficiency) plus simulated CW20 ledgers, so both contracts'
  logic — ordering, reply validation, rollback — is fully testable. The
  real journaling, gas metering and allowlist enforcement are the
  chain's, and for v2 they are proven in the live phase (claims + the
  bad-target refusal, all recorded in `deployments.testnet.json`).
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
  proven, not merely unproven.** The full supply (1000 WDT) has never
  left the minter account (`qor1sxsu…vnkk48`, the token creator — a team
  test account) since instantiation at height 65070; it is the only
  holder returned by the token's `all_accounts` query. The faucet
  dispenses no WDT, x/amm cannot list a CW20 (bank denoms only),
  cw20-base mint is minter-only, and contract instantiation is
  permissioned shut. Six routes, each with on-chain evidence, are
  documented in `deployments.testnet.json`. This blocks v1's payout
  design for *every* builder equally — nobody else holds WDT either.
- **What v2's Native leg is — and is not.** It is a *journal*: each claim
  increases the beneficiary's WDT allowance from the vesting contract's
  Native account by exactly the claimed amount. It is **not** a WDT
  payout — no WDT moves (none can), and the allowance is a verifiable
  ledger entry, not spendable WDT funding. The vested asset is vDEMO, a
  valueless project test token. This is stated plainly because the
  distinction matters: the cross-VM call, its atomicity and its public
  verifiability are real; a WDT-denominated payout is not claimed.
- **Amounts are base units** (6 decimals on both tokens). Live state at
  publication: all four schedules are fully claimed — 410,000 of
  410,000 vDEMO paid out (100,000 + 10,000 + 100,000 to the first
  beneficiary; 200,000 to a second beneficiary added in the 19 Nov
  upgrade round, schedule 3, created tx `0x95c8a224…ac46`, claimed tx
  `0xc3167be3…13c`, after its own pre-cliff refusal reverted on chain);
  schedule 1 was
  the pre-cliff refusal demo and was claimed once its cliff and
  duration had passed. Total funded to the contract: 450,000 vDEMO;
  40,000 remains as unreserved balance. Current values are whatever
  `scripts/verify-v2.ts` reports — it reads the chain, not this file.

## Repository layout

```
contracts/   VestCross.sol (v1) · ICrossVm.sol (the node's real bridge ABI) · MockCrossVm.sol (tests)
contracts/v2/ VestCrossV2.sol (live) · VestCrossToken.sol (vDEMO) · MockCrossVmV2.sol (tests)
test/        VestCross.test.ts — 33 tests · VestCrossV2.test.ts — 37 tests (three-way invariant)
scripts/     deploy-v2.ts / resume-v2.ts / deploy-v2-badtarget.ts — the v2 live deployment
             claim-v2.ts / refusals-v2.ts / claim-again.ts — live claims + on-chain refusal demos
             volume-fund-schedule.ts / volume-claims.ts / volume-claim2.ts — the 19 Nov volume round
             volume2-fund-schedule.ts / volume2-refusal.ts / volume2-claims.ts — the 19 Nov upgrade round (schedule 3, second beneficiary)
             verify-v2.ts — read-only per-beneficiary three-way invariant check against both lanes
             deploy.ts + plan-live-proof.md — the v1 deployment and its live-proof sequence
             probe-live.ts — the read-only WDT go/no-go probe behind the v1 finding
frontend/    Vite + React + TS dashboard (demo simulation + live read via @qorechain/evm)
deployments.testnet.json — status record (v1 history + v2LiveDeployment, LIVE)
SELF_TOKEN_ROUTE.md — Phase 1 research: why a self-issued CW20 is impossible, why v2 is legitimate
V2_BUILD_LOG.md — the v2 build + deployment log, step by step
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

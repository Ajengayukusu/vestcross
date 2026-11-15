# VestCross — self-issued CW20 route: Phase 1 research

*Question: can VestCross deploy LIVE on Diana using a self-issued CW20 instead
of the ecosystem WDT? Research date: 16 Nov 2026 (WIB). Read-only phase —
no transactions, no deployments.*

## Step 2 (done first — it is the decisive technical check): bridge allowlist

Live query `GET https://api-testnet.qore.host/qorechain/crossvm/v1/params`
(HTTP 200, 16 Nov 2026) returns exactly three `bridge_allowed_targets`,
each additionally pinned in `bridge_target_pins` to a specific code id:

| Target | Pinned code_id | What it actually is |
|---|---|---|
| `cosmwasm:qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt` | 1 | WDT — vanilla cw20-base ("Wasm Deploy Test", minter `qor1sxsu7…vnkk48`) |
| `cosmwasm:qor1ufs3tlq4umljk0qfe8k5ya0x6hpavn897u2cnf9k0en9jr7qarqqmjalsd` | 5 | **NOT a token** — instance of `aegis_flight_tournament` (query variants: `config`, `tournament`, `participant`, `claim`) |
| `cosmwasm:qor1nc5tatafv6eyq7llkr2gv50ff9e22mnf70qgjlv737ktmt4eswrqfye7zd` | 6 | **NOT a token** — second instance of the same `aegis_flight_tournament` code (codes 5 and 6 have identical data_hash) |

Findings:

1. **The allowlist restricts target CONTRACT ADDRESSES.** This is not
   inference — the pre-flight probes recorded in `deployments.testnet.json`
   (15 Nov 2026) prove it empirically via `eth_call` against precompile
   `0x0901`: a non-allowlisted target reverts with
   `cross-VM bridge call refused: target cosmwasm:<addr> is not allowlisted`,
   while the WDT target's call reaches the contract and fails inside it.
2. **Neither of the other two allowlisted targets is a token**, and neither
   is QoreVest's QVEST. The only token the EVM→Native bridge can ever call
   is WDT itself.
3. **A self-issued CW20 cannot even be created on Diana.** Queried live:
   EVERY stored code (ids 1–14+ checked, including cw20-base code 1) has
   `instantiate_permission: { "permission": "Nobody", "addresses": [] }`.
   No account can instantiate a new CosmWasm contract from existing code.
4. Therefore the self-issued-CW20 route is blocked at **two independent
   layers**: (a) instantiation is permissioned to Nobody; (b) even a
   hypothetical new CW20 address would be refused by the bridge allowlist.

## Step 1b — How QoreVest actually did it (the premise of the question is wrong)

Source: QoreVest project page, https://build.qorechain.io/p/qorevest
(crawled 16 Nov 2026, ~22:47 UTC). QoreVest did **not** self-issue a CW20.
Quoting its page:

> "QVEST vests on a cliff + linear schedule enforced by the EVM contract,
> and every claim atomically calls the bridge precompile to increase the
> beneficiary's allowance on the allowlisted Native cw20 contract — the
> Native contract holds a verifiable cross-VM vesting ledger (allowance
> equals total claimed), proven on-chain after every claim, including a
> forced revert proving atomicity."

> "QoreVest is a Solidity contract (QVEST token, 6 decimals, 1M supply)
> deployed on the QoreChain Diana testnet." … "We first investigated the
> cross-VM allowlist and found it holds only three targets and no vesting
> contract, so the schedule is enforced on the EVM side and the Native leg
> serves as the ledger and attestation — this limitation is documented
> honestly in the README." … "all on-chain evidence (3 schedules, 5 claims,
> 1 forced revert) is recorded in the repo"; demo schedule: 50,000 QVEST
> locked (7d cliff, 30d duration); a later commit raises totalLocked to
> 60,000 QVEST.

Mechanism, decoded:

- QVEST is an **ERC20 on the EVM lane** (permissionless to deploy) — the
  vested asset never touches CosmWasm.
- The Native leg calls WDT (the one allowlisted CW20) with
  **`increase_allowance`** — a cw20-base message that sets an allowance
  WITHOUT requiring the sender to hold any WDT balance. That is the whole
  trick: the zero-balance blocker that stops VestCross's `transfer`-based
  claim does not apply to `increase_allowance`. The WDT allowance of the
  beneficiary, granted by the vesting contract's Native account, becomes
  the on-chain cross-VM ledger ("allowance == total claimed").
- Atomicity is proven with a forced-revert claim (if the Native leg fails,
  the EVM claim reverts and no QVEST moves).

## Step 1a — The fest's published Cross-VM requirement (exact text)

Source: fest home page, https://build.qorechain.io/ (crawled 16 Nov 2026,
~22:36 UTC), bounty table, "Cross-VM — Category bounty, Teams of 1 to 4":

- Description: "Build an application where an EVM contract atomically
  calls an approved Native contract."
- Example projects: "EVM token with Native vesting, cross-VM escrow,
  hybrid DAO."
- **Main requirements: "A working EVM-to-Native call to an approved Native
  contract, with atomic execution shown on testnet."**
- Prizes: "To be announced". (The site also warns: "The rules, prizes and
  dates are not final and may still change until the end of the event.")

Reading of the text:

1. The requirement does **not** name WDT, and does **not** require the
   vested asset to be a CW20. It requires (a) an EVM→Native call, (b) to an
   **approved** Native contract — i.e. one of the three allowlisted
   targets; a self-issued CW20 is by definition NOT approved — and
   (c) atomic execution demonstrated on testnet.
2. The example list literally includes "**EVM token with Native vesting**"
   — the QoreVest shape (EVM-side token + Native leg) is a contemplated,
   legitimate category entry.
3. So the self-issued-CW20 route fails the category text as well as the
   chain mechanics: even if the token existed, calling it would not be a
   call to "an approved Native contract".

## Step 3 — VestCross design fit

WDT references in the codebase:

| Location | Reference | Parameterised? |
|---|---|---|
| `contracts/VestCross.sol` | `string public wdtContract`, set from constructor arg `wdtContractAddress`; `claim()` builds `transferPayload(beneficiaryNative, amount)` = `{"transfer":{...}}` and calls `ICrossVm.executeCrossVMCall(1, wdtContract, payload)` | **Yes — constructor injection.** The contract doc-comment states this explicitly (production = allowlisted address, tests = mock, non-allowlisted address = refusal demo) |
| `scripts/deploy.ts` | `WDT_CW20` constant (the allowlisted address), passed as the constructor arg | Script-level constant only |
| `scripts/probe-live.ts`, `contracts/MockCrossVm.sol`, Hardhat tests | Probe tooling / mock / test fixtures shaped around the WDT flow | Test-side only |

Design-fit conclusion: **VestCross needs ZERO code changes to point at a
different CW20** — the token address is already a deployment parameter.
The self-issued-CW20 route is not blocked by our design at all; it is
blocked entirely on the chain side:

- No standard CW20 instance can be created: code_id 1 IS vanilla
  cw20-base (WDT is its only instance), but its `instantiate_permission`
  is `Nobody` — as is every other stored code's (verified live for the
  full code list). Per QoreChain's own published guidance, CosmWasm code
  upload and instantiation have been permissioned to `Nobody` on both
  networks since v3.1.96/97 (industry-wide CosmWasm security advisory);
  opening them requires a governance proposal — not something a fest
  entrant can obtain on demand inside the fest window.
- Even a magically-existing own CW20 would be refused by the bridge
  (Step 2, finding 1 — empirically proven refusal message).

## Step 4 — Verdict

### The asked route — self-issued CW20 instead of WDT: **NO-GO**

Decisive evidence, three independent layers, any one of which suffices:

1. **Instantiation is shut.** Every code on Diana (incl. cw20-base,
   code_id 1) has `instantiate_permission = Nobody` (live REST query,
   16 Nov 2026). We cannot create a CW20.
2. **The bridge would refuse it anyway.** `bridge_allowed_targets` holds
   exactly three addresses (live params, 16 Nov 2026) and the pre-flight
   `eth_call` probes in `deployments.testnet.json` prove non-allowlisted
   targets revert with "is not allowlisted". The other two targets are
   `aegis_flight_tournament` game instances — not tokens, not QVEST.
3. **The category text excludes it.** The fest requires a call to an
   *approved* Native contract (Step 1a); a self-issued token is not one.

### Other live-deployment routes — status

- **Original WDT-transfer design (unchanged VestCross):** still blocked
  solely by WDT acquisition (minter holds 100.0% of supply; faucet/AMM/
  mint/wrap/buy routes all verified closed — `deployments.testnet.json`).
  The only remaining lever is social: the WDT creator/minter account
  (`qor1sxsu7…vnkk48`, a chain-team test account) transferring some WDT,
  or the fest seeding WDT via faucet/pool. `scripts/plan-live-proof.md`
  steps 2–7 execute unchanged the moment any WDT lands. Outside our
  control; cannot be scheduled.
- **Governance route** (proposal to allowlist a new target or open
  instantiation): theoretically exists, practically not obtainable by a
  solo fest entrant inside the build window (2-day vote, chain-team
  decision). Not a plan.
- **The tournament contracts as targets:** their message surface is a
  flight-tournament game (`config/tournament/participant/claim`); no
  token or vesting semantics. Not a route.
- **QoreVest pattern — GO-WITH-CONDITIONS (the one viable live route).**
  Proven live on Diana by a direct competitor and squarely inside the
  published category text ("EVM token with Native vesting" is a listed
  example). It requires accepting a **semantic redesign** of VestCross's
  payout leg — this is a product decision for the parent/user, not a
  drop-in fix:
  - The vested asset moves to the EVM lane: VestCross escrows a
    self-issued **ERC20** (EVM deployment is permissionless) and pays it
    to the beneficiary's EVM address at claim.
  - The Native leg keeps targeting the **allowlisted WDT** but sends
    `{"increase_allowance":{"spender":<beneficiaryNative>,"amount":...}}`
    instead of `{"transfer":{...}}`. `increase_allowance` needs no WDT
    balance (allowances are pure ledger entries in cw20-base), so the
    zero-balance blocker disappears. The WDT allowance
    (owner = VestCross contract's Native account, spender = beneficiary)
    becomes the verifiable cross-VM vesting ledger: allowance == total
    claimed, checkable by anyone via a WDT smart query.
  - Atomicity is preserved by the same bridge journaling: if the Native
    leg fails, the precompile call fails and the whole claim (including
    the ERC20 payout) reverts — the property VestCross's 33 tests and
    QoreVest's forced-revert evidence both demonstrate.
  - Honest framing is mandatory (QoreVest does exactly this): the README
    must state that the allowlist holds no vesting contract and WDT
    cannot be acquired, so the schedule is enforced on EVM and the
    Native leg is the attestation ledger.

### Phase 2 execution plan (only if the redesign above is approved)

Accounts (throwaway work wallet, `foundation-spike/.secrets/account.json`;
patterns in `foundation-spike/account-tools/`, e.g. `vc-probe0.mjs`):
idx0 deployer — Cosmos `qor1dcse33ce3n3mwxxleuupqvfqeq6xl552zm2ltk` /
EVM `0x6E2198c7198Ce3B718DFCf38103120C8346fD28A` (PQC registered; EVM
window had 11/20 txs left at the 15 Nov preflight — re-check, open a
fresh scoped window if needed). idx1 beneficiary — Cosmos
`qor1359rgl28y45dldscnjzxqvcz6pz0qyrmjq488c` / EVM
`0x8d0A347d472568DfB6189c84603302d044F0107b` (its window had 1/3 txs
left — open a fresh window before the claim steps).

0. **Pre-flight (read-only):** re-pull `/qorechain/crossvm/v1/params`
   (allowlist unchanged, WDT pinned code_id 1); `eth_call` probe the
   bridge from idx0 with target WDT and payload
   `{"increase_allowance":{"spender":"<idx1 qor1>","amount":"1"}}` —
   expect SUCCESS (no balance needed), unlike the transfer probes.
   Also verify QoreVest's invariant independently: read its contract
   address from its repo's deployments file and smart-query WDT
   `{"allowance":{"owner":<its contract Native>,"spender":<beneficiary>}}`.
1. **Contract change (minimal, in a v2 contract — keep v1 as-is):**
   add an ERC20 payout token as a second constructor arg; add
   `increaseAllowancePayload(spender, amount)` beside `transferPayload`;
   in `claim()`: call the bridge with the allowance payload first, then
   transfer the ERC20 to `s.beneficiary` (any failure reverts both);
   funding = funder transfers ERC20 into the contract (at or before
   schedule creation; `totalReserved` accounting unchanged). Update the
   Hardhat suite: mock expectations switch to the allowance payload, add
   ERC20 payout + atomic-revert tests (target ≥ the current 33 green).
2. **Deploy:** issue the ERC20 (OpenZeppelin, e.g. "VestCross Token",
   6 decimals to mirror WDT, supply minted to idx0), deploy VestCross v2
   via the existing deploy script pattern (constructor: precompile
   0x0901, WDT address, ERC20 address) inside idx0's scoped window;
   `setEscrowNativeAddress(<contract qor1>)`; fund the contract with the
   demo ERC20 amount.
3. **Demo schedule:** `createSchedule(beneficiary = idx1 EVM,
   beneficiaryNative = idx1 qor1, totalAmount = demo total,
   cliffSeconds = 120, durationSeconds = 1200, revocable = true)`.
4. **Claim + three-way proof:** after the cliff, idx1 claims. Record
   before/after: beneficiary ERC20 balance (EVM), WDT allowance
   owner=contractNative spender=idx1 (Native smart query), EVM
   `claimedAmount`. Invariant: all three deltas equal.
5. **Atomicity on chain (adapted plan step 6):** (i) throwaway v2 with a
   non-allowlisted target → claim reverts with the chain's allowlist
   refusal, `claimedAmount` stays 0, no allowance appears; (ii) a claim
   whose Native leg is forced to fail (e.g. malformed spender on a
   throwaway) → ERC20 does not move. 
6. **Record & publish:** fill `deployments.testnet.json` with the real
   addresses/hashes for the v2 deployment (keep the v1 NOT_DEPLOYED
   history intact and labelled); rewrite the README deployment section
   with the evidence table + the honest-limitation paragraph; update
   `~/workspace/qorechain-contest/PROJECT_PAGES.md`; the live fest page
   text/address updates go through the parent (signed-in browser).

*End of Phase 1. No transactions were sent, nothing was deployed, no
pages were edited, nothing was pushed.*

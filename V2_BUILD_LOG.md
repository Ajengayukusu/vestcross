# VestCross v2 — build & live deployment log

*Phase 2 execution of the QoreVest pattern (see SELF_TOKEN_ROUTE.md).
Started: 16 Nov 2026 (WIB). Testnet Diana only; throwaway work accounts
idx0 (deployer) / idx1 (beneficiary).*

## Steps

- [x] Pre-flight gate 1: bridge eth_call probe, `increase_allowance` on WDT
- [x] Pre-flight gate 2: QoreVest on-chain invariant cross-check
- [x] Build v2 contracts (ERC20 asset + VestCrossV2)
- [x] Hardhat tests: v1 (33) + v2 suite all green — **70 passing**
- [x] Deploy ERC20 + VestCrossV2 from idx0
- [x] setEscrowNativeAddress + fund + create demo schedule
- [x] Live claim(s) + refusal demonstration
- [x] Three-way invariant verified on-chain
- [x] deployments.testnet.json + README + PROJECT_PAGES.md updated
- [x] Local commit + GitHub sync (tree_match)

## Findings

### Pre-flight (16 Nov 2026, script: foundation-spike/account-tools/vc2-preflight.mjs)

- **GATE 1 PASSED.** `eth_call` to bridge 0x0901, target WDT, payload
  `{"increase_allowance":{"spender":"<idx1 qor1>","amount":"12345"}}`:
  SUCCESS with exactly 64 bytes of returndata (active bridge, empty CW20
  reply) — from idx0's EVM account AND from the predicted vesting-contract
  address. Control probe with a `transfer` payload still reverts with the
  CW20 insufficient-balance error ("Cannot Sub with 0 and 1000"), so the
  discrimination is exact: `increase_allowance` needs no WDT balance.
- **GATE 2 PASSED.** QoreVest (contract 0x67e4862c388a5ead666f5ac340fe9ef2fc1f8f68,
  native qor1vljgvtpc3f026en0ttp5pl577t7plrmgce7vdj; addresses from their
  repo's deployments/testnet.json + usage.json) verified independently:
  WDT allowance(owner = contract native, spender = beneficiary native) is
  **100,000,000,000** for beneficiary 1 and **50,000,000,000** for
  beneficiary 2 — exactly their published total-claimed amounts, and their
  EVM `schedules()` claimed fields read the same values on chain. The
  pattern truly executes on Diana.
- **Account state:** idx0 nonce 48, balance 45.139 QOR. BOTH EVM windows
  (idx0, idx1) are EXPIRED (remaining_blocks = 0) — fresh windows must be
  opened for both accounts before any EVM transaction. idx1 balance
  0.678 QOR (enough for window fee + claim gas).

### Windows (vc2-open-windows.mjs)

- idx0: fresh window opened at height 10160303 (20 txs), Cosmos tx
  91FED33B64302E51B275BC29E0A2834129FCDF77E93132F26A53E4500ADCC986.
- idx1: fresh window opened at height 10160306 (20 txs), Cosmos tx
  B977238B5C34B99B81248DD991C9D1E7B9E8CE9C4CF55685947759BBC9AF0507.

### Build

- `contracts/v2/VestCrossToken.sol` — fixed-supply ERC20, 6 decimals.
- `contracts/v2/VestCrossV2.sol` — v1 semantics; claim = bridge
  `increase_allowance` journal FIRST, then ERC20 payout; effects last.
- `contracts/v2/MockCrossVmV2.sol` — mock bridge + allowance ledger.
- `test/VestCrossV2.test.ts` — 37 tests (three-sided assertions).
- Full suite: **70 passing (33 v1 + 37 v2)**, v1 untouched.

### Deployment (with one recovery)

- The first deploy run was killed mid-flight by a service restart.
  On-chain reconstruction (vc2-txhistory.mjs) proved exactly ONE tx from
  it landed: the token deployment. The resume script verified the token
  on chain and completed the remaining steps — no double deployment.
- **VestCrossToken**: `0x93B8F1162c7b153A7F5bd9d3341256188C93D796`
  (deploy tx 0xd27170cd…2d, Cosmos 0F64F649…05; 1,000,000 vDEMO supply).
- **VestCrossV2**: `0x64ab1fABEA011CA0395Ad835EC38B590CF76C295`
  (deploy tx 0x259e8a9b…70). escrowNativeAddress =
  `qor1vj43l2l2qyw2qw26mq67cw94jr8hds54tqr6k8` (set tx 0x1298194c…ef).
- Funded with 200,000 vDEMO (tx 0x33f5f5ec…45).
- Schedule 0 (claim demo): idx1, 100,000 vDEMO, cliff 120 s, duration
  1,200 s (create tx 0x20eb6194…3a, block 10160430).
- Schedule 1 (pre-cliff refusal demo): idx1, 10,000 vDEMO, cliff 86,400 s,
  duration 172,800 s (create tx 0x4ded139c…).
- Throwaway bad-target VestCrossV2: `0x3adcFAe734C579FAa3c6fD9aE84101429b13f603`
  (deploy tx 0x578704bb…3f), target = non-allowlisted
  qor1qqq…gcpqu6, funded 10,000 vDEMO, schedule cliff 0 / duration 600 s.

### Live claims & refusals (beneficiary idx1)

- **Claim 1** (schedule 0): tx
  0x79cf1cafec24d2f914e2ad14c40951773348fbde9755336129aef6e7f09695e8,
  status 1, block 10160531 — **12,000 vDEMO** (12,000,000,000 base units).
- **Claim 2** (schedule 0, delta): tx
  0x6f6d84ef45d08c610b96c52d46eb7cf224b0fa39919acf9a5156eeae8fa755f1 —
  **5,250 vDEMO**; total claimed 17,250 vDEMO.
- **Refusal A** (pre-cliff claim on schedule 1): tx
  0x553c8d8b24ab53a18aa566753e015deca84c7298994f0eabd05f432b80cacdb4,
  status 0 on chain (NothingToClaim), schedule 1 claimed stays 0.
  (One tooling note: ethers v6 throws on status-0 receipts — the failed
  tx was harvested from the error receipt; its calldata decodes to
  claim(1), confirming the evidence is the intended call.)
- **Refusal B** (bad-target atomicity): claimable was 2,500 vDEMO; tx
  0xc3389c73013b48bdc5b07b8712d4b3e150309716b7ee4cf5f3d09dcd3de9c95b,
  status 0 (bridge allowlist refusal inside the claim) — claimedAmount
  stays 0, beneficiary balance delta 0, WDT allowance for the throwaway
  owner stays 0.

### Three-way invariant — VERIFIED ON CHAIN (scripts/verify-v2.ts)

| Leg | Value (base units) |
|---|---|
| ERC20 (vDEMO) balance of beneficiary idx1 | 17,250,000,000 |
| VestCrossV2 schedule 0 `claimedAmount` | 17,250,000,000 |
| WDT allowance (owner qor1vj43l2…, spender idx1 qor1) — independent CosmWasm smart query | 17,250,000,000 |

Negative space also verified: schedule 1 claimed 0; bad-target claimed 0
and allowance 0. Vesting contract still holds 182,750,000,000 vDEMO;
totalReserved 92,750,000,000. **ALL V2 LIVE CHECKS PASS.**

### Publication

- `deployments.testnet.json`: v1 record untouched (address null,
  preflight history intact); `status` now dual; full `v2LiveDeployment`
  section merged from the raw evidence files (kept alongside:
  deployments.v2.partial/badtarget/claims/verification.json).
- `README.md` rewritten for the v2-live truth (2,477 words, < 2,500):
  v2 is the live design; v1's WDT-payout design and its blocker are
  documented honestly; the Native leg is described as an allowance
  journal, NOT a WDT payout.
- `PROJECT_PAGES.md` VestCross data updated to match (parent updates the
  live fest page from it).
- Final suite state: **70 passing (33 v1 + 37 v2)**.

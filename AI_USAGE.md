# AI_USAGE.md — VestCross

*Documentation for the Best AI-Native Build special award: what the AI did,
what the human decided, and how every AI-generated artefact was verified.*

## Human (Ajeng Ayu Kusum) — direction & decisions

- Chose to enter **every** category of the fest at maximum effort ("target
  juara, overall 10/10, tidak ada kesalahan") and set the order of work:
  the five solo categories first, the team category later.
- Approved the Cross-VM concept under Diana's real constraints: since the
  bridge allowlist holds only three Native targets and self-deployed
  CosmWasm contracts are impossible, the project composes with the CW20
  **WDT** token instead of pretending a custom Native contract could exist.
- Owns all accounts, keys and submissions: GitHub, X, QoreX (testnet) and
  the contest registration are the human's; no AI ever holds a recovery
  phrase or a private key belonging to the human.
- Decides go/no-go at each phase gate (research → foundation spike → build
  → deploy → submit). The deployment of this project is a later gate and
  has deliberately NOT been executed yet.

## AI agent (Mica / Muse) — research, engineering & documentation

### Research phase (all claims verified against live sources)
- Read the full fest site and docs; verified the Cross-VM facts **against
  the chain and the official documentation**, not from memory:
  precompile `0x0901` active on Diana; `bridge_allowed_targets` holds
  exactly 3 targets (CW20 WDT code 1, aegis-flight code 5 and code 6);
  Native upload permissioned shut.
- Recovered the **exact bridge ABI** from the official docs page
  *Multi-VM (cross-VM calls)*: `executeCrossVMCall(uint8,string,bytes)`,
  selector `0x3c11078c`, targetVM 1 = Native, payload = UTF-8 JSON CW20
  execute message, replies `abi.encode(bytes)` (≥ 64 bytes) since chain
  v3.2.5, refusals as `Error(string)`, nested execution journaled against
  the EVM frame. Also documented the trap in the same source: RDK ≤0.5.0
  encoded a two-argument form whose selector never reaches the precompile.
- Cross-checked the SDK packages actually installed in the foundation
  spike (`@qorechain/evm` 0.14.0 `PRECOMPILE_ADDRESSES.crossVmBridge`,
  `@qorechain/sdk` `MsgCrossVMCall` payload conventions — CosmWasm
  payloads are `JSON.stringify` → UTF-8) so the Solidity interface, the
  frontend constants and the live-proof plan all agree.

### Build phase (this repository)
- Wrote `VestCross.sol` (schedule bookkeeping on EVM; `claim` writes
  `claimedAmount` only after the bridge confirms; ≥64-byte reply guard
  against an inactive precompile; refusal-reason passthrough;
  pre-cliff-only revoke), `ICrossVm.sol` (the node's real ABI with its
  provenance and traps documented in-line) and `MockCrossVm.sol`
  (behaviour-faithful bridge + simulated CW20 ledger with Success /
  RefuseWithReason / EmptyReply modes).
- Wrote the 33-test Hardhat suite with a two-sided assertion discipline:
  after every claim attempt, tests check the EVM state AND the simulated
  Native ledger — a failed claim must leave both untouched. Includes the
  selector pin (`0x3c11078c`), the byte-exact payload test, vesting math
  via the deterministic `vestedAmountAt` view, and a drift-proof
  double-claim test (coarse-grained schedule so block-timestamp drift
  cannot vest a new unit between the two claims).
- Avoided a real portability bug the compiler exposed: OpenZeppelin 5.6's
  `Strings` pulls in `Bytes`, whose `mcopy` paths need Cancun; VestCross
  uses a hand-rolled decimal-string helper instead, keeping the deployed
  bytecode at the Paris EVM target Diana tooling expects.
- Built the Vite/React frontend: demo mode is a faithful simulation of
  the contract (same math, same payload, same claim ordering) with a
  bridge-refusal toggle demonstrating the atomic revert; live mode reads
  real schedules from Diana through `@qorechain/evm`
  (`createEvmClient` + `readContract` + `PRECOMPILE_ADDRESSES`) when
  `VITE_VESTCROSS_ADDRESS` is set.
- Wrote `scripts/deploy.ts` (Diana-only guard, bootstrap prerequisites in
  the header) and `scripts/plan-live-proof.md` — the rehearsed live
  sequence with read-only go/no-go probes (allowlist re-read, `eth_call`
  refusal vs CW20-parse-error discrimination, sender-identity check with
  a probe transfer) before any funds move, and the two on-chain
  atomic-failure demos (non-allowlisted target; underfunded escrow).
- Drafted this README with an explicit **NOT YET DEPLOYED** status and a
  `deployments.testnet.json` that contains no invented address or hash.

### Verification of AI output (nothing shipped unverified)
- `npx hardhat compile` — clean (solc 0.8.24, EVM target paris).
- `npx hardhat test` — **33 passing, 0 failing**, run for real in this
  repo (after two test-side fixes: an initially brittle event-timestamp
  assertion and the double-claim drift issue — both were test bugs, found
  by running the suite, and the fixes are documented in the test file).
- `npx tsc --noEmit` — clean (deploy script + tests typecheck).
- `cd frontend && npm run build` — clean (`tsc -b && vite build`).
- Every chain fact in the README traces to a live chain read from the
  research phase or to the official documentation URLs cited in
  `contracts/ICrossVm.sol`; the deployment status is recorded honestly as
  **NOT_DEPLOYED** in `deployments.testnet.json` (live deployment is
  blocked on ecosystem WDT availability) rather than invented.

## Division of labour, in one line

The human picked the fight, the rules of engagement and owns the keys;
the AI did the research, engineering and paperwork — and every claim it
produced was checked against the chain, the docs, the compiler or the
test runner before it was written down.

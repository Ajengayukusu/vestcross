# VestCross — live-proof plan (Diana testnet)

*The exact sequence to execute in the deployment phase. Nothing in this
file has been run yet — the README and `deployments.testnet.json` must keep
saying NOT DEPLOYED until every step below is done and recorded. All chain
reads use `REST = https://api-testnet.qore.host`,
`EVM = https://evm-testnet.qore.host`, explorer
https://explore.qore.network (Testnet).*

## Step 0 — Read-only pre-flight (do this FIRST; it decides go/no-go)

1. **Bridge is active and WDT is still allowlisted.**
   - `GET $REST/qorechain/evm/v1/params` → `active_static_precompiles`
     must contain `0x0000000000000000000000000000000000000901`.
   - `GET $REST/qorechain/crossvm/v1/params` → `bridge_allowed_targets`
     must contain `cosmwasm:qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt`
     (the CW20 WDT contract, code id 1). If governance changed the list,
     STOP and re-plan — the whole design rests on this entry.
2. **Probe the bridge semantics with `eth_call` (no state changes):**
   calldata = `executeCrossVMCall(1, <target>, <payload>)`
   (selector `0x3c11078c`, ABI-encode with viem/ethers).
   - target = a Native address NOT on the allowlist, payload `{}`
     → expect revert `cross-VM bridge call refused: target cosmwasm:<addr> is not allowlisted`.
   - target = WDT, payload `{}` → expect the call to REACH the contract
     and fail inside it (`Error parsing into type cw20::msg::Cw20ExecuteMsg`
     or similar) — this proves the allowlist route works end to end.
   - target = WDT, payload = a real transfer (see step 5), `from` = the
     future VestCross contract address (predictable via deployer nonce) →
     expect a CW20 insufficient-balance error, NOT a bridge refusal. This
     distinguishes "bridge works, escrow empty" from "sender identity is
     not what we think" BEFORE any real WDT moves. If the error suggests a
     different sender than the contract's derived Native address, STOP:
     the funding step must target whatever account the bridge actually
     spends from (identify it from the error / a 1-unit probe in step 3).
3. **Check the WDT token's shape:** smart-query the WDT contract
   (`GET $REST/cosmwasm/wasm/v1/contract/<WDT>/smart/<base64({"token_info":{}})>`)
   → record `decimals` and `symbol` for the README/frontend (amounts in
   this repo are base units until this is known).

## Step 1 — Bootstrap the deployer (order is mandatory)

Same proven sequence as the sibling projects:
faucet (100 QOR to the deployer's `qor1...`) → **register the ML-DSA-87
key as the account's FIRST transaction** (MsgRegisterPQCKeyV2 + proof of
possession; verify `GET $REST/qorechain/pqc/v1/account/<addr>` =
`found:true, possession_proven:true`) → open a **scoped EVM window**
(hybrid-signed) whose budget covers the deployment + the interactions
below → only then touch the EVM lane.

## Step 2 — Deploy VestCross

```bash
DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network diana
```

Constructor args are baked into the script: bridge `0x0901`, WDT address
above. Record: contract address, deploy tx hash.

Then derive the contract's Native address — bech32-encode the contract's
20 bytes with HRP `qor` (the SDK's address utilities in the foundation
account-tools do this; cross-check by querying the account on REST) — and:

```
setEscrowNativeAddress(<contract qor1 address>)   // one-time, owner-only
```

## Step 3 — Fund the escrow with WDT (the critical unknown — solve it here)

The bridge spends WDT **from the VestCross contract's Native account**, so
that account must hold WDT before any claim can succeed.

1. Query the demo accounts' WDT balances (smart query
   `{"balance":{"address":"<qor1>"}}` against the WDT contract).
2. Acquire WDT on testnet — investigate in this order and record which
   route actually worked:
   - the fest faucet / dashboard (does it dispense WDT or only
     QOR + fUSD/fETH/fBTC?),
   - a Native AMM/DEX swap QOR → WDT,
   - the WDT contract itself (any faucet/mint entry in its execute msgs —
     read its schema via the step-0 queries),
   - last resort: ask in the fest's builder channel.
3. Transfer a small probe amount (e.g. 10 WDT base units ×10²) to the
   contract's Native address with a hybrid-signed `MsgExecuteContract`
   `{"transfer":{"recipient":"<contract qor1>","amount":"..."}}` via the
   SDK, then verify the contract's WDT balance via the smart query.
4. **Sender-identity check:** run one real `claim` pre-flight with
   `eth_call` (from = any address; the call goes through VestCross.claim
   via a `from` = beneficiary simulation is not possible for eth_call
   state — instead do step 5 with the probe amount first and a tiny
   schedule). If the probe claim fails with a CW20 error naming a
   different sender, fund THAT account instead and document the finding;
   the design (and this file) must be updated with what the chain
   actually does.
5. Top the escrow up to the demo schedule total (step 4) once the probe
   passes.

## Step 4 — Create the demo schedule

From the deployer/funder EVM account (inside its scoped window), call:

```
createSchedule(
  beneficiary      = <demo beneficiary EVM address (coin-type 60)>,
  beneficiaryNative= <same account's qor1 form>,
  totalAmount      = <funded WDT base units>,
  cliffSeconds     = 120,          // short, demo-friendly
  durationSeconds  = 1200,
  revocable        = true
)
```

Record the tx hash + `ScheduleCreated` event.

## Step 5 — Claim and capture the TWO-SIDED proof

1. Before claiming, record: beneficiary WDT balance (Native REST smart
   query), escrow WDT balance, `claimableAmount` (EVM eth_call).
2. Wait past the cliff. Beneficiary calls `claim(scheduleId)` with a
   generous gas limit (the nested Wasm execution is metered against the
   EVM frame — start at 3,000,000 gas; record the actual `gasUsed`).
3. After the tx, record the same three values again + the
   `VestingClaimed` event (amount, totalClaimed). Expected invariants:
   - beneficiary Native balance increased by EXACTLY the event amount;
   - escrow Native balance decreased by EXACTLY the event amount;
   - EVM `claimedAmount` == event `totalClaimed` == the Native delta.
   These three equalities are the headline evidence table for the README.

## Step 6 — Prove the atomic failure ON CHAIN (two demos)

1. **Bridge refusal:** deploy a THROWAWAY second VestCross whose
   `wdtContract` is a Native address that is NOT allowlisted (any other
   CW20-looking address), create a schedule, pass the cliff, claim →
   the tx must REVERT with `CrossVmCallFailed` carrying the chain's own
   refusal string (`... is not allowlisted`). Verify afterwards:
   `claimedAmount` still 0 on the throwaway, and no Native balance moved.
2. **Underfunded escrow:** on the MAIN deployment, create a schedule
   larger than the escrow's remaining WDT, pass its cliff, claim → the
   tx must REVERT (CW20 insufficient balance wrapped in
   `CrossVmCallFailed`), `claimedAmount` stays 0, balances unchanged.
   (Local equivalents of both demos are already covered by the Hardhat
   suite; these runs repeat them against the real bridge.)

## Step 7 — Record everything

Fill `deployments.testnet.json` (addresses, all tx hashes native + EVM,
balances before/after, gas used) and move the README from "NOT YET
DEPLOYED" to the live evidence table — hashes only for steps that
actually executed. Do not backfill claims for steps that were skipped;
mark them pending, like the sibling projects do.

## Known risks this plan is built around

- **WDT acquisition** is unproven until step 3 runs (no documented public
  WDT faucet). This is the single biggest live-phase risk.
- **Bridge sender identity**: the docs describe journaling and allowlist
  behaviour but the exact Native sender for a contract-originated call is
  verified empirically in steps 0.2/3.4, not assumed.
- **ABI stability**: the docs warn the bridge ABI "may still change" and
  it already changed once (RDK ≤0.5.0 selector trap). Step 0's probe
  detects a selector/ABI change before any funds move.
- **Gas**: nested Wasm execution is metered against the calling EVM
  frame; an under-gassed claim reverts (atomically — annoying, not
  dangerous). Record real `gasUsed` for the README.

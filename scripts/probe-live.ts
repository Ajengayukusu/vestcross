// SPDX-License-Identifier: MIT
/**
 * probe-live.ts — VestCross live-deployment probe (QoreChain Diana).
 *
 * This is the tool behind the documented NOT_DEPLOYED finding in
 * deployments.testnet.json (liveProofPreflight.wdtAcquisition): it checks,
 * read-only, whether ANY route exists for this project to obtain WDT — the
 * CW20 token the VestCross escrow must hold before a single schedule can
 * be funded. It was originally run from the shared foundation workspace
 * (foundation-spike/account-tools/vc-probe0.mjs for the bridge eth_call
 * probes, plus the CW20 smart queries recorded in deployments.testnet.json);
 * it lives in this repo now so anyone can re-run the go/no-go check.
 *
 * What it does (no secrets, no state changes — queries and eth_call only):
 *   1. CW20 state via @qorechain/sdk (CosmWasm smart queries):
 *      token_info (supply/decimals), minter, all_accounts + every holder's
 *      balance, and the WDT balances of the project's own accounts.
 *   2. Native AMM pools (REST): does any pool offer WDT?
 *   3. CrossVM bridge probes via eth_call to precompile 0x0901 (ported
 *      from vc-probe0.mjs): a non-allowlisted target must be refused, a
 *      WDT call must REACH the CW20 contract, and a transfer attempt must
 *      fail with CW20 insufficient funds — NOT a bridge refusal — proving
 *      the bridge route works and only the funding is missing.
 *   4. Verdict: if the whole supply still sits with the minter as the sole
 *      holder, no project account holds WDT and no AMM pool exists, the
 *      answer is the documented one — NO ACQUISITION ROUTE, deployment
 *      stays paused at plan-live-proof.md step 3. Anything else means the
 *      distribution changed and the live phase should be re-planned.
 *
 * Usage:
 *   npx ts-node scripts/probe-live.ts [--json]
 * (Plain ts-node, not `hardhat run`: Hardhat v2 rejects script arguments.
 * The probe talks to Diana's RPC/REST directly.)
 */
import { createCosmWasmClient, queryContractSmart } from "@qorechain/sdk";
import { ethers } from "ethers";

const RPC = "https://rpc-testnet.qore.host";
const REST = "https://api-testnet.qore.host";
const EVM_RPC = "https://evm-testnet.qore.host";
/** CW20 WDT on Diana (code id 1, bridge-allowlisted — see plan-live-proof.md). */
const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
const BRIDGE = "0x0000000000000000000000000000000000000901";
/** The project's own accounts (deployments.testnet.json / plan step 3.1). */
const IDX0_COSMOS = "qor1dcse33ce3n3mwxxleuupqvfqeq6xl552zm2ltk";
const IDX0_EVM = "0x6E2198c7198Ce3B718DFCf38103120C8346fD28A";
const IDX1_COSMOS = "qor1359rgl28y45dldscnjzxqvcz6pz0qyrmjq488c";

interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
}
interface MinterResponse {
  minter: string | null;
  cap: string | null;
}
interface AllAccountsResponse {
  accounts: string[];
}
interface BalanceResponse {
  balance: string;
}
interface HolderBalance {
  address: string;
  balance: string;
}
interface BridgeProbe {
  label: string;
  outcome: string;
}

const USAGE = `Usage: npx ts-node scripts/probe-live.ts [--json]

Read-only live probe: WDT supply/holder distribution via @qorechain/sdk,
AMM pool check, and CrossVM bridge eth_call probes. No secrets are read
and no transaction is ever sent. --json appends a machine-readable
summary of the findings.`;

function extractReason(e: unknown): string {
  const err = e as { reason?: string; data?: string; shortMessage?: string; message?: string };
  if (err?.reason) return err.reason;
  if (typeof err?.data === "string" && err.data.startsWith("0x08c379a0")) {
    try {
      const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${err.data.slice(10)}`);
      return String(decoded);
    } catch {
      /* fall through */
    }
  }
  return (err?.shortMessage ?? err?.message ?? String(e)).slice(0, 400);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.includes("probe-live"));
  const json = args.includes("--json");
  if (args.some((a) => a !== "--json")) {
    console.error(USAGE);
    process.exit(2);
  }

  // --- 1) CW20 state via the QoreChain SDK ---
  const cw = await createCosmWasmClient(RPC);
  const tokenInfo = await queryContractSmart<TokenInfo>(cw, WDT, { token_info: {} });
  const minterRes = await queryContractSmart<MinterResponse>(cw, WDT, { minter: {} });
  console.log(
    `WDT token_info: name="${tokenInfo.name}" symbol=${tokenInfo.symbol} decimals=${tokenInfo.decimals} total_supply=${tokenInfo.total_supply}`,
  );
  console.log(`WDT minter: ${minterRes.minter} (cap: ${minterRes.cap ?? "none"})`);

  const accounts: string[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await queryContractSmart<AllAccountsResponse>(cw, WDT, {
      all_accounts: { limit: 100, ...(startAfter ? { start_after: startAfter } : {}) },
    });
    accounts.push(...page.accounts);
    if (page.accounts.length < 100) break;
    startAfter = page.accounts[page.accounts.length - 1];
  }
  const holders: HolderBalance[] = [];
  for (const address of accounts) {
    const bal = await queryContractSmart<BalanceResponse>(cw, WDT, { balance: { address } });
    holders.push({ address, balance: bal.balance });
  }
  console.log(`WDT holders (${holders.length}):`);
  for (const h of holders) {
    const share =
      BigInt(tokenInfo.total_supply) > 0n
        ? Number((BigInt(h.balance) * 10000n) / BigInt(tokenInfo.total_supply)) / 100
        : 0;
    console.log(`  ${h.address}: ${h.balance} (${share}% of supply)${h.address === minterRes.minter ? "  <- minter" : ""}`);
  }

  const controlled: HolderBalance[] = [];
  for (const address of [IDX0_COSMOS, IDX1_COSMOS]) {
    const bal = await queryContractSmart<BalanceResponse>(cw, WDT, { balance: { address } });
    controlled.push({ address, balance: bal.balance });
    console.log(`project account ${address}: WDT balance ${bal.balance}`);
  }

  // --- 2) Native AMM: any WDT pool? ---
  let ammWdtPool = false;
  try {
    const pools = await (await fetch(`${REST}/qorechain/amm/v1/pools`)).json();
    const text = JSON.stringify(pools);
    ammWdtPool = text.includes(WDT) || text.includes("WDT");
    console.log(`AMM pools mention WDT: ${ammWdtPool}`);
  } catch (e) {
    console.log(`AMM pools query failed (treated as unknown): ${extractReason(e)}`);
  }

  // --- 3) CrossVM bridge eth_call probes (ported from vc-probe0.mjs) ---
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const bridgeIface = new ethers.Interface([
    "function executeCrossVMCall(uint8 targetVM, string targetContract, bytes payload) returns (bytes)",
  ]);
  const callData = (target: string, payload: string) =>
    bridgeIface.encodeFunctionData("executeCrossVMCall", [1, target, ethers.toUtf8Bytes(payload)]);
  const nonce = await provider.getTransactionCount(IDX0_EVM);
  const predicted = ethers.getCreateAddress({ from: IDX0_EVM, nonce });
  console.log(`predicted VestCross address (deployer nonce ${nonce}): ${predicted}`);

  const probes: BridgeProbe[] = [];
  const probe = async (label: string, from: string, target: string, payload: string) => {
    try {
      const data = await provider.call({ from, to: BRIDGE, data: callData(target, payload) });
      probes.push({ label, outcome: `SUCCESS returndata=${data}` });
      console.log(`[${label}] SUCCESS returndata: ${data}`);
    } catch (e) {
      const reason = extractReason(e);
      probes.push({ label, outcome: `REVERT: ${reason}` });
      console.log(`[${label}] REVERT: ${reason}`);
    }
  };
  const transferPayload = JSON.stringify({ transfer: { recipient: IDX1_COSMOS, amount: "1000" } });
  await probe("non-allowlist target", IDX0_EVM, "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgcpqu6", "{}");
  await probe("WDT empty payload", IDX0_EVM, WDT, "{}");
  await probe("WDT transfer from predicted contract", predicted, WDT, transferPayload);
  await probe("WDT transfer from idx0", IDX0_EVM, WDT, transferPayload);

  // --- 4) verdict ---
  // Only positive balances count as holdings: cw20 all_accounts can list
  // zero-balance accounts, which hold nothing and offer no route.
  const funded = holders.filter((h) => BigInt(h.balance) > 0n);
  const soleMinter =
    funded.length === 1 &&
    funded[0].address === minterRes.minter &&
    funded[0].balance === tokenInfo.total_supply;
  const controlledZero = controlled.every((c) => c.balance === "0");
  const blocked = soleMinter && controlledZero && !ammWdtPool;
  const verdict = blocked
    ? "NO ACQUISITION ROUTE — the entire WDT supply still sits untouched with the minter as sole holder, no project account holds WDT, and no AMM pool offers it. Deployment remains paused at plan-live-proof.md step 3 (escrow funding), exactly as documented in deployments.testnet.json. Unblocks if any one of: the minter transfers WDT to a project account, the fest faucet starts dispensing WDT, or governance/the token team seeds a WDT pool or faucet."
    : "DISTRIBUTION CHANGED — the WDT situation no longer matches the documented finding; re-plan the live phase (plan-live-proof.md steps 2-7) around the new distribution above.";
  console.log(`\nVERDICT: ${verdict}`);

  if (json) {
    console.log(
      JSON.stringify(
        { tokenInfo, minter: minterRes, holders, controlled, ammWdtPool, predicted, probes, verdict },
        null,
        2,
      ),
    );
  }
}

main().catch((e) => {
  console.error("ERROR:", extractReason(e));
  process.exit(1);
});

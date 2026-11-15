// SPDX-License-Identifier: MIT
/**
 * verify-v2.ts — read-only verification of the VestCross v2 live proof.
 *
 * The three-way invariant, checked against BOTH lanes independently:
 *   (a) EVM payout:  beneficiary's VestCrossToken balance
 *   (b) EVM books:   VestCrossV2 schedule claimedAmount
 *   (c) Native side: WDT allowance(owner = vesting contract's qor1 form,
 *                    spender = beneficiary's qor1) via a CosmWasm smart
 *                    query — no bridge, no trust in our own contract.
 * Plus the negative space: schedule 1 (pre-cliff) claimed nothing, and
 * the bad-target throwaway produced NO allowance and NO payout.
 *
 * Usage: npx ts-node scripts/verify-v2.ts
 */
import { createCosmWasmClient, queryContractSmart } from "@qorechain/sdk";
import { ethers } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";

const RPC = "https://rpc-testnet.qore.host";
const EVM_RPC = "https://evm-testnet.qore.host";
const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
const BEN_NATIVE = "qor1359rgl28y45dldscnjzxqvcz6pz0qyrmjq488c";
const BEN_EVM = "0x8d0A347d472568DfB6189c84603302d044F0107b";

const VEST_ABI = [
  "function getSchedule(uint256) view returns (tuple(address funder, address beneficiary, string beneficiaryNative, uint256 totalAmount, uint256 claimedAmount, uint64 start, uint64 cliffSeconds, uint64 durationSeconds, bool revocable, bool revoked))",
  "function totalReserved() view returns (uint256)",
  "function scheduleCount() view returns (uint256)",
];
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

interface AllowanceResponse {
  allowance: string;
  expires: unknown;
}

async function main(): Promise<void> {
  const partial = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.v2.partial.json"), "utf8"));
  const claims = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.v2.claims.json"), "utf8"));
  const bad = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.v2.badtarget.json"), "utf8"));

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const vest = new ethers.Contract(partial.contract, VEST_ABI, provider);
  const token = new ethers.Contract(partial.token, TOKEN_ABI, provider);
  const vestBad = new ethers.Contract(bad.badTargetContract, VEST_ABI, provider);

  const s0 = await vest.getSchedule(0);
  const s1 = await vest.getSchedule(1);
  const benTokenBal = await token.balanceOf(BEN_EVM);
  const vestTokenBal = await token.balanceOf(partial.contract);
  const totalReserved = await vest.totalReserved();

  const cw = await createCosmWasmClient(RPC);
  const allowMain = await queryContractSmart<AllowanceResponse>(cw, WDT, {
    allowance: { owner: partial.escrowNativeAddress, spender: BEN_NATIVE },
  });
  const allowBad = await queryContractSmart<AllowanceResponse>(cw, WDT, {
    allowance: { owner: bad.badTargetEscrowNativeAddress, spender: BEN_NATIVE },
  });
  const sBad = await vestBad.getSchedule(0);

  const checks = {
    erc20PaidToBeneficiary: benTokenBal.toString(),
    contractClaimedAmount: s0.claimedAmount.toString(),
    wdtAllowanceJournal: allowMain.allowance,
    invariantHolds:
      benTokenBal.toString() === s0.claimedAmount.toString() &&
      s0.claimedAmount.toString() === allowMain.allowance &&
      BigInt(allowMain.allowance) > 0n,
    schedule1Claimed: s1.claimedAmount.toString(),
    schedule1Untouched: s1.claimedAmount.toString() === "0",
    badTargetClaimed: sBad.claimedAmount.toString(),
    badTargetAllowance: allowBad.allowance,
    badTargetUntouched: sBad.claimedAmount.toString() === "0" && allowBad.allowance === "0",
    vestingContractTokenBalance: vestTokenBal.toString(),
    totalReserved: totalReserved.toString(),
    claimTx: claims.claim?.tx ?? null,
    refusalPreCliffTx: claims.refusalPreCliff?.tx ?? null,
    refusalPreCliffStatus: claims.refusalPreCliff?.status ?? null,
    refusalBadTargetTx: claims.refusalBadTarget?.tx ?? null,
    refusalBadTargetStatus: claims.refusalBadTarget?.status ?? null,
  };
  console.log(JSON.stringify(checks, null, 2));
  fs.writeFileSync(
    path.join(__dirname, "..", "deployments.v2.verification.json"),
    JSON.stringify(checks, null, 2)
  );
  if (!checks.invariantHolds) throw new Error("THREE-WAY INVARIANT DOES NOT HOLD");
  if (!checks.schedule1Untouched || !checks.badTargetUntouched) {
    throw new Error("NEGATIVE-SPACE CHECK FAILED");
  }
  console.log("ALL V2 LIVE CHECKS PASS");
}

main().catch((e) => {
  console.error("ERROR:", e?.message ?? e);
  process.exit(1);
});

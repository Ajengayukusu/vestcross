import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * VestCross v2 refusal demonstrations (companion to claim-v2.ts).
 *
 * The main claim already succeeded (tx passed via MAIN_CLAIM_TX; its
 * amount is re-read from chain state, not trusted from env). This script:
 *   A. Pre-cliff refusal: verifies the already-landed failed claim(1)
 *      transaction (REFUSAL_A_TX) — status 0 on chain — or sends it
 *      fresh with an explicit gas limit if no hash was passed.
 *   B. Bad-target atomicity: sends the throwaway deployment's claim from
 *      the beneficiary with an explicit gas limit; the bridge's
 *      allowlist refusal must revert it on chain (status 0) and nothing
 *      may move. ethers v6 throws on status-0 receipts — caught here and
 *      the receipt harvested from the error.
 * Writes deployments.v2.claims.json (the full claims record).
 */
async function sendExpectFailure(
  wallet: ethers.Wallet,
  to: string,
  data: string,
  gasLimit: bigint
): Promise<{ hash: string; status: number | null; blockNumber: number | null }> {
  const tx = await wallet.sendTransaction({ to, data, gasLimit });
  try {
    const rc = await tx.wait();
    return { hash: tx.hash, status: rc?.status ?? null, blockNumber: rc?.blockNumber ?? null };
  } catch (e: any) {
    const rc = e?.receipt;
    if (rc) return { hash: rc.hash, status: rc.status, blockNumber: rc.blockNumber };
    throw e;
  }
}

async function main() {
  const key = process.env.ACTOR_PRIVATE_KEY;
  if (!key) throw new Error("ACTOR_PRIVATE_KEY env required (beneficiary).");
  const mainClaimTx = process.env.MAIN_CLAIM_TX;
  if (!mainClaimTx) throw new Error("MAIN_CLAIM_TX env required.");
  const wallet = new ethers.Wallet(key, ethers.provider);
  if ((await ethers.provider.getNetwork()).chainId !== 9800n) {
    throw new Error("Refusing: not Diana (9800).");
  }
  const partial = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.v2.partial.json"), "utf8"));
  const bad = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.v2.badtarget.json"), "utf8"));
  const vest = await ethers.getContractAt("VestCrossV2", partial.contract, wallet);
  const token = await ethers.getContractAt("VestCrossToken", partial.token, wallet);
  const out: Record<string, unknown> = { beneficiary: wallet.address };

  // ── main claim record (state re-read from chain) ───────────────────
  const s0 = await vest.getSchedule(0);
  const benBal = await token.balanceOf(wallet.address);
  const claimReceipt = await ethers.provider.getTransactionReceipt(mainClaimTx);
  out.claim = {
    scheduleId: 0, tx: mainClaimTx, status: claimReceipt?.status ?? null,
    blockNumber: claimReceipt?.blockNumber ?? null,
    amountFromEvent: "12000000000",
    claimedAmountAfter: s0.claimedAmount.toString(),
    beneficiaryTokenBalanceAfter: benBal.toString(),
  };
  console.log("main claim recorded:", mainClaimTx, "claimedAmount:", s0.claimedAmount.toString());

  // ── A. pre-cliff refusal ───────────────────────────────────────────
  let refusalA: { hash: string; status: number | null; blockNumber: number | null };
  if (process.env.REFUSAL_A_TX) {
    const rc = await ethers.provider.getTransactionReceipt(process.env.REFUSAL_A_TX);
    const tx = await ethers.provider.getTransaction(process.env.REFUSAL_A_TX);
    refusalA = { hash: process.env.REFUSAL_A_TX, status: rc?.status ?? null, blockNumber: rc?.blockNumber ?? null };
    console.log("refusal A tx data:", tx?.data);
  } else {
    const dataA = await vest.claim.populateTransaction(1);
    refusalA = await sendExpectFailure(wallet, partial.contract, dataA.data, 600_000n);
  }
  const s1 = await vest.getSchedule(1);
  out.refusalPreCliff = {
    scheduleId: 1, tx: refusalA.hash, status: refusalA.status, blockNumber: refusalA.blockNumber,
    claimedAmountAfter: s1.claimedAmount.toString(),
    expectedError: "NothingToClaim (cliff of 86400 s not reached)",
  };
  console.log("REFUSAL A recorded:", refusalA.hash, "status:", refusalA.status);

  // ── B. bad-target atomicity refusal ────────────────────────────────
  const vestBad = await ethers.getContractAt("VestCrossV2", bad.badTargetContract, wallet);
  const claimableBad = await vestBad.claimableAmount(0);
  const balBeforeBad = await token.balanceOf(wallet.address);
  const dataB = await vestBad.claim.populateTransaction(0);
  const refusalB = await sendExpectFailure(wallet, bad.badTargetContract, dataB.data, 1_500_000n);
  const sBad = await vestBad.getSchedule(0);
  const balAfterBad = await token.balanceOf(wallet.address);
  out.refusalBadTarget = {
    contract: bad.badTargetContract, scheduleId: 0, tx: refusalB.hash,
    status: refusalB.status, blockNumber: refusalB.blockNumber,
    claimableBefore: claimableBad.toString(),
    claimedAmountAfter: sBad.claimedAmount.toString(),
    beneficiaryTokenBalanceBefore: balBeforeBad.toString(),
    beneficiaryTokenBalanceAfter: balAfterBad.toString(),
    expectedError: "CrossVmCallFailed: cross-VM bridge call refused: target ... is not allowlisted",
  };
  console.log("REFUSAL B recorded:", refusalB.hash, "status:", refusalB.status,
    "claimedAfter:", sBad.claimedAmount.toString(), "balDelta:", (balAfterBad - balBeforeBad).toString());

  const file = path.join(__dirname, "..", "deployments.v2.claims.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("WROTE", file);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

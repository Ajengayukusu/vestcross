import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * VestCross v2 live claims, executed from the BENEFICIARY account (idx1).
 * The private key arrives as ACTOR_PRIVATE_KEY via vc2-run.mjs (derived
 * from the throwaway work wallet; never committed).
 *
 *   1. Claim schedule 0 on the main VestCrossV2 (after its 120 s cliff) —
 *      must SUCCEED: ERC20 payout + Native allowance journal in one tx.
 *   2. Refusal demo A: claim schedule 1 before its 1-day cliff — sent
 *      with an explicit gas limit so the transaction LANDS on chain and
 *      fails there (status 0, NothingToClaim), instead of dying in local
 *      gas estimation. The failed tx hash is the on-chain evidence.
 *   3. Refusal demo B (atomicity): claim schedule 0 on the throwaway
 *      bad-target deployment — the bridge must refuse (allowlist) inside
 *      the transaction; it lands with status 0 and NOTHING moves.
 * Writes deployments.v2.claims.json.
 */
async function main() {
  const key = process.env.ACTOR_PRIVATE_KEY;
  if (!key) throw new Error("ACTOR_PRIVATE_KEY env required (beneficiary).");
  const wallet = new ethers.Wallet(key, ethers.provider);
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 9800n) throw new Error("Refusing: not Diana (9800).");
  console.log("Beneficiary (actor):", wallet.address);

  const partial = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments.v2.partial.json"), "utf8")
  );
  const bad = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments.v2.badtarget.json"), "utf8")
  );
  const vest = await ethers.getContractAt("VestCrossV2", partial.contract, wallet);
  const token = await ethers.getContractAt("VestCrossToken", partial.token, wallet);
  const out: Record<string, unknown> = { beneficiary: wallet.address };

  // ── 1. the real claim ──────────────────────────────────────────────
  const balBefore = await token.balanceOf(wallet.address);
  const s0Before = await vest.getSchedule(0);
  const claimable = await vest.claimableAmount(0);
  console.log(`schedule 0: claimedBefore=${s0Before.claimedAmount} claimable=${claimable} tokenBalBefore=${balBefore}`);
  if (claimable === 0n) throw new Error("Nothing claimable on schedule 0 — cliff not reached yet?");
  const txClaim = await vest.claim(0);
  const rcClaim = await txClaim.wait();
  let claimedAmount = 0n;
  for (const log of rcClaim?.logs ?? []) {
    try {
      const parsed = vest.interface.parseLog(log as any);
      if (parsed && parsed.name === "VestingClaimed") claimedAmount = parsed.args.amount as bigint;
    } catch { /* not ours */ }
  }
  const balAfter = await token.balanceOf(wallet.address);
  const s0After = await vest.getSchedule(0);
  out.claim = {
    scheduleId: 0, tx: txClaim.hash, status: rcClaim?.status ?? null,
    blockNumber: rcClaim?.blockNumber ?? null,
    amountFromEvent: claimedAmount.toString(),
    beneficiaryTokenBalanceBefore: balBefore.toString(),
    beneficiaryTokenBalanceAfter: balAfter.toString(),
    claimedAmountAfter: s0After.claimedAmount.toString(),
  };
  console.log("CLAIM OK:", txClaim.hash, "amount:", claimedAmount.toString());

  // ── 2. refusal demo A: pre-cliff claim lands and fails on chain ────
  const dataA = await vest.claim.populateTransaction(1);
  const txA = await wallet.sendTransaction({ to: partial.contract, data: dataA.data, gasLimit: 600_000 });
  const rcA = await txA.wait();
  out.refusalPreCliff = {
    scheduleId: 1, tx: txA.hash, status: rcA?.status ?? null,
    blockNumber: rcA?.blockNumber ?? null,
    expectedError: "NothingToClaim (cliff of 86400 s not reached)",
  };
  console.log("REFUSAL A (pre-cliff) tx:", txA.hash, "status:", rcA?.status);

  // ── 3. refusal demo B: bad-target throwaway claim (atomicity) ──────
  const vestBad = await ethers.getContractAt("VestCrossV2", bad.badTargetContract, wallet);
  const claimableBad = await vestBad.claimableAmount(0);
  const balBeforeBad = await token.balanceOf(wallet.address);
  const dataB = await vestBad.claim.populateTransaction(0);
  const txB = await wallet.sendTransaction({ to: bad.badTargetContract, data: dataB.data, gasLimit: 1_500_000 });
  const rcB = await txB.wait();
  const sBadAfter = await vestBad.getSchedule(0);
  const balAfterBad = await token.balanceOf(wallet.address);
  out.refusalBadTarget = {
    contract: bad.badTargetContract, scheduleId: 0, tx: txB.hash,
    status: rcB?.status ?? null, blockNumber: rcB?.blockNumber ?? null,
    claimableBefore: claimableBad.toString(),
    claimedAmountAfter: sBadAfter.claimedAmount.toString(),
    beneficiaryTokenBalanceBefore: balBeforeBad.toString(),
    beneficiaryTokenBalanceAfter: balAfterBad.toString(),
    expectedError: "CrossVmCallFailed: cross-VM bridge call refused: target ... is not allowlisted",
  };
  console.log("REFUSAL B (bad target) tx:", txB.hash, "status:", rcB?.status,
    "claimedAfter:", sBadAfter.claimedAmount.toString());

  const file = path.join(__dirname, "..", "deployments.v2.claims.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("WROTE", file);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

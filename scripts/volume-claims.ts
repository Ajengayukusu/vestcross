import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * VestCross v2 VOLUME ROUND (19 Nov 2026) — beneficiary side (idx1).
 *
 * Claims everything vested across all three schedules:
 *   - schedule 0: the remaining 82,750 vDEMO (fully vested 16 Nov),
 *   - schedule 1: the full 10,000 vDEMO (its 1-day cliff and 2-day
 *     duration have both passed; the pre-cliff refusal tx from 16 Nov
 *     remains the standing atomicity evidence),
 *   - schedule 2: the full 100,000 vDEMO once its 120 s duration has
 *     elapsed (this script polls claimableAmount until fully vested).
 * Target total claimed: 17,250 + 82,750 + 10,000 + 100,000 = 210,000
 * vDEMO. Merges the claim records into deployments.v2.volume.json.
 * Key arrives as ACTOR_PRIVATE_KEY via vc2-run.mjs — never committed.
 *
 * Sends use an explicit fresh pending nonce per attempt, log the hash
 * at broadcast time, and parse the VestingClaimed event from the
 * receipt once mined (robust against concurrent account use).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function robustSend(
  wallet: ethers.Wallet,
  label: string,
  to: string,
  data: string,
  gasLimit: bigint
): Promise<{ hash: string; receipt: ethers.TransactionReceipt }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const nonce = await ethers.provider.getTransactionCount(wallet.address, "pending");
    const tx = await wallet.sendTransaction({ to, data, nonce, gasLimit });
    console.log(`${label}: broadcast attempt=${attempt} nonce=${nonce} hash=${tx.hash}`);
    for (let i = 0; i < 25; i++) {
      const rc = await ethers.provider.getTransactionReceipt(tx.hash);
      if (rc) return { hash: tx.hash, receipt: rc };
      await sleep(3000);
    }
    console.log(`${label}: no receipt after ~75 s — nonce likely consumed concurrently; retrying`);
  }
  throw new Error(`${label}: no receipt after all retries`);
}

async function main() {
  const key = process.env.ACTOR_PRIVATE_KEY;
  if (!key) throw new Error("ACTOR_PRIVATE_KEY env required (beneficiary).");
  const wallet = new ethers.Wallet(key, ethers.provider);
  if ((await ethers.provider.getNetwork()).chainId !== 9800n) {
    throw new Error("Refusing: not Diana (9800).");
  }
  console.log("Beneficiary (actor):", wallet.address);

  const partial = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments.v2.partial.json"), "utf8")
  );
  const volumePath = path.join(__dirname, "..", "deployments.v2.volume.json");
  const volume = JSON.parse(fs.readFileSync(volumePath, "utf8"));
  const vest = await ethers.getContractAt("VestCrossV2", partial.contract, wallet);
  const token = await ethers.getContractAt("VestCrossToken", partial.token, wallet);

  async function claim(id: number): Promise<Record<string, unknown>> {
    const claimable = await vest.claimableAmount(id);
    const sBefore = await vest.getSchedule(id);
    const balBefore = await token.balanceOf(wallet.address);
    console.log(`schedule ${id}: claimedBefore=${sBefore.claimedAmount} claimable=${claimable} balBefore=${balBefore}`);
    if (claimable === 0n) throw new Error(`Nothing claimable on schedule ${id}.`);
    const data = await vest.claim.populateTransaction(id);
    const { hash, receipt } = await robustSend(wallet, `CLAIM ${id}`, partial.contract, data.data, 1_500_000n);
    if (receipt.status !== 1) throw new Error(`Claim ${id} landed with status ${receipt.status}: ${hash}`);
    let amount = 0n;
    for (const log of receipt.logs ?? []) {
      try {
        const parsed = vest.interface.parseLog(log as any);
        if (parsed && parsed.name === "VestingClaimed") amount = parsed.args.amount as bigint;
      } catch { /* not ours */ }
    }
    const sAfter = await vest.getSchedule(id);
    const balAfter = await token.balanceOf(wallet.address);
    console.log(`CLAIM ${id} OK:`, hash, "amount:", amount.toString(), "claimedAfter:", sAfter.claimedAmount.toString());
    return {
      scheduleId: id, tx: hash, status: receipt.status, blockNumber: receipt.blockNumber,
      amountFromEvent: amount.toString(),
      claimedAmountAfter: sAfter.claimedAmount.toString(),
      beneficiaryTokenBalanceAfter: balAfter.toString(),
    };
  }

  const claims: Record<string, unknown>[] = [];
  claims.push(await claim(0));
  claims.push(await claim(1));

  // Schedule 2: wait until fully vested (start + 120 s), then claim.
  const s2 = await vest.getSchedule(2);
  const target = s2.totalAmount - s2.claimedAmount;
  for (let i = 0; i < 40; i++) {
    const c = await vest.claimableAmount(2);
    console.log(`schedule 2 claimable: ${c} / ${target}`);
    if (c >= target) break;
    if (i === 39) throw new Error("Schedule 2 did not fully vest in time.");
    await sleep(15000);
  }
  claims.push(await claim(2));

  volume.claims = claims;
  fs.writeFileSync(volumePath, JSON.stringify(volume, null, 2));
  console.log("WROTE", volumePath);
  console.log(JSON.stringify(claims, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

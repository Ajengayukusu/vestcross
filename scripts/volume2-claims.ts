import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * VestCross v2 VOLUME ROUND 2 — beneficiary claim (idx13).
 * Polls claimableAmount(3) until the schedule is fully vested (real time:
 * cliff 120 s + duration 120 s from creation), then claims the full
 * 200,000 vDEMO in one claim. Merges the record into
 * deployments.v2.volume2.json.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const key = process.env.ACTOR_PRIVATE_KEY;
  if (!key) throw new Error("ACTOR_PRIVATE_KEY env required (beneficiary).");
  const wallet = new ethers.Wallet(key, ethers.provider);
  if ((await ethers.provider.getNetwork()).chainId !== 9800n) {
    throw new Error("Refusing: not Diana (9800).");
  }
  const partial = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments.v2.partial.json"), "utf8")
  );
  const volumePath = path.join(__dirname, "..", "deployments.v2.volume2.json");
  const volume = JSON.parse(fs.readFileSync(volumePath, "utf8"));
  const vest = await ethers.getContractAt("VestCrossV2", partial.contract, wallet);
  const token = await ethers.getContractAt("VestCrossToken", partial.token, wallet);

  const total = BigInt(volume.schedule3.totalAmount);
  for (let i = 0; i < 40; i++) {
    const claimable = await vest.claimableAmount(3);
    console.log(`poll ${i}: claimable=${claimable} / ${total}`);
    if (claimable === total) break;
    if (i === 39) throw new Error("Schedule 3 never became fully claimable.");
    await sleep(15000);
  }
  const balBefore = await token.balanceOf(wallet.address);
  const data = await vest.claim.populateTransaction(3);
  const nonce = await ethers.provider.getTransactionCount(wallet.address, "pending");
  const tx = await wallet.sendTransaction({ to: partial.contract, data: data.data, nonce, gasLimit: 1_500_000n });
  console.log("CLAIM 3 broadcast:", tx.hash);
  const rc = await tx.wait();
  if (rc?.status !== 1) throw new Error(`Claim landed with status ${rc?.status}`);
  const sAfter = await vest.getSchedule(3);
  const balAfter = await token.balanceOf(wallet.address);
  console.log(`claimed=${sAfter.claimedAmount} balBefore=${balBefore} balAfter=${balAfter}`);
  if (sAfter.claimedAmount !== total) throw new Error("Schedule 3 not fully claimed.");
  if (balAfter - balBefore !== total) throw new Error("Beneficiary balance delta mismatch.");

  volume.claim = {
    scheduleId: 3, beneficiary: wallet.address, tx: tx.hash, status: rc.status,
    blockNumber: rc.blockNumber, amount: total.toString(),
    beneficiaryBalanceBefore: balBefore.toString(), beneficiaryBalanceAfter: balAfter.toString(),
  };
  fs.writeFileSync(volumePath, JSON.stringify(volume, null, 2));
  console.log("CLAIM RECORDED");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

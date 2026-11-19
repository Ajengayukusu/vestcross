import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * VestCross v2 VOLUME ROUND 2 — pre-cliff refusal demo (beneficiary idx13).
 * Attempts claim(3) immediately after schedule creation, while the 120 s
 * cliff has NOT elapsed. The transaction must land with status 0
 * (NothingToClaim) and move nothing. Merges the record into
 * deployments.v2.volume2.json.
 */
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

  const s = await vest.getSchedule(3);
  const claimable = await vest.claimableAmount(3);
  const balBefore = await token.balanceOf(wallet.address);
  const now = Math.floor(Date.now() / 1000);
  console.log(`schedule3: start=${s.start} cliff=${s.cliffSeconds} now~${now} claimable=${claimable} balBefore=${balBefore}`);
  if (claimable !== 0n) throw new Error("Expected 0 claimable pre-cliff; refusing to fake a refusal.");

  const data = await vest.claim.populateTransaction(3);
  const nonce = await ethers.provider.getTransactionCount(wallet.address, "pending");
  const tx = await wallet.sendTransaction({ to: partial.contract, data: data.data, nonce, gasLimit: 1_500_000n });
  console.log("PRECLIFF CLAIM broadcast:", tx.hash);
  // NOTE: ethers' tx.wait() throws on status-0 receipts; poll the provider
  // directly so the reverting receipt itself is captured as evidence.
  let rc: ethers.TransactionReceipt | null = null;
  for (let i = 0; i < 25 && !rc; i++) {
    rc = await ethers.provider.getTransactionReceipt(tx.hash);
    if (!rc) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!rc) throw new Error("No receipt for the pre-cliff claim attempt.");
  const balAfter = await token.balanceOf(wallet.address);
  const sAfter = await vest.getSchedule(3);
  console.log(`receipt status=${rc?.status} balAfter=${balAfter} claimedAfter=${sAfter.claimedAmount}`);
  if (rc?.status !== 0) throw new Error("Pre-cliff claim did NOT revert — aborting round.");
  if (balAfter !== balBefore || sAfter.claimedAmount !== 0n) throw new Error("Refusal moved funds — aborting.");

  volume.preCliffRefusal = {
    scheduleId: 3, beneficiary: wallet.address, tx: tx.hash, status: rc.status,
    blockNumber: rc.blockNumber, claimableAtAttempt: claimable.toString(),
    beneficiaryBalanceBefore: balBefore.toString(), beneficiaryBalanceAfter: balAfter.toString(),
    claimedAfter: sAfter.claimedAmount.toString(),
    note: "claim(3) attempted inside the 120 s cliff; on-chain receipt status 0 (NothingToClaim), no payout, no allowance journal.",
  };
  fs.writeFileSync(volumePath, JSON.stringify(volume, null, 2));
  console.log("REFUSAL RECORDED");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

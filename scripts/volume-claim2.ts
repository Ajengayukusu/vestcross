import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * VestCross v2 VOLUME ROUND (19 Nov 2026) — schedule 2 claim (idx1).
 *
 * Companion to volume-claims.ts: that run claimed schedules 0 and 1 and
 * was then interrupted by a service restart while schedule 2 finished
 * vesting (its records were recovered from chain into
 * deployments.v2.volume.json). This script claims schedule 2's full
 * 100,000 vDEMO and appends its record to the same file.
 * Key arrives as ACTOR_PRIVATE_KEY via vc2-run.mjs — never committed.
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

  const claimable = await vest.claimableAmount(2);
  const sBefore = await vest.getSchedule(2);
  console.log(`schedule 2: claimedBefore=${sBefore.claimedAmount} claimable=${claimable}`);
  if (claimable !== sBefore.totalAmount - sBefore.claimedAmount) {
    throw new Error("Schedule 2 is not fully vested yet — refusing a partial claim.");
  }
  const data = await vest.claim.populateTransaction(2);
  const { hash, receipt } = await robustSend(wallet, "CLAIM 2", partial.contract, data.data, 1_500_000n);
  if (receipt.status !== 1) throw new Error(`Claim 2 landed with status ${receipt.status}: ${hash}`);
  let amount = 0n;
  for (const log of receipt.logs ?? []) {
    try {
      const parsed = vest.interface.parseLog(log as any);
      if (parsed && parsed.name === "VestingClaimed") amount = parsed.args.amount as bigint;
    } catch { /* not ours */ }
  }
  const sAfter = await vest.getSchedule(2);
  const balAfter = await token.balanceOf(wallet.address);
  const record = {
    scheduleId: 2, tx: hash, status: receipt.status, blockNumber: receipt.blockNumber,
    amountFromEvent: amount.toString(),
    claimedAmountAfter: sAfter.claimedAmount.toString(),
    beneficiaryTokenBalanceAfter: balAfter.toString(),
  };
  console.log("CLAIM 2 OK:", JSON.stringify(record));
  volume.claims = [...(volume.claims ?? []), record];
  fs.writeFileSync(volumePath, JSON.stringify(volume, null, 2));
  console.log("WROTE", volumePath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

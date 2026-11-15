import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Second live claim on schedule 0 (beneficiary idx1): pays the newly
 * vested delta and accumulates the Native allowance journal. Appends a
 * `claim2` record to deployments.v2.claims.json.
 */
async function main() {
  const key = process.env.ACTOR_PRIVATE_KEY;
  if (!key) throw new Error("ACTOR_PRIVATE_KEY env required (beneficiary).");
  const wallet = new ethers.Wallet(key, ethers.provider);
  if ((await ethers.provider.getNetwork()).chainId !== 9800n) {
    throw new Error("Refusing: not Diana (9800).");
  }
  const partial = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments.v2.partial.json"), "utf8"));
  const claimsPath = path.join(__dirname, "..", "deployments.v2.claims.json");
  const claims = JSON.parse(fs.readFileSync(claimsPath, "utf8"));
  const vest = await ethers.getContractAt("VestCrossV2", partial.contract, wallet);
  const token = await ethers.getContractAt("VestCrossToken", partial.token, wallet);

  const claimable = await vest.claimableAmount(0);
  const balBefore = await token.balanceOf(wallet.address);
  const sBefore = await vest.getSchedule(0);
  console.log(`claimable=${claimable} claimedBefore=${sBefore.claimedAmount} balBefore=${balBefore}`);
  if (claimable === 0n) throw new Error("Nothing new claimable yet.");
  const tx = await vest.claim(0);
  const rc = await tx.wait();
  let amount = 0n;
  for (const log of rc?.logs ?? []) {
    try {
      const parsed = vest.interface.parseLog(log as any);
      if (parsed && parsed.name === "VestingClaimed") amount = parsed.args.amount as bigint;
    } catch { /* not ours */ }
  }
  const sAfter = await vest.getSchedule(0);
  const balAfter = await token.balanceOf(wallet.address);
  claims.claim2 = {
    scheduleId: 0, tx: tx.hash, status: rc?.status ?? null, blockNumber: rc?.blockNumber ?? null,
    amountFromEvent: amount.toString(),
    claimedAmountAfter: sAfter.claimedAmount.toString(),
    beneficiaryTokenBalanceAfter: balAfter.toString(),
  };
  fs.writeFileSync(claimsPath, JSON.stringify(claims, null, 2));
  console.log("CLAIM2 OK:", tx.hash, "amount:", amount.toString(), "totalClaimed:", sAfter.claimedAmount.toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

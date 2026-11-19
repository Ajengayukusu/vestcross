import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * VestCross v2 VOLUME ROUND 2 (19 Nov 2026, upgrade) — deployer side (idx0).
 *
 *   1. Top up the vesting contract with 200,000 more vDEMO (it holds
 *      40,000 unreserved; schedule 3 needs 200,000 reserved).
 *   2. Schedule 3: beneficiary idx13 — a NEW beneficiary never used before
 *      (cosmos qor16eqy7j9x5dyqh9j2l3v3ulkjrq050m3xq4jnya), 200,000 vDEMO,
 *      cliff 120 s, duration 120 s — fully vested 120 s after creation
 *      (same short-schedule pattern the contract already proved with
 *      schedule 2; no time is faked, the wait is real).
 * Target total claimed after the beneficiary claims in full:
 * 210,000 + 200,000 = 410,000 vDEMO.
 * Writes deployments.v2.volume2.json (later scripts merge into it).
 * Key arrives as ACTOR_PRIVATE_KEY via vc2-run.mjs — never committed.
 */
const BENEFICIARY_EVM = "0xD6404F48A6A3480b964afC591E7ED2181F47ee26";
const BENEFICIARY_NATIVE = "qor16eqy7j9x5dyqh9j2l3v3ulkjrq050m3xq4jnya";
const TOPUP = 200_000_000_000n; // 200,000 vDEMO (6 decimals)
const SCHED3_TOTAL = 200_000_000_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function robustSend(
  wallet: ethers.Wallet,
  label: string,
  to: string,
  data: string,
  gasLimit: bigint
): Promise<{ hash: string; status: number | null; blockNumber: number | null }> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const nonce = await ethers.provider.getTransactionCount(wallet.address, "pending");
    const tx = await wallet.sendTransaction({ to, data, nonce, gasLimit });
    console.log(`${label}: broadcast attempt=${attempt} nonce=${nonce} hash=${tx.hash}`);
    for (let i = 0; i < 25; i++) {
      const rc = await ethers.provider.getTransactionReceipt(tx.hash);
      if (rc) return { hash: tx.hash, status: rc.status, blockNumber: rc.blockNumber };
      await sleep(3000);
    }
    console.log(`${label}: no receipt after ~75 s — retrying`);
  }
  throw new Error(`${label}: no receipt after all retries`);
}

async function main() {
  const key = process.env.ACTOR_PRIVATE_KEY;
  if (!key) throw new Error("ACTOR_PRIVATE_KEY env required (deployer).");
  const wallet = new ethers.Wallet(key, ethers.provider);
  if ((await ethers.provider.getNetwork()).chainId !== 9800n) {
    throw new Error("Refusing: not Diana (9800).");
  }
  console.log("Deployer:", wallet.address);

  const partial = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments.v2.partial.json"), "utf8")
  );
  const vest = await ethers.getContractAt("VestCrossV2", partial.contract, wallet);
  const token = await ethers.getContractAt("VestCrossToken", partial.token, wallet);

  const countBefore = await vest.scheduleCount();
  if (countBefore !== 3n) throw new Error(`Expected 3 schedules before this round, found ${countBefore}.`);
  const depBalBefore = await token.balanceOf(wallet.address);
  const unreservedBefore = await vest.unreservedBalance();
  console.log(`before: deployerBal=${depBalBefore} unreserved=${unreservedBefore}`);
  if (depBalBefore < TOPUP) throw new Error("Deployer vDEMO balance too low for the top-up.");

  const fundData = await token.transfer.populateTransaction(partial.contract, TOPUP);
  const fund = await robustSend(wallet, "TOPUP", partial.token, fundData.data, 300_000n);
  if (fund.status !== 1) throw new Error(`Top-up landed with status ${fund.status}`);
  console.log("TOPUP OK:", fund.hash);

  const schedData = await vest.createSchedule.populateTransaction(
    BENEFICIARY_EVM, BENEFICIARY_NATIVE, SCHED3_TOTAL, 120, 120, true
  );
  const sched = await robustSend(wallet, "SCHEDULE3", partial.contract, schedData.data, 600_000n);
  if (sched.status !== 1) throw new Error(`Schedule 3 creation landed with status ${sched.status}`);
  const s3 = await vest.getSchedule(3);
  console.log("SCHEDULE 3 OK:", sched.hash, "start:", s3.start.toString());

  const out = {
    round: "volume2-upgrade-2026-11-19",
    topUp: {
      amount: TOPUP.toString(), tx: fund.hash, status: fund.status,
      blockNumber: fund.blockNumber,
      deployerBalanceBefore: depBalBefore.toString(),
      unreservedBefore: unreservedBefore.toString(),
    },
    schedule3: {
      id: 3, beneficiary: BENEFICIARY_EVM, beneficiaryNative: BENEFICIARY_NATIVE,
      totalAmount: SCHED3_TOTAL.toString(), cliffSeconds: 120, durationSeconds: 120,
      revocable: true, createTx: sched.hash, blockNumber: sched.blockNumber,
      start: s3.start.toString(),
    },
  };
  const file = path.join(__dirname, "..", "deployments.v2.volume2.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("WROTE", file);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

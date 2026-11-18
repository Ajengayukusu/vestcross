import { ethers } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * VestCross v2 VOLUME ROUND (19 Nov 2026) — deployer side (idx0).
 *
 * The first two schedules are fully vested; this round raises the live
 * proven claim volume:
 *   1. Top up the vesting contract with 50,000 more vDEMO (it already
 *      holds 90,000 unreserved; schedule 2 needs 100,000 reserved).
 *   2. Schedule 2: beneficiary idx1, 100,000 vDEMO, cliff 120 s,
 *      duration 120 s — fully vested 120 s after creation, so the
 *      beneficiary can claim it in the same session
 *      (scripts/volume-claims.ts).
 * Writes deployments.v2.volume.json (the claims script merges into it).
 * Key arrives as ACTOR_PRIVATE_KEY via vc2-run.mjs — never committed.
 *
 * idx0 is shared with other testnet work, so sends use an explicit
 * fresh pending nonce per attempt, log the hash at broadcast time, and
 * retry if a concurrent transaction consumes the nonce first.
 */
const BENEFICIARY_EVM = "0x8d0A347d472568DfB6189c84603302d044F0107b";
const BENEFICIARY_NATIVE = "qor1359rgl28y45dldscnjzxqvcz6pz0qyrmjq488c";
const TOPUP = 50_000_000_000n; // 50,000 vDEMO
const SCHED2_TOTAL = 100_000_000_000n; // 100,000 vDEMO

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
    console.log(`${label}: no receipt after ~75 s — nonce likely consumed concurrently; retrying`);
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
  if (countBefore !== 2n) throw new Error(`Expected 2 schedules before this round, found ${countBefore}.`);
  const depBalBefore = await token.balanceOf(wallet.address);
  const vestBalBefore = await token.balanceOf(partial.contract);
  const unreservedBefore = await vest.unreservedBalance();
  console.log(`before: deployerBal=${depBalBefore} vestBal=${vestBalBefore} unreserved=${unreservedBefore}`);
  if (depBalBefore < TOPUP) throw new Error("Deployer vDEMO balance too low for the top-up.");

  // 1. Top up the vesting contract.
  const fundData = await token.transfer.populateTransaction(partial.contract, TOPUP);
  const fund = await robustSend(wallet, "TOPUP", partial.token, fundData.data, 300_000n);
  if (fund.status !== 1) throw new Error(`Top-up landed with status ${fund.status}`);
  console.log("TOPUP OK:", fund.hash);

  // 2. Schedule 2 — short cliff/duration, fully vested at start+120 s.
  const schedData = await vest.createSchedule.populateTransaction(
    BENEFICIARY_EVM, BENEFICIARY_NATIVE, SCHED2_TOTAL, 120, 120, true
  );
  const sched = await robustSend(wallet, "SCHEDULE2", partial.contract, schedData.data, 600_000n);
  if (sched.status !== 1) throw new Error(`Schedule 2 creation landed with status ${sched.status}`);
  const s2 = await vest.getSchedule(2);
  console.log("SCHEDULE 2 OK:", sched.hash, "start:", s2.start.toString());

  const out = {
    round: "volume-2026-11-19",
    topUp: {
      amount: TOPUP.toString(), tx: fund.hash, status: fund.status,
      blockNumber: fund.blockNumber,
      deployerBalanceBefore: depBalBefore.toString(),
      vestingBalanceBefore: vestBalBefore.toString(),
    },
    schedule2: {
      id: 2, beneficiary: BENEFICIARY_EVM, beneficiaryNative: BENEFICIARY_NATIVE,
      totalAmount: SCHED2_TOTAL.toString(), cliffSeconds: 120, durationSeconds: 120,
      revocable: true, createTx: sched.hash, blockNumber: sched.blockNumber,
      start: s2.start.toString(),
    },
  };
  const file = path.join(__dirname, "..", "deployments.v2.volume.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("WROTE", file);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

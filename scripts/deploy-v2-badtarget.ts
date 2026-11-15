import { ethers } from "hardhat";
import { addressesFrom20 } from "@qorechain/sdk";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Deploy the THROWAWAY VestCrossV2 used for the on-chain atomicity proof:
 * identical bytecode, but its Native target is a NON-allowlisted bech32
 * address, so the bridge must refuse every claim with the allowlist error
 * and nothing may move on either lane (see scripts/claim-v2.ts, which
 * performs the refused claim from the beneficiary account).
 *
 *   TOKEN_ADDRESS=0x... DEPLOYER_PRIVATE_KEY=0x... \
 *     npx hardhat run scripts/deploy-v2-badtarget.ts --network diana
 *
 * Steps: deploy throwaway vesting -> setEscrowNativeAddress -> fund it
 * with 10,000 vDEMO from the main token -> create one schedule for idx1
 * (cliff 0, duration 600 s, so a claim reaches the bridge immediately).
 */
const CROSS_VM_PRECOMPILE = "0x0000000000000000000000000000000000000901";
// Valid bech32, provably NOT in bridge_allowed_targets (Phase 1 probes).
const NON_ALLOWLISTED = "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqgcpqu6";
const BENEFICIARY_EVM = "0x8d0A347d472568DfB6189c84603302d044F0107b";
const BENEFICIARY_NATIVE = "qor1359rgl28y45dldscnjzxqvcz6pz0qyrmjq488c";
const FUND_AMOUNT = 10_000_000_000n; // 10,000 vDEMO
const SCHED_TOTAL = 10_000_000_000n;

async function main() {
  const tokenAddr = process.env.TOKEN_ADDRESS;
  if (!tokenAddr) throw new Error("TOKEN_ADDRESS env required.");
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account (DEPLOYER_PRIVATE_KEY).");
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 9800n) throw new Error("Refusing: not Diana (9800).");

  const out: Record<string, unknown> = { token: tokenAddr };

  const Vest = await ethers.getContractFactory("VestCrossV2");
  const vest = await Vest.deploy(CROSS_VM_PRECOMPILE, NON_ALLOWLISTED, tokenAddr);
  await vest.waitForDeployment();
  const vestAddr = await vest.getAddress();
  out.badTargetContract = vestAddr;
  out.badTargetDeployTx = vest.deploymentTransaction()?.hash ?? null;
  out.badTargetNativeTarget = NON_ALLOWLISTED;
  console.log("throwaway VestCrossV2 deployed:", vestAddr, out.badTargetDeployTx);

  const vestNative = addressesFrom20(Buffer.from(vestAddr.slice(2), "hex")).cosmos;
  out.badTargetEscrowNativeAddress = vestNative;
  const txSet = await vest.setEscrowNativeAddress(vestNative);
  await txSet.wait();
  out.badTargetSetEscrowNativeTx = txSet.hash;

  const token = await ethers.getContractAt("VestCrossToken", tokenAddr);
  const txFund = await token.transfer(vestAddr, FUND_AMOUNT);
  await txFund.wait();
  out.badTargetFundTx = txFund.hash;
  console.log("throwaway funded:", txFund.hash);

  const txS = await vest.createSchedule(BENEFICIARY_EVM, BENEFICIARY_NATIVE, SCHED_TOTAL, 0, 600, true);
  await txS.wait();
  out.badTargetSchedule = {
    id: 0, beneficiary: BENEFICIARY_EVM, beneficiaryNative: BENEFICIARY_NATIVE,
    totalAmount: SCHED_TOTAL.toString(), cliffSeconds: 0, durationSeconds: 600,
    revocable: true, createTx: txS.hash,
  };
  console.log("throwaway schedule created:", txS.hash);

  const file = path.join(__dirname, "..", "deployments.v2.badtarget.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("WROTE", file);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

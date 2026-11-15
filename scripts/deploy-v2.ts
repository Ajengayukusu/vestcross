import { ethers } from "hardhat";
import { addressesFrom20 } from "@qorechain/sdk";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Deploy VestCross v2 to QoreChain Diana testnet (EVM chain ID 9800):
 * the VestCrossToken ERC20 + VestCrossV2, then wire and fund the demo.
 *
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy-v2.ts --network diana
 *
 * (In practice the key is injected by foundation-spike/account-tools/
 * vc2-run.mjs from the throwaway work wallet — never committed.)
 *
 * Steps (each one EVM tx inside the deployer's scoped window):
 *   1. Deploy VestCrossToken ("VestCross Demo Token", vDEMO, 6 decimals,
 *      1,000,000 tokens minted to the deployer).
 *   2. Deploy VestCrossV2 (bridge 0x0901, allowlisted WDT, the token).
 *   3. setEscrowNativeAddress(qor1 form of the vesting contract).
 *   4. Fund the vesting contract with 200,000 vDEMO.
 *   5. Schedule 0 (the claim demo): beneficiary idx1, 100,000 vDEMO,
 *      cliff 120 s, duration 1,200 s, revocable.
 *   6. Schedule 1 (the pre-cliff refusal demo): beneficiary idx1,
 *      10,000 vDEMO, cliff 86,400 s, duration 172,800 s, revocable.
 * Writes the results to deployments.v2.partial.json (merged into
 * deployments.testnet.json by the verify step).
 */
const CROSS_VM_PRECOMPILE = "0x0000000000000000000000000000000000000901";
const WDT_CW20 = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
const BENEFICIARY_EVM = "0x8d0A347d472568DfB6189c84603302d044F0107b";
const BENEFICIARY_NATIVE = "qor1359rgl28y45dldscnjzxqvcz6pz0qyrmjq488c";

const TOKEN_SUPPLY = 1_000_000_000_000n; // 1,000,000 vDEMO (6 decimals)
const FUND_AMOUNT = 200_000_000_000n; // 200,000 vDEMO
const SCHED0_TOTAL = 100_000_000_000n; // 100,000 vDEMO
const SCHED1_TOTAL = 10_000_000_000n; // 10,000 vDEMO

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account (DEPLOYER_PRIVATE_KEY).");
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 9800n) {
    throw new Error(`Refusing to deploy: chain ${network.chainId} != Diana 9800.`);
  }
  console.log("Deployer:", deployer.address);
  console.log("Balance (wei):", (await ethers.provider.getBalance(deployer.address)).toString());

  const out: Record<string, unknown> = { network: "qorechain-diana", chainId: 9800, deployer: deployer.address };

  // 1. Token
  const Token = await ethers.getContractFactory("VestCrossToken");
  const token = await Token.deploy("VestCross Demo Token", "vDEMO", 6, TOKEN_SUPPLY);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  out.token = tokenAddr;
  out.tokenDeployTx = token.deploymentTransaction()?.hash ?? null;
  console.log("VestCrossToken deployed:", tokenAddr, out.tokenDeployTx);

  // 2. Vesting
  const Vest = await ethers.getContractFactory("VestCrossV2");
  const vest = await Vest.deploy(CROSS_VM_PRECOMPILE, WDT_CW20, tokenAddr);
  await vest.waitForDeployment();
  const vestAddr = await vest.getAddress();
  out.contract = vestAddr;
  out.deployTx = vest.deploymentTransaction()?.hash ?? null;
  console.log("VestCrossV2 deployed:", vestAddr, out.deployTx);

  // 3. Escrow native address (qor1 form of the vesting contract)
  const vestNative = addressesFrom20(Buffer.from(vestAddr.slice(2), "hex")).cosmos;
  out.escrowNativeAddress = vestNative;
  const txSet = await vest.setEscrowNativeAddress(vestNative);
  await txSet.wait();
  out.setEscrowNativeTx = txSet.hash;
  console.log("escrowNativeAddress set:", vestNative, txSet.hash);

  // 4. Fund
  const txFund = await token.transfer(vestAddr, FUND_AMOUNT);
  await txFund.wait();
  out.fundTx = txFund.hash;
  out.fundAmount = FUND_AMOUNT.toString();
  console.log("funded:", FUND_AMOUNT.toString(), txFund.hash);

  // 5. Schedule 0 — claim demo (cliff 120 s, duration 1,200 s)
  const txS0 = await vest.createSchedule(BENEFICIARY_EVM, BENEFICIARY_NATIVE, SCHED0_TOTAL, 120, 1200, true);
  const r0 = await txS0.wait();
  out.schedule0 = {
    id: 0, beneficiary: BENEFICIARY_EVM, beneficiaryNative: BENEFICIARY_NATIVE,
    totalAmount: SCHED0_TOTAL.toString(), cliffSeconds: 120, durationSeconds: 1200,
    revocable: true, createTx: txS0.hash, blockNumber: r0?.blockNumber ?? null,
  };
  console.log("schedule 0 created:", txS0.hash);

  // 6. Schedule 1 — pre-cliff refusal demo (cliff 1 day)
  const txS1 = await vest.createSchedule(BENEFICIARY_EVM, BENEFICIARY_NATIVE, SCHED1_TOTAL, 86400, 172800, true);
  const r1 = await txS1.wait();
  out.schedule1 = {
    id: 1, beneficiary: BENEFICIARY_EVM, beneficiaryNative: BENEFICIARY_NATIVE,
    totalAmount: SCHED1_TOTAL.toString(), cliffSeconds: 86400, durationSeconds: 172800,
    revocable: true, createTx: txS1.hash, blockNumber: r1?.blockNumber ?? null,
  };
  console.log("schedule 1 created:", txS1.hash);

  const file = path.join(__dirname, "..", "deployments.v2.partial.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("WROTE", file);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

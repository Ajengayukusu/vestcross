import { ethers } from "hardhat";
import { addressesFrom20 } from "@qorechain/sdk";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * RESUME of deploy-v2.ts after the original run was killed by a service
 * restart mid-flight. On-chain reconstruction (vc2-txhistory.mjs) proved
 * exactly one deployment landed from that run: the VestCrossToken at
 * nonce 49. This script verifies that token, then performs the remaining
 * steps of deploy-v2.ts (vesting deploy, escrow-native, funding,
 * schedules 0 and 1) and writes deployments.v2.partial.json.
 */
const CROSS_VM_PRECOMPILE = "0x0000000000000000000000000000000000000901";
const WDT_CW20 = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
const BENEFICIARY_EVM = "0x8d0A347d472568DfB6189c84603302d044F0107b";
const BENEFICIARY_NATIVE = "qor1359rgl28y45dldscnjzxqvcz6pz0qyrmjq488c";
const TOKEN_ADDRESS = "0x93B8F1162c7b153A7F5bd9d3341256188C93D796";
const TOKEN_DEPLOY_TX = "0xd27170cd7d836e44aa9d95a7be78fe247201601d88d6496266486a8f32273c2d";
const TOKEN_DEPLOY_TX_COSMOS = "0F64F649D255777F22461352A79462BCA3AC461A204D65AC6AA3F1B3C5FC8D05";
const TOKEN_SUPPLY = 1_000_000_000_000n;
const FUND_AMOUNT = 200_000_000_000n;
const SCHED0_TOTAL = 100_000_000_000n;
const SCHED1_TOTAL = 10_000_000_000n;

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account (DEPLOYER_PRIVATE_KEY).");
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 9800n) throw new Error("Refusing: not Diana (9800).");
  console.log("Deployer:", deployer.address);

  // Verify the recovered token before building on it.
  const token = await ethers.getContractAt("VestCrossToken", TOKEN_ADDRESS);
  const [name, symbol, decimals, supply, bal] = await Promise.all([
    token.name(), token.symbol(), token.decimals(), token.totalSupply(),
    token.balanceOf(deployer.address),
  ]);
  console.log(`token: ${name} ${symbol} dec=${decimals} supply=${supply} deployerBal=${bal}`);
  if (name !== "VestCross Demo Token" || symbol !== "vDEMO" || decimals !== 6n && Number(decimals) !== 6) {
    throw new Error("Recovered token metadata mismatch — aborting.");
  }
  if (supply !== TOKEN_SUPPLY || bal !== TOKEN_SUPPLY) {
    throw new Error("Recovered token supply/balance mismatch — aborting.");
  }

  const out: Record<string, unknown> = {
    network: "qorechain-diana", chainId: 9800, deployer: deployer.address,
    token: TOKEN_ADDRESS, tokenDeployTx: TOKEN_DEPLOY_TX,
    tokenDeployTxCosmos: TOKEN_DEPLOY_TX_COSMOS,
    note: "Token deployment recovered after the original deploy run was interrupted by a service restart; verified on chain before resuming.",
  };

  const Vest = await ethers.getContractFactory("VestCrossV2");
  const vest = await Vest.deploy(CROSS_VM_PRECOMPILE, WDT_CW20, TOKEN_ADDRESS);
  await vest.waitForDeployment();
  const vestAddr = await vest.getAddress();
  out.contract = vestAddr;
  out.deployTx = vest.deploymentTransaction()?.hash ?? null;
  console.log("VestCrossV2 deployed:", vestAddr, out.deployTx);

  const vestNative = addressesFrom20(Buffer.from(vestAddr.slice(2), "hex")).cosmos;
  out.escrowNativeAddress = vestNative;
  const txSet = await vest.setEscrowNativeAddress(vestNative);
  await txSet.wait();
  out.setEscrowNativeTx = txSet.hash;
  console.log("escrowNativeAddress set:", vestNative, txSet.hash);

  const txFund = await token.transfer(vestAddr, FUND_AMOUNT);
  await txFund.wait();
  out.fundTx = txFund.hash;
  out.fundAmount = FUND_AMOUNT.toString();
  console.log("funded:", FUND_AMOUNT.toString(), txFund.hash);

  const txS0 = await vest.createSchedule(BENEFICIARY_EVM, BENEFICIARY_NATIVE, SCHED0_TOTAL, 120, 1200, true);
  const r0 = await txS0.wait();
  out.schedule0 = {
    id: 0, beneficiary: BENEFICIARY_EVM, beneficiaryNative: BENEFICIARY_NATIVE,
    totalAmount: SCHED0_TOTAL.toString(), cliffSeconds: 120, durationSeconds: 1200,
    revocable: true, createTx: txS0.hash, blockNumber: r0?.blockNumber ?? null,
  };
  console.log("schedule 0 created:", txS0.hash);

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

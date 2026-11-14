import { ethers } from "hardhat";

/**
 * Deploy VestCross to QoreChain Diana testnet (EVM chain ID 9800).
 *
 *   DEPLOYER_PRIVATE_KEY=0x... npx hardhat run scripts/deploy.ts --network diana
 *
 * PREREQUISITES — in this exact order (see README "Bootstrap order" and
 * scripts/plan-live-proof.md for the full cross-VM live-proof sequence):
 *   1. Fund the deployer (coin-type 60 account) from the faucet:
 *      https://dashboard.qorechain.io/faucet  (paste the qor1... address)
 *   2. Register the deployer's ML-DSA-87 key on the native lane — this MUST
 *      be the account's first transaction (MsgRegisterPQCKeyV2 + proof of
 *      possession), e.g. via the QoreChain SDK `ensurePqcRegistered`.
 *   3. Open a SCOPED EVM authorisation window for the deployer whose
 *      allowedTargets / budget cover this deployment (contract creation
 *      consumes one window transaction and its max-fee budget).
 *   4. Only then run this script. Without steps 2–3 the EVM lane rejects the
 *      deployment transaction (pqc codes 26/27/28).
 *   5. AFTER deployment: call `setEscrowNativeAddress(<qor1 form of the
 *      contract address>)` once — the contract's Native account is the
 *      escrow the bridge spends from, and the live-proof flow funds it.
 *
 * On Diana the CrossVM Bridge precompile is a fixed chain address:
 *   0x0000000000000000000000000000000000000901
 * and the bridge reaches only governance-allowlisted Native targets. The
 * CW20 WDT contract below is allowlist entry code 1 (read live from
 * /qorechain/crossvm/v1/params — re-verify before deploying, see the plan).
 */
const CROSS_VM_PRECOMPILE = "0x0000000000000000000000000000000000000901";
const WDT_CW20 = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployer account. Set DEPLOYER_PRIVATE_KEY in the environment."
    );
  }
  const network = await ethers.provider.getNetwork();
  console.log("Deployer:", deployer.address);
  console.log("Chain ID:", network.chainId.toString(), "(expect 9800 = Diana)");
  if (network.chainId !== 9800n) {
    throw new Error("Refusing to deploy: this script targets Diana (9800) only.");
  }
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance (wei):", balance.toString());

  const VestCross = await ethers.getContractFactory("VestCross");
  const vest = await VestCross.deploy(CROSS_VM_PRECOMPILE, WDT_CW20);
  await vest.waitForDeployment();

  const address = await vest.getAddress();
  const tx = vest.deploymentTransaction();
  console.log("VestCross deployed to:", address);
  console.log("Deployment tx hash:", tx?.hash ?? "(unknown)");
  console.log(
    "NEXT STEP: derive the qor1 (Native) form of the contract address above"
  );
  console.log(
    "(bech32, HRP 'qor', same 20 bytes) and call setEscrowNativeAddress(<qor1>)"
  );
  console.log(
    "once, then follow scripts/plan-live-proof.md from step 3 (fund escrow)."
  );
  console.log(
    "Verify on the explorer: https://explore.qore.network (switch to Testnet)"
  );
  console.log(
    JSON.stringify(
      {
        network: "qorechain-diana",
        chainId: 9800,
        contract: "VestCross",
        address,
        deployTx: tx?.hash ?? null,
        crossVmPrecompile: CROSS_VM_PRECOMPILE,
        wdtCw20: WDT_CW20,
        deployer: deployer.address,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

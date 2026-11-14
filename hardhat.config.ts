import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// QoreChain Diana testnet: EVM chain ID 9800, RPC https://evm-testnet.qore.host
// NOTE: deploying to Diana additionally requires, on the deployer account:
//   1. an ML-DSA-87 key registered on the native lane (first tx of the account), and
//   2. an open *scoped* EVM authorisation window that lists this deployment.
// Those steps are done with the QoreChain SDK / QoreX — see README "Bootstrap order"
// and scripts/plan-live-proof.md for the full cross-VM live-proof sequence.
// The DEPLOYER_PRIVATE_KEY is read from the environment only; never commit it.
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    diana: {
      url: "https://evm-testnet.qore.host",
      chainId: 9800,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;

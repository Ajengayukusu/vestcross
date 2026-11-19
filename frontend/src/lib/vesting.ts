/**
 * VestCross — shared vesting logic for the frontend.
 *
 * The math here mirrors the vesting contracts EXACTLY (the demo mode is a
 * faithful simulation of the contract, not an approximation):
 *   - vested = 0 before start+cliff
 *   - vested = total * (t - start) / duration, linear, integer division
 *   - vested = total at/after start+duration
 *   - a revoked schedule vests nothing beyond what was already claimed
 * Amounts are payout-token base units (bigint), matching the contracts:
 * vDEMO base units in the LIVE v2 deployment, WDT base units in the
 * original (undeployed) v1 design.
 */

/** CrossVM Bridge precompile on Diana (chain parameter, verified live). */
export const CROSS_VM_PRECOMPILE =
  "0x0000000000000000000000000000000000000901";
/** executeCrossVMCall(uint8,string,bytes) — the selector the node decodes. */
export const CROSS_VM_SELECTOR = "0x3c11078c";
/** The allowlisted CW20 WDT contract on the Native lane (code id 1). */
export const WDT_CONTRACT =
  "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
/** CrossVM target id for QoreChain Native. */
export const TARGET_VM_NATIVE = 1;

export interface Schedule {
  id: number;
  funder: string;
  beneficiary: string;
  beneficiaryNative: string;
  totalAmount: bigint;
  claimedAmount: bigint;
  start: number; // unix seconds (demo clock in demo mode)
  cliffSeconds: number;
  durationSeconds: number;
  revocable: boolean;
  revoked: boolean;
}

export interface ClaimRecord {
  id: number;
  scheduleId: number;
  at: number; // unix seconds on the active clock
  amount: bigint;
  totalClaimed: bigint;
  status: "success" | "reverted";
  /** What happened on the EVM lane (tx / event / revert). */
  evmSide: string;
  /** What happened on the Native lane (WDT allowance journal / nothing). */
  nativeSide: string;
  /** The exact bridge payload for successful claims. */
  payload?: string;
}

/** Mirror of VestCross.vestedAmountAt (revoked schedules included). */
export function vestedAt(s: Schedule, t: number): bigint {
  if (s.revoked) return s.claimedAmount;
  if (t < s.start + s.cliffSeconds) return 0n;
  if (t >= s.start + s.durationSeconds) return s.totalAmount;
  return (s.totalAmount * BigInt(t - s.start)) / BigInt(s.durationSeconds);
}

/** Mirror of VestCross.claimableAmount. */
export function claimableAt(s: Schedule, t: number): bigint {
  if (s.revoked) return 0n;
  return vestedAt(s, t) - s.claimedAmount;
}

/**
 * The exact CW20 execute message the v1 VestCross.claim sends through the
 * bridge, byte-for-byte identical to the v1 contract's transferPayload().
 * (v1 is not deployed — see LIVE_V2.honestNote below.)
 */
export function transferPayload(recipient: string, amount: bigint): string {
  return `{"transfer":{"recipient":"${recipient}","amount":"${amount.toString()}"}}`;
}

/**
 * The exact CW20 execute message VestCrossV2.claim sends through the
 * bridge, byte-for-byte identical to the v2 contract's
 * increaseAllowancePayload(): every claim journals an allowance on the
 * allowlisted WDT contract for the beneficiary's Native address.
 */
export function journalPayload(spender: string, amount: bigint): string {
  return `{"increase_allowance":{"spender":"${spender}","amount":"${amount.toString()}"}}`;
}

/** 1_000_000 -> "1,000,000" (en-US grouping) */
export function fmtUnits(v: bigint): string {
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fmtDuration(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400} ${sec === 86400 ? "day" : "days"}`;
  if (sec % 3600 === 0) return `${sec / 3600} ${sec === 3600 ? "hour" : "hours"}`;
  if (sec % 60 === 0) return `${sec / 60} ${sec === 60 ? "minute" : "minutes"}`;
  return `${sec} ${sec === 1 ? "second" : "seconds"}`;
}

export function fmtTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString("en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Demo identities (fictional, labelled as demo everywhere) ──────────────
export const DEMO = {
  funder: "0x6E2198c7198Ce3B718DFCf38103120C8346fD28A",
  beneficiary: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  beneficiaryNative: "qor1beneficiarydemo0000000000000000000000000",
  escrowNative: "qor1vestcrossescrowdemo000000000000000000000",
};

/** The refusal string the real bridge produces for non-allowlisted targets. */
export const BRIDGE_REFUSAL =
  "cross-VM bridge call refused: target cosmwasm:<addr> is not allowlisted";

// ── LIVE v2 deployment on Diana (deployed 2026-11-16) ────────────────────
// Verified on chain; full record in deployments.testnet.json
// (v2LiveDeployment) in the repo, re-checkable any time with
// scripts/verify-v2.ts.
export const EXPLORER = "https://explore.qore.network";
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${EXPLORER}/address/${addr}`;

export const LIVE_V2 = {
  status: "LIVE",
  deployedAt: "2026-11-16",
  contract: "0x64ab1fABEA011CA0395Ad835EC38B590CF76C295",
  contractDeployTx:
    "0x259e8a9b0dae0be1adaf799d0fd90db7266ef4a523b1db5e7b8af16021fd8a70",
  contractNative: "qor1vj43l2l2qyw2qw26mq67cw94jr8hds54tqr6k8",
  token: "0x93B8F1162c7b153A7F5bd9d3341256188C93D796",
  tokenName: "VestCross Demo Token",
  tokenSymbol: "vDEMO",
  tokenDecimals: 6,
  tokenDeployTx:
    "0xd27170cd7d836e44aa9d95a7be78fe247201601d88d6496266486a8f32273c2d",
  deployer: "0x6E2198c7198Ce3B718DFCf38103120C8346fD28A",
  beneficiary: "0x8d0A347d472568DfB6189c84603302d044F0107b",
  beneficiaryNative: "qor1359rgl28y45dldscnjzxqvcz6pz0qyrmjq488c",
  claims: [
    {
      amount: "12,000 vDEMO (schedule #0)",
      tx: "0x79cf1cafec24d2f914e2ad14c40951773348fbde9755336129aef6e7f09695e8",
      block: 10160531,
    },
    {
      amount: "5,250 vDEMO (schedule #0)",
      tx: "0x6f6d84ef45d08c610b96c52d46eb7cf224b0fa39919acf9a5156eeae8fa755f1",
      block: 10160574,
    },
    {
      amount: "82,750 vDEMO (schedule #0)",
      tx: "0xa4e7121e4779814798412b1eb71beed1b4b3ba851a76b8588a98fa97b34f23de",
      block: 10334203,
    },
    {
      amount: "10,000 vDEMO (schedule #1)",
      tx: "0x882462cc252271730ad321c95d030d9235c2b05e7bc8253135c01020caec99bb",
      block: 10334205,
    },
    {
      amount: "100,000 vDEMO (schedule #2)",
      tx: "0x630b12471bef687b00d6a4e4f124068069f0b0f7164edf428a964d65406af5ee",
      block: 10334309,
    },
    {
      amount: "200,000 vDEMO (schedule #3)",
      tx: "0xc3167be3119f23d8ed6c63c3f1d0d66042a983b455e119cfd278f3c599de113c",
      block: 10364856,
    },
  ],
  invariant:
    "ERC20 paid to beneficiaries 410,000 vDEMO == WDT allowance journal 410,000 vDEMO == contract claimedAmount 410,000 vDEMO (210,000 beneficiary 1 + 200,000 beneficiary 2)",
  refusals: [
    {
      label: "Pre-cliff claim (schedule #1, 24 h cliff not reached)",
      detail: "reverted with NothingToClaim — nothing moved",
      tx: "0x553c8d8b24ab53a18aa566753e015deca84c7298994f0eabd05f432b80cacdb4",
      block: 10160533,
    },
    {
      label: "Claim via a throwaway deployment pointed at a non-allowlisted Native target",
      detail:
        "reverted with CrossVmCallFailed (bridge allowlist refusal) — payout 0, journal 0, claimed 0",
      tx: "0xc3389c73013b48bdc5b07b8712d4b3e150309716b7ee4cf5f3d09dcd3de9c95b",
      block: 10160553,
    },
    {
      label: "Pre-cliff claim (schedule #3, 120 s cliff not reached)",
      detail: "reverted with NothingToClaim — nothing moved",
      tx: "0x985ed4934a940205eaf316cfd450ac23eab01ad28e0756525918b311effd8401",
      block: 10364820,
    },
  ],
  tests: "70 automated tests pass (33 v1 + 37 v2), including dedicated atomicity suites",
  verifyScript: "scripts/verify-v2.ts",
  honestNote:
    "The Native leg is an allowance journal on the allowlisted WDT contract — no WDT moves and none is paid out; the vested asset is vDEMO, this project's own ERC20 (a test token with no value). The original v1 design — paying the CW20 WDT itself from a Native escrow — remains undeployed: the entire WDT supply sits untouched in its minter's account (its only holder), every acquisition route is closed, and new CW20 instantiation is permissioned shut chain-wide. v1 executes unchanged the moment any WDT becomes obtainable.",
};

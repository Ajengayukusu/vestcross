/**
 * VestCross — shared vesting logic for the frontend.
 *
 * The math here mirrors contracts/VestCross.sol EXACTLY (the demo mode is a
 * faithful simulation of the contract, not an approximation):
 *   - vested = 0 before start+cliff
 *   - vested = total * (t - start) / duration, linear, integer division
 *   - vested = total at/after start+duration
 *   - a revoked schedule vests nothing beyond what was already claimed
 * Amounts are WDT base units (bigint), matching the contract.
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
  /** What happened on the Native lane (CW20 transfer / nothing). */
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
 * The exact CW20 execute message VestCross.claim sends through the bridge,
 * byte-for-byte identical to the contract's transferPayload().
 */
export function transferPayload(recipient: string, amount: bigint): string {
  return `{"transfer":{"recipient":"${recipient}","amount":"${amount.toString()}"}}`;
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

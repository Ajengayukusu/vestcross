/**
 * VestCross — live read layer for QoreChain Diana via @qorechain/evm.
 *
 * Active only when VITE_VESTCROSS_ADDRESS is set (see .env.example). Reads
 * are plain eth_calls against the deployed VestCross contract; this layer
 * never signs or sends anything — claiming from a browser additionally
 * needs a wallet whose account has an open scoped EVM window on the
 * native lane (see README "Bootstrap order").
 */
import { createEvmClient, readContract, PRECOMPILE_ADDRESSES } from "@qorechain/evm";
import type { Address } from "viem";
import type { Schedule } from "./vesting";

const RPC_URL =
  (import.meta.env.VITE_EVM_RPC_URL as string | undefined) ??
  "https://evm-testnet.qore.host";

export const VESTCROSS_ADDRESS = import.meta.env
  .VITE_VESTCROSS_ADDRESS as Address | undefined;

export const isLiveConfigured = Boolean(VESTCROSS_ADDRESS);

export const BRIDGE_ADDRESS = PRECOMPILE_ADDRESSES.crossVmBridge;

const VEST_ABI = [
  {
    type: "function",
    name: "scheduleCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalReserved",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "wdtContract",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "escrowNativeAddress",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "claimableAmount",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getSchedule",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "funder", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "beneficiaryNative", type: "string" },
          { name: "totalAmount", type: "uint256" },
          { name: "claimedAmount", type: "uint256" },
          { name: "start", type: "uint64" },
          { name: "cliffSeconds", type: "uint64" },
          { name: "durationSeconds", type: "uint64" },
          { name: "revocable", type: "bool" },
          { name: "revoked", type: "bool" },
        ],
      },
    ],
  },
] as const;

export interface LiveState {
  schedules: Schedule[];
  claimable: bigint[];
  totalReserved: bigint;
  wdtContract: string;
  escrowNative: string;
}

export async function fetchLiveState(): Promise<LiveState> {
  if (!VESTCROSS_ADDRESS) {
    throw new Error("VITE_VESTCROSS_ADDRESS is not set");
  }
  const evm = await createEvmClient({ rpcUrl: RPC_URL, chainId: 9800 });
  const client = evm.publicClient;
  const base = { address: VESTCROSS_ADDRESS, abi: VEST_ABI } as const;

  const count = (await readContract(client, {
    ...base,
    functionName: "scheduleCount",
  })) as bigint;
  const [totalReserved, wdtContract, escrowNative] = await Promise.all([
    readContract(client, { ...base, functionName: "totalReserved" }) as Promise<bigint>,
    readContract(client, { ...base, functionName: "wdtContract" }) as Promise<string>,
    readContract(client, { ...base, functionName: "escrowNativeAddress" }) as Promise<string>,
  ]);

  const schedules: Schedule[] = [];
  const claimable: bigint[] = [];
  for (let i = 0n; i < count; i++) {
    const raw = (await readContract(client, {
      ...base,
      functionName: "getSchedule",
      args: [i],
    })) as any;
    schedules.push({
      id: Number(i),
      funder: raw.funder as string,
      beneficiary: raw.beneficiary as string,
      beneficiaryNative: raw.beneficiaryNative as string,
      totalAmount: BigInt(raw.totalAmount),
      claimedAmount: BigInt(raw.claimedAmount),
      start: Number(raw.start),
      cliffSeconds: Number(raw.cliffSeconds),
      durationSeconds: Number(raw.durationSeconds),
      revocable: Boolean(raw.revocable),
      revoked: Boolean(raw.revoked),
    });
    claimable.push(
      (await readContract(client, {
        ...base,
        functionName: "claimableAmount",
        args: [i],
      })) as bigint
    );
  }
  return { schedules, claimable, totalReserved, wdtContract, escrowNative };
}

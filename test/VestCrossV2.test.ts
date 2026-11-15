import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * VestCrossV2 test suite.
 *
 * THREE-sided assertion discipline: after EVERY claim attempt — success
 * or failure — the tests check all three legs of the v2 invariant:
 *   EVM payout   : beneficiary's VestCrossToken balance
 *   EVM books    : VestCrossV2 claimedAmount / totalReserved / events
 *   Native side  : MockCrossVmV2's simulated WDT allowance ledger
 *                  (owner = escrow native, spender = beneficiary native)
 * A successful claim must move all three by exactly the same amount; a
 * failed claim must leave all three untouched (the local form of the
 * real bridge's journaling guarantee).
 */

// The REAL allowlisted CW20 WDT contract on Diana (bridge_allowed_targets,
// code id 1) — used verbatim so the payload/target evidence matches what
// the live deployment uses.
const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
// Fictional Native identities for the mock ledger (clearly demo values).
const ESCROW_NATIVE = "qor1vestcrossescrowdemo000000000000000000000";
const BEN_NATIVE = "qor1beneficiarydemo0000000000000000000000000";
const BEN2_NATIVE = "qor1beneficiarytwodemo0000000000000000000000";

const SUPPLY = 10_000_000n; // vDEMO base units minted to the deployer
const TOTAL = 1_000_000n; // per-schedule total (base units)
const CLIFF = 100; // seconds
const DURATION = 1000; // seconds

describe("VestCrossV2", function () {
  let owner: any;
  let funder: any;
  let beneficiary: any;
  let beneficiary2: any;
  let stranger: any;
  let mock: any;
  let token: any;
  let vest: any;

  async function deployAll(fundAmount: bigint = TOTAL * 10n) {
    const Mock = await ethers.getContractFactory("MockCrossVmV2");
    mock = await Mock.deploy();
    const Token = await ethers.getContractFactory("VestCrossToken");
    token = await Token.deploy("VestCross Demo Token", "vDEMO", 6, SUPPLY);
    const Vest = await ethers.getContractFactory("VestCrossV2");
    vest = await Vest.deploy(await mock.getAddress(), WDT, await token.getAddress());
    await vest.setEscrowNativeAddress(ESCROW_NATIVE);
    await mock.setEscrowNative(ESCROW_NATIVE);
    if (fundAmount > 0n) {
      await token.transfer(await vest.getAddress(), fundAmount);
    }
  }

  async function createDefault(revocable = true): Promise<bigint> {
    const tx = await vest
      .connect(funder)
      .createSchedule(
        beneficiary.address,
        BEN_NATIVE,
        TOTAL,
        CLIFF,
        DURATION,
        revocable
      );
    await tx.wait();
    return (await vest.scheduleCount()) - 1n;
  }

  /** Extract the VestingClaimed amount from a claim tx receipt. */
  async function claimedFromReceipt(tx: any): Promise<bigint> {
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      try {
        const parsed = vest.interface.parseLog(log);
        if (parsed && parsed.name === "VestingClaimed") {
          return parsed.args.amount as bigint;
        }
      } catch {
        /* not our log */
      }
    }
    throw new Error("VestingClaimed event not found");
  }

  beforeEach(async function () {
    [owner, funder, beneficiary, beneficiary2, stranger] =
      await ethers.getSigners();
    await deployAll();
  });

  // ────────────────────────────────────────────────────────────────
  describe("deployment & interfaces", function () {
    it("stores the injected bridge, the real WDT target and the payout token", async function () {
      expect(await vest.crossVm()).to.equal(await mock.getAddress());
      expect(await vest.wdtContract()).to.equal(WDT);
      expect(await vest.payoutToken()).to.equal(await token.getAddress());
      expect(await vest.TARGET_VM_NATIVE()).to.equal(1);
    });

    it("the payout token is a fixed-supply 6-decimal ERC20 minted to the deployer", async function () {
      expect(await token.name()).to.equal("VestCross Demo Token");
      expect(await token.symbol()).to.equal("vDEMO");
      expect(await token.decimals()).to.equal(6);
      expect(await token.totalSupply()).to.equal(SUPPLY);
      // deployer kept SUPPLY minus the default funding of the vest contract
      expect(await token.balanceOf(owner.address)).to.equal(SUPPLY - TOTAL * 10n);
      expect(await token.balanceOf(await vest.getAddress())).to.equal(TOTAL * 10n);
    });

    it("uses the chain's real bridge selector 0x3c11078c", async function () {
      expect(await vest.crossVmSelector()).to.equal("0x3c11078c");
    });

    it("rejects a zero bridge address", async function () {
      const Vest = await ethers.getContractFactory("VestCrossV2");
      await expect(
        Vest.deploy(ethers.ZeroAddress, WDT, await token.getAddress())
      ).to.be.revertedWithCustomError(vest, "InvalidCrossVmPrecompile");
    });

    it("rejects an empty WDT contract address", async function () {
      const Vest = await ethers.getContractFactory("VestCrossV2");
      await expect(
        Vest.deploy(await mock.getAddress(), "", await token.getAddress())
      ).to.be.revertedWithCustomError(vest, "InvalidWdtContract");
    });

    it("rejects a zero payout token address", async function () {
      const Vest = await ethers.getContractFactory("VestCrossV2");
      await expect(
        Vest.deploy(await mock.getAddress(), WDT, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vest, "InvalidPayoutToken");
    });

    it("builds the CW20 increase_allowance payload byte-for-byte", async function () {
      const payload = await vest.increaseAllowancePayload("qor1abc", 100n);
      expect(ethers.toUtf8String(payload)).to.equal(
        '{"increase_allowance":{"spender":"qor1abc","amount":"100"}}'
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("escrow native address (one-time setup)", function () {
    it("was set during setup", async function () {
      expect(await vest.escrowNativeAddress()).to.equal(ESCROW_NATIVE);
    });

    it("cannot be set twice", async function () {
      await expect(
        vest.setEscrowNativeAddress("qor1somethingelse000000000000000000")
      ).to.be.revertedWithCustomError(vest, "EscrowNativeAlreadySet");
    });

    it("cannot be set by a non-owner", async function () {
      const Vest = await ethers.getContractFactory("VestCrossV2");
      const fresh: any = await Vest.deploy(
        await mock.getAddress(),
        WDT,
        await token.getAddress()
      );
      await expect(
        fresh.connect(stranger).setEscrowNativeAddress(ESCROW_NATIVE)
      ).to.be.revertedWithCustomError(fresh, "NotOwner");
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("funding & createSchedule", function () {
    it("tracks the unreserved pool: funding in, reservations out", async function () {
      expect(await vest.unreservedBalance()).to.equal(TOTAL * 10n);
      const id = await createDefault();
      expect(id).to.equal(0n);
      expect(await vest.totalReserved()).to.equal(TOTAL);
      expect(await vest.unreservedBalance()).to.equal(TOTAL * 9n);
    });

    it("creates a schedule and emits ScheduleCreated", async function () {
      const startTs = (await time.latest()) + 1000;
      await time.setNextBlockTimestamp(startTs);
      await expect(
        vest
          .connect(funder)
          .createSchedule(beneficiary.address, BEN_NATIVE, TOTAL, CLIFF, DURATION, true)
      )
        .to.emit(vest, "ScheduleCreated")
        .withArgs(0, funder.address, beneficiary.address, BEN_NATIVE, TOTAL, startTs, CLIFF, DURATION, true);
      const s = await vest.getSchedule(0);
      expect(s.totalAmount).to.equal(TOTAL);
      expect(s.claimedAmount).to.equal(0n);
      expect(await vest.scheduleCount()).to.equal(1n);
    });

    it("rejects schedule creation when the escrow pool is unfunded", async function () {
      await deployAll(0n);
      await expect(
        vest
          .connect(funder)
          .createSchedule(beneficiary.address, BEN_NATIVE, TOTAL, CLIFF, DURATION, true)
      ).to.be.revertedWithCustomError(vest, "InsufficientEscrow");
    });

    it("rejects a schedule that exceeds the UNRESERVED remainder", async function () {
      await createDefault(); // reserves TOTAL of the 10*TOTAL pool
      await expect(
        vest
          .connect(funder)
          .createSchedule(beneficiary.address, BEN_NATIVE, TOTAL * 10n, CLIFF, DURATION, true)
      ).to.be.revertedWithCustomError(vest, "InsufficientEscrow");
      // …but exactly the remainder fits.
      await vest
        .connect(funder)
        .createSchedule(beneficiary.address, BEN_NATIVE, TOTAL * 9n, CLIFF, DURATION, true);
      expect(await vest.unreservedBalance()).to.equal(0n);
    });

    it("rejects a zero beneficiary", async function () {
      await expect(
        vest.createSchedule(ethers.ZeroAddress, BEN_NATIVE, TOTAL, CLIFF, DURATION, true)
      ).to.be.revertedWithCustomError(vest, "InvalidBeneficiary");
    });

    it("rejects an empty beneficiary native address", async function () {
      await expect(
        vest.createSchedule(beneficiary.address, "", TOTAL, CLIFF, DURATION, true)
      ).to.be.revertedWithCustomError(vest, "InvalidBeneficiaryNative");
    });

    it("rejects a zero total amount", async function () {
      await expect(
        vest.createSchedule(beneficiary.address, BEN_NATIVE, 0, CLIFF, DURATION, true)
      ).to.be.revertedWithCustomError(vest, "InvalidTotalAmount");
    });

    it("rejects a zero duration", async function () {
      await expect(
        vest.createSchedule(beneficiary.address, BEN_NATIVE, TOTAL, 0, 0, true)
      ).to.be.revertedWithCustomError(vest, "InvalidDuration");
    });

    it("rejects a cliff longer than the duration", async function () {
      await expect(
        vest.createSchedule(beneficiary.address, BEN_NATIVE, TOTAL, DURATION + 1, DURATION, true)
      ).to.be.revertedWithCustomError(vest, "CliffExceedsDuration");
    });

    it("rejects reads of a non-existent schedule", async function () {
      await expect(vest.getSchedule(99)).to.be.revertedWithCustomError(vest, "InvalidSchedule");
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("vesting math (deterministic, via vestedAmountAt)", function () {
    it("vests nothing before the cliff", async function () {
      const id = await createDefault();
      const s = await vest.getSchedule(id);
      expect(await vest.vestedAmountAt(id, s.start + BigInt(CLIFF) - 1n)).to.equal(0n);
    });

    it("jumps to total*cliff/duration at the cliff, then runs linearly to the total", async function () {
      const id = await createDefault();
      const s = await vest.getSchedule(id);
      const start = s.start;
      expect(await vest.vestedAmountAt(id, start + BigInt(CLIFF))).to.equal(
        (TOTAL * BigInt(CLIFF)) / BigInt(DURATION)
      );
      expect(await vest.vestedAmountAt(id, start + 500n)).to.equal(TOTAL / 2n);
      expect(await vest.vestedAmountAt(id, start + BigInt(DURATION))).to.equal(TOTAL);
      expect(await vest.vestedAmountAt(id, start + BigInt(DURATION) + 9999n)).to.equal(TOTAL);
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("claim — the three-way invariant", function () {
    it("reverts before the cliff (nothing vested)", async function () {
      const id = await createDefault();
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "NothingToClaim");
    });

    it("reverts for a non-beneficiary", async function () {
      const id = await createDefault();
      await time.increase(CLIFF + 50);
      await expect(
        vest.connect(stranger).claim(id)
      ).to.be.revertedWithCustomError(vest, "NotBeneficiary");
    });

    it("reverts for an unknown schedule id", async function () {
      await expect(
        vest.connect(beneficiary).claim(42)
      ).to.be.revertedWithCustomError(vest, "InvalidSchedule");
    });

    it("pays the ERC20, journals the allowance and updates the books by the SAME amount", async function () {
      const id = await createDefault();
      await time.increase(500); // half-way: ~500k vested

      const tx = await vest.connect(beneficiary).claim(id);
      const amount = await claimedFromReceipt(tx);
      expect(amount).to.be.gt(0n);

      // Leg 2 (EVM payout)
      expect(await token.balanceOf(beneficiary.address)).to.equal(amount);
      // Leg 1 (Native journal): allowance escrow -> beneficiary native
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(amount);
      // Books
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(amount);
      expect(await vest.totalReserved()).to.equal(TOTAL - amount);
      expect(await vest.claimableAmount(id)).to.equal(0n);
      // The bridge saw exactly the promised call: VM 1, the real WDT
      // target, and the byte-exact increase_allowance payload.
      expect(await mock.lastTargetVm()).to.equal(1);
      expect(await mock.lastTargetContract()).to.equal(WDT);
      expect(await mock.lastPayload()).to.equal(
        ethers.hexlify(await vest.increaseAllowancePayload(BEN_NATIVE, amount))
      );
      expect(await mock.callCount()).to.equal(1n);
    });

    it("rejects a double-claim of the same vested portion", async function () {
      const tx = await vest
        .connect(funder)
        .createSchedule(beneficiary.address, BEN_NATIVE, 1000n, 1000, 1_000_000, true);
      await tx.wait();
      const id = (await vest.scheduleCount()) - 1n;
      await time.increase(500_000); // 500 units vested
      const paid = await claimedFromReceipt(await vest.connect(beneficiary).claim(id));
      expect(paid).to.equal(500n);
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "NothingToClaim");
      expect(await token.balanceOf(beneficiary.address)).to.equal(500n);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(500n);
    });

    it("pays only the newly vested delta on the second claim; the allowance accumulates", async function () {
      const id = await createDefault();
      await time.increase(300);
      const first = await claimedFromReceipt(await vest.connect(beneficiary).claim(id));
      await time.increase(300);
      const second = await claimedFromReceipt(await vest.connect(beneficiary).claim(id));
      expect(second).to.be.gt(0n);
      expect(second).to.be.lt(TOTAL - first);
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(first + second);
      expect(await token.balanceOf(beneficiary.address)).to.equal(first + second);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(first + second);
    });

    it("pays the full remainder after the duration ends; the invariant closes at the total", async function () {
      const id = await createDefault();
      await time.increase(DURATION + 100);
      const amount = await claimedFromReceipt(await vest.connect(beneficiary).claim(id));
      expect(amount).to.equal(TOTAL);
      expect(await token.balanceOf(beneficiary.address)).to.equal(TOTAL);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(TOTAL);
      expect(await vest.claimableAmount(id)).to.equal(0n);
      expect(await vest.totalReserved()).to.equal(0n);
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "NothingToClaim");
    });

    it("keeps two schedules for different beneficiaries fully independent (separate allowance spenders)", async function () {
      const idA = await createDefault();
      const txB = await vest
        .connect(funder)
        .createSchedule(beneficiary2.address, BEN2_NATIVE, TOTAL, CLIFF, DURATION, false);
      await txB.wait();
      const idB = (await vest.scheduleCount()) - 1n;

      await time.increase(400);
      await vest.connect(beneficiary).claim(idA);
      const sB = await vest.getSchedule(idB);
      expect(sB.claimedAmount).to.equal(0n);
      expect(await token.balanceOf(beneficiary2.address)).to.equal(0n);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN2_NATIVE)).to.equal(0n);

      await vest.connect(beneficiary2).claim(idB);
      expect(await token.balanceOf(beneficiary2.address)).to.be.gt(0n);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN2_NATIVE)).to.be.gt(0n);
      // Beneficiary 1's journal entry is untouched by beneficiary 2's claim.
      const sA = await vest.getSchedule(idA);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(sA.claimedAmount);
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("atomicity — a failed Native leg rolls back ALL THREE sides", function () {
    it("bridge refusal reverts the claim: no payout, no journal entry, no bookkeeping", async function () {
      const id = await createDefault();
      await time.increase(500);
      const reason = await mock.refusalReason();
      await mock.setMode(1); // RefuseWithReason

      await expect(vest.connect(beneficiary).claim(id))
        .to.be.revertedWithCustomError(vest, "CrossVmCallFailed")
        .withArgs(reason);

      expect(await token.balanceOf(beneficiary.address)).to.equal(0n);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(0n);
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(0n);
      expect(await vest.totalReserved()).to.equal(TOTAL);
      expect(await vest.claimableAmount(id)).to.be.gt(0n); // still claimable

      // …and the claim still succeeds once the bridge cooperates again.
      await mock.setMode(0); // Success
      const amount = await claimedFromReceipt(await vest.connect(beneficiary).claim(id));
      expect(amount).to.be.gt(0n);
      expect(await token.balanceOf(beneficiary.address)).to.equal(amount);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(amount);
    });

    it("an empty reply (inactive precompile) is treated as failure, never as a paid claim", async function () {
      const id = await createDefault();
      await time.increase(500);
      await mock.setMode(2); // EmptyReply
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "CrossVmEmptyReply");
      expect(await token.balanceOf(beneficiary.address)).to.equal(0n);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(0n);
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(0n);
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("revoke", function () {
    it("funder can revoke before the cliff; the reservation returns to the pool and nothing can be claimed", async function () {
      const id = await createDefault(true);
      await expect(vest.connect(funder).revoke(id))
        .to.emit(vest, "ScheduleRevoked")
        .withArgs(id, funder.address, TOTAL);
      expect(await vest.totalReserved()).to.equal(0n);
      expect(await vest.unreservedBalance()).to.equal(TOTAL * 10n);
      await time.increase(DURATION + 1);
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "ScheduleIsRevoked");
      expect(await token.balanceOf(beneficiary.address)).to.equal(0n);
      expect(await mock.wdtAllowanceOf(ESCROW_NATIVE, BEN_NATIVE)).to.equal(0n);
    });

    it("revoke after the cliff is forbidden — vested rights are untouchable", async function () {
      const id = await createDefault(true);
      await time.increase(CLIFF + 10);
      await expect(
        vest.connect(funder).revoke(id)
      ).to.be.revertedWithCustomError(vest, "RevokeAfterCliff");
    });

    it("a non-funder cannot revoke", async function () {
      const id = await createDefault(true);
      await expect(
        vest.connect(stranger).revoke(id)
      ).to.be.revertedWithCustomError(vest, "NotFunder");
    });

    it("a non-revocable schedule cannot be revoked even before the cliff", async function () {
      const id = await createDefault(false);
      await expect(
        vest.connect(funder).revoke(id)
      ).to.be.revertedWithCustomError(vest, "NotRevocable");
    });

    it("revoking twice reverts", async function () {
      const id = await createDefault(true);
      await vest.connect(funder).revoke(id);
      await expect(
        vest.connect(funder).revoke(id)
      ).to.be.revertedWithCustomError(vest, "AlreadyRevoked");
    });
  });
});

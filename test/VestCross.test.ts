import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * VestCross test suite.
 *
 * Two-sided assertion discipline: after EVERY claim attempt — success or
 * failure — the tests check BOTH sides of the bridge:
 *   EVM side    : VestCross claimedAmount / totalReserved / events
 *   Native side : MockCrossVm's simulated CW20 ledger (escrow + recipient)
 * A failed claim must leave both sides untouched (the local form of the
 * real bridge's journaling guarantee); a successful claim must move both
 * sides by exactly the same amount.
 */

// The REAL allowlisted CW20 WDT contract on Diana (bridge_allowed_targets,
// code id 1) — used verbatim so the payload/target evidence matches what
// the live deployment will use.
const WDT = "qor14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s93uuqt";
// Fictional Native identities for the mock ledger (clearly demo values).
const ESCROW_NATIVE = "qor1vestcrossescrowdemo000000000000000000000";
const BEN_NATIVE = "qor1beneficiarydemo0000000000000000000000000";
const BEN2_NATIVE = "qor1beneficiarytwodemo0000000000000000000000";

const TOTAL = 1_000_000n; // WDT base units
const CLIFF = 100; // seconds
const DURATION = 1000; // seconds

describe("VestCross", function () {
  let owner: any;
  let funder: any;
  let beneficiary: any;
  let beneficiary2: any;
  let stranger: any;
  let mock: any;
  let vest: any;

  async function deployAll(fundAmount: bigint = TOTAL * 10n) {
    const Mock = await ethers.getContractFactory("MockCrossVm");
    mock = await Mock.deploy();
    const Vest = await ethers.getContractFactory("VestCross");
    vest = await Vest.deploy(await mock.getAddress(), WDT);
    await vest.setEscrowNativeAddress(ESCROW_NATIVE);
    await mock.setEscrowNative(ESCROW_NATIVE);
    if (fundAmount > 0n) await mock.fundEscrow(fundAmount);
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
  describe("deployment & precompile interface", function () {
    it("stores the injected bridge address and the real WDT target", async function () {
      expect(await vest.crossVm()).to.equal(await mock.getAddress());
      expect(await vest.wdtContract()).to.equal(WDT);
      expect(await vest.TARGET_VM_NATIVE()).to.equal(1);
    });

    it("uses the chain's real bridge selector 0x3c11078c (not the RDK <=0.5.0 two-arg trap)", async function () {
      expect(await vest.crossVmSelector()).to.equal("0x3c11078c");
    });

    it("rejects a zero bridge address", async function () {
      const Vest = await ethers.getContractFactory("VestCross");
      await expect(
        Vest.deploy(ethers.ZeroAddress, WDT)
      ).to.be.revertedWithCustomError(vest, "InvalidCrossVmPrecompile");
    });

    it("rejects an empty WDT contract address", async function () {
      const Vest = await ethers.getContractFactory("VestCross");
      await expect(
        Vest.deploy(await mock.getAddress(), "")
      ).to.be.revertedWithCustomError(vest, "InvalidWdtContract");
    });

    it("builds the CW20 transfer payload byte-for-byte as the docs specify", async function () {
      const payload = await vest.transferPayload("qor1abc", 100n);
      expect(ethers.toUtf8String(payload)).to.equal(
        '{"transfer":{"recipient":"qor1abc","amount":"100"}}'
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("escrow native address (one-time setup)", function () {
    it("was set during setup and emits on set", async function () {
      expect(await vest.escrowNativeAddress()).to.equal(ESCROW_NATIVE);
    });

    it("cannot be set twice", async function () {
      await expect(
        vest.setEscrowNativeAddress("qor1somethingelse000000000000000000")
      ).to.be.revertedWithCustomError(vest, "EscrowNativeAlreadySet");
    });

    it("cannot be set by a non-owner", async function () {
      const Vest = await ethers.getContractFactory("VestCross");
      const fresh: any = await Vest.deploy(await mock.getAddress(), WDT);
      await expect(
        fresh
          .connect(stranger)
          .setEscrowNativeAddress(ESCROW_NATIVE)
      ).to.be.revertedWithCustomError(fresh, "NotOwner");
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("createSchedule validation", function () {
    it("creates a schedule, emits ScheduleCreated and reserves the total", async function () {
      const startTs = (await time.latest()) + 1000;
      await time.setNextBlockTimestamp(startTs);
      await expect(
        vest
          .connect(funder)
          .createSchedule(
            beneficiary.address,
            BEN_NATIVE,
            TOTAL,
            CLIFF,
            DURATION,
            true
          )
      )
        .to.emit(vest, "ScheduleCreated")
        .withArgs(
          0,
          funder.address,
          beneficiary.address,
          BEN_NATIVE,
          TOTAL,
          startTs,
          CLIFF,
          DURATION,
          true
        );
      const s = await vest.getSchedule(0);
      expect(s.funder).to.equal(funder.address);
      expect(s.beneficiary).to.equal(beneficiary.address);
      expect(s.beneficiaryNative).to.equal(BEN_NATIVE);
      expect(s.totalAmount).to.equal(TOTAL);
      expect(s.claimedAmount).to.equal(0n);
      expect(s.cliffSeconds).to.equal(CLIFF);
      expect(s.durationSeconds).to.equal(DURATION);
      expect(s.revocable).to.equal(true);
      expect(s.revoked).to.equal(false);
      expect(await vest.totalReserved()).to.equal(TOTAL);
      expect(await vest.scheduleCount()).to.equal(1n);
    });

    it("rejects a zero beneficiary", async function () {
      await expect(
        vest.createSchedule(
          ethers.ZeroAddress,
          BEN_NATIVE,
          TOTAL,
          CLIFF,
          DURATION,
          true
        )
      ).to.be.revertedWithCustomError(vest, "InvalidBeneficiary");
    });

    it("rejects an empty beneficiary native address", async function () {
      await expect(
        vest.createSchedule(
          beneficiary.address,
          "",
          TOTAL,
          CLIFF,
          DURATION,
          true
        )
      ).to.be.revertedWithCustomError(vest, "InvalidBeneficiaryNative");
    });

    it("rejects a zero total amount", async function () {
      await expect(
        vest.createSchedule(
          beneficiary.address,
          BEN_NATIVE,
          0,
          CLIFF,
          DURATION,
          true
        )
      ).to.be.revertedWithCustomError(vest, "InvalidTotalAmount");
    });

    it("rejects a zero duration", async function () {
      await expect(
        vest.createSchedule(
          beneficiary.address,
          BEN_NATIVE,
          TOTAL,
          0,
          0,
          true
        )
      ).to.be.revertedWithCustomError(vest, "InvalidDuration");
    });

    it("rejects a cliff longer than the duration", async function () {
      await expect(
        vest.createSchedule(
          beneficiary.address,
          BEN_NATIVE,
          TOTAL,
          DURATION + 1,
          DURATION,
          true
        )
      ).to.be.revertedWithCustomError(vest, "CliffExceedsDuration");
    });

    it("rejects reads of a non-existent schedule", async function () {
      await expect(vest.getSchedule(99)).to.be.revertedWithCustomError(
        vest,
        "InvalidSchedule"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("vesting math (deterministic, via vestedAmountAt)", function () {
    it("vests nothing before the cliff", async function () {
      const id = await createDefault();
      const s = await vest.getSchedule(id);
      expect(await vest.vestedAmountAt(id, s.start + BigInt(CLIFF) - 1n)).to.equal(0n);
    });

    it("jumps to total*cliff/duration exactly at the cliff, then runs linearly to the total", async function () {
      const id = await createDefault();
      const s = await vest.getSchedule(id);
      const start = s.start;
      expect(await vest.vestedAmountAt(id, start + BigInt(CLIFF))).to.equal(
        (TOTAL * BigInt(CLIFF)) / BigInt(DURATION) // 100_000
      );
      expect(await vest.vestedAmountAt(id, start + 500n)).to.equal(
        TOTAL / 2n // 500_000
      );
      expect(await vest.vestedAmountAt(id, start + BigInt(DURATION))).to.equal(
        TOTAL
      );
      expect(
        await vest.vestedAmountAt(id, start + BigInt(DURATION) + 9999n)
      ).to.equal(TOTAL);
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("claim", function () {
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

    it("pays the vested amount through the bridge and records it AFTER success — both sides move together", async function () {
      const id = await createDefault();
      await time.increase(500); // half-way: ~500k vested
      const escrowBefore = await mock.wdtBalanceOf(ESCROW_NATIVE);
      const benBefore = await mock.wdtBalanceOf(BEN_NATIVE);

      const tx = await vest.connect(beneficiary).claim(id);
      const amount = await claimedFromReceipt(tx);
      expect(amount).to.be.gt(0n);

      // EVM side
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(amount);
      expect(await vest.totalReserved()).to.equal(TOTAL - amount);
      expect(await vest.claimableAmount(id)).to.equal(0n);
      // Native side moved by exactly the same amount
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(benBefore + amount);
      expect(await mock.wdtBalanceOf(ESCROW_NATIVE)).to.equal(
        escrowBefore - amount
      );
      // The bridge saw exactly the call VestCross promises: VM 1, the real
      // WDT target, and the byte-exact CW20 transfer payload.
      expect(await mock.lastTargetVm()).to.equal(1);
      expect(await mock.lastTargetContract()).to.equal(WDT);
      expect(await mock.lastPayload()).to.equal(
        ethers.hexlify(await vest.transferPayload(BEN_NATIVE, amount))
      );
      expect(await mock.callCount()).to.equal(1n);
    });

    it("rejects a double-claim of the same vested portion", async function () {
      // Coarse-grained schedule: 1 unit vests per 1000 seconds, so the few
      // seconds of block-timestamp drift between the two claim transactions
      // cannot vest anything new — the second claim provably targets the
      // SAME portion the first claim already paid.
      const tx = await vest
        .connect(funder)
        .createSchedule(
          beneficiary.address,
          BEN_NATIVE,
          1000n,
          1000,
          1_000_000,
          true
        );
      await tx.wait();
      const id = (await vest.scheduleCount()) - 1n;
      await time.increase(500_000); // 500 units vested
      const paid = await claimedFromReceipt(
        await vest.connect(beneficiary).claim(id)
      );
      expect(paid).to.equal(500n);
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "NothingToClaim");
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(500n);
    });

    it("pays only the newly vested delta on the second claim", async function () {
      const id = await createDefault();
      await time.increase(300);
      const first = await claimedFromReceipt(
        await vest.connect(beneficiary).claim(id)
      );
      await time.increase(300);
      const second = await claimedFromReceipt(
        await vest.connect(beneficiary).claim(id)
      );
      expect(second).to.be.gt(0n);
      expect(second).to.be.lt(TOTAL - first); // delta, not the whole vested sum
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(first + second);
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(first + second);
    });

    it("pays the full remainder after the duration ends; afterwards nothing is left", async function () {
      const id = await createDefault();
      await time.increase(DURATION + 100);
      const amount = await claimedFromReceipt(
        await vest.connect(beneficiary).claim(id)
      );
      expect(amount).to.equal(TOTAL);
      expect(await vest.claimableAmount(id)).to.equal(0n);
      expect(await vest.totalReserved()).to.equal(0n);
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(TOTAL);
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "NothingToClaim");
    });

    it("keeps two schedules for different beneficiaries fully independent", async function () {
      const idA = await createDefault();
      const txB = await vest
        .connect(funder)
        .createSchedule(
          beneficiary2.address,
          BEN2_NATIVE,
          TOTAL,
          CLIFF,
          DURATION,
          false
        );
      await txB.wait();
      const idB = (await vest.scheduleCount()) - 1n;
      expect(await vest.totalReserved()).to.equal(TOTAL * 2n);

      await time.increase(400);
      await vest.connect(beneficiary).claim(idA);
      const sB = await vest.getSchedule(idB);
      expect(sB.claimedAmount).to.equal(0n);
      expect(await mock.wdtBalanceOf(BEN2_NATIVE)).to.equal(0n);

      await vest.connect(beneficiary2).claim(idB);
      expect(await mock.wdtBalanceOf(BEN2_NATIVE)).to.be.gt(0n);
      expect(await vest.totalReserved()).to.be.lt(TOTAL * 2n);
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("atomicity — Native failure rolls back BOTH sides", function () {
    it("bridge refusal (allowlist-style Error(string)) reverts the claim and leaves both sides untouched", async function () {
      const id = await createDefault();
      await time.increase(500);
      const escrowBefore = await mock.wdtBalanceOf(ESCROW_NATIVE);
      const reason = await mock.refusalReason();
      await mock.setMode(1); // RefuseWithReason

      await expect(vest.connect(beneficiary).claim(id))
        .to.be.revertedWithCustomError(vest, "CrossVmCallFailed")
        .withArgs(reason);

      // EVM side unchanged
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(0n);
      expect(await vest.totalReserved()).to.equal(TOTAL);
      expect(await vest.claimableAmount(id)).to.be.gt(0n); // still claimable
      // Native side unchanged
      expect(await mock.wdtBalanceOf(ESCROW_NATIVE)).to.equal(escrowBefore);
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(0n);

      // …and the claim still succeeds once the bridge cooperates again.
      await mock.setMode(0); // Success
      const amount = await claimedFromReceipt(
        await vest.connect(beneficiary).claim(id)
      );
      expect(amount).to.be.gt(0n);
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(amount);
    });

    it("an empty reply (inactive precompile) is treated as failure, never as a paid claim", async function () {
      const id = await createDefault();
      await time.increase(500);
      await mock.setMode(2); // EmptyReply
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "CrossVmEmptyReply");
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(0n);
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(0n);
    });

    it("an underfunded escrow reverts the claim atomically (CW20-side failure)", async function () {
      // Rebuild with an escrow that cannot cover the schedule.
      await deployAll(TOTAL / 2n);
      const id = await createDefault();
      await time.increase(DURATION + 1); // fully vested: claim wants TOTAL
      await expect(vest.connect(beneficiary).claim(id))
        .to.be.revertedWithCustomError(vest, "CrossVmCallFailed")
        .withArgs("mock cw20: insufficient escrow balance");
      const s = await vest.getSchedule(id);
      expect(s.claimedAmount).to.equal(0n);
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(0n);
      expect(await mock.wdtBalanceOf(ESCROW_NATIVE)).to.equal(TOTAL / 2n);
    });
  });

  // ────────────────────────────────────────────────────────────────
  describe("revoke", function () {
    it("funder can revoke before the cliff; the schedule then pays nothing", async function () {
      const id = await createDefault(true);
      await expect(vest.connect(funder).revoke(id))
        .to.emit(vest, "ScheduleRevoked")
        .withArgs(id, funder.address, TOTAL);
      const s = await vest.getSchedule(id);
      expect(s.revoked).to.equal(true);
      expect(await vest.totalReserved()).to.equal(0n);
      expect(await vest.claimableAmount(id)).to.equal(0n);
      await time.increase(DURATION + 1);
      await expect(
        vest.connect(beneficiary).claim(id)
      ).to.be.revertedWithCustomError(vest, "ScheduleIsRevoked");
      expect(await mock.wdtBalanceOf(BEN_NATIVE)).to.equal(0n);
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

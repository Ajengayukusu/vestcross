// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../ICrossVm.sol";

/// @title VestCross v2 — cross-VM vesting with a Native allowance journal.
/// @notice Vesting schedules live on the EVM lane and pay out a project
///         ERC20 (`payoutToken`). Every claim ALSO executes, inside the
///         same transaction, a CrossVM Bridge call (precompile 0x0901) to
///         the allowlisted CW20 WDT contract on the Native lane, sending
///         `increase_allowance` for the beneficiary's Native address in
///         exactly the claimed amount. The WDT allowance — owner: this
///         contract's Native account, spender: the beneficiary — is the
///         public Native-side ledger of the vesting:
///
///             ERC20 paid out == WDT allowance == claimedAmount
///
///         for every schedule, verifiable by anyone on both lanes.
///
/// @dev Why v2 exists (the honest version — see README "Why v2 exists"):
///      v1 paid the CW20 WDT itself out of a Native escrow. That design is
///      sound and fully proven locally, but it cannot run live: the whole
///      WDT supply (1,000,000,000 base units) sits untouched in its
///      creator's account, no faucet/AMM/mint/wrap route exists, and new
///      CW20 instantiation is permissioned to `Nobody` chain-wide, so no
///      substitute CW20 can be created either (full investigation in
///      deployments.testnet.json and SELF_TOKEN_ROUTE.md). What the chain
///      DOES allow without any WDT balance is `increase_allowance`: an
///      allowance is a pure ledger entry in cw20-base. v2 therefore moves
///      the vested asset to the EVM lane (a self-issued ERC20, deployed
///      permissionlessly) and journals every claim into the allowlisted
///      Native contract — the shape the fest's own Cross-VM examples call
///      "EVM token with Native vesting".
///
///      Atomicity is unchanged from v1 and remains the point: the bridge
///      journals the nested Native execution against the EVM frame. The
///      bridge call runs FIRST; if it fails (allowlist refusal, CW20
///      error, inactive precompile) the claim reverts before any ERC20
///      moves. If the ERC20 transfer were to fail after the bridge call,
///      the revert rolls the Native allowance back with it. `claimedAmount`
///      is written only after BOTH legs succeeded, so the three-way
///      invariant above can never be violated by a partial claim.
contract VestCrossV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ────────────────────────────────────────────────────────────────────
    // Errors
    // ────────────────────────────────────────────────────────────────────
    error InvalidCrossVmPrecompile();
    error InvalidWdtContract();
    error InvalidPayoutToken();
    error InvalidBeneficiary();
    error InvalidBeneficiaryNative();
    error InvalidTotalAmount();
    error InvalidDuration();
    error CliffExceedsDuration();
    error InsufficientEscrow();
    error InvalidSchedule();
    error NotBeneficiary();
    error NotFunder();
    error NotOwner();
    error NothingToClaim();
    error ScheduleIsRevoked();
    error NotRevocable();
    error AlreadyRevoked();
    error RevokeAfterCliff();
    error EscrowNativeAlreadySet();
    error CrossVmEmptyReply();
    error CrossVmCallFailed(string reason);

    // ────────────────────────────────────────────────────────────────────
    // Constants & configuration
    // ────────────────────────────────────────────────────────────────────

    /// @notice CrossVM target id for QoreChain Native (CosmWasm).
    uint8 public constant TARGET_VM_NATIVE = 1;

    /// @dev Since chain v3.2.5 an active bridge ALWAYS returns
    ///      abi.encode(bytes), i.e. at least 64 bytes. A shorter reply
    ///      means the precompile is inactive (it no-ops with empty
    ///      returndata) — the journal entry provably did not happen, so
    ///      the claim must not count. Same guard as v1.
    uint256 internal constant MIN_CROSSVM_REPLY = 64;

    /// @notice The CrossVM Bridge precompile (0x0901 on Diana). Injected
    ///         so tests can substitute a mock.
    address public immutable crossVm;

    /// @notice Bech32 address of the CW20 contract the Native journal is
    ///         written to (on Diana: the allowlisted WDT contract).
    string public wdtContract;

    /// @notice The ERC20 paid out on claims (the vested asset).
    IERC20 public immutable payoutToken;

    /// @notice Deployer. Only used to set `escrowNativeAddress` once.
    address public owner;

    /// @notice The qor1 (Native) form of THIS contract's address — the
    ///         account the bridge acts for on the Native lane, i.e. the
    ///         OWNER of every WDT allowance this contract grants. Set
    ///         once, right after deployment; informational (the bridge
    ///         derives the Native sender itself) but needed by frontends
    ///         and verifiers to query the allowance ledger.
    string public escrowNativeAddress;

    // ────────────────────────────────────────────────────────────────────
    // Schedules
    // ────────────────────────────────────────────────────────────────────
    struct Schedule {
        address funder; // creator; the only account that may revoke
        address beneficiary; // EVM address allowed to call claim()
        string beneficiaryNative; // qor1 spender of the WDT allowance journal
        uint256 totalAmount; // total ERC20 base units the schedule pays out
        uint256 claimedAmount; // paid out so far (written post-success only)
        uint64 start; // block.timestamp at creation
        uint64 cliffSeconds; // no vesting before start + cliffSeconds
        uint64 durationSeconds; // fully vested at start + durationSeconds
        bool revocable; // funder may revoke — but only before the cliff
        bool revoked;
    }

    Schedule[] private _schedules;

    /// @notice Sum over live schedules of (totalAmount - claimedAmount):
    ///         the payout tokens this contract is committed to pay. Always
    ///         <= the contract's token balance (enforced at creation).
    uint256 public totalReserved;

    // ────────────────────────────────────────────────────────────────────
    // Events
    // ────────────────────────────────────────────────────────────────────
    event ScheduleCreated(
        uint256 indexed scheduleId,
        address indexed funder,
        address indexed beneficiary,
        string beneficiaryNative,
        uint256 totalAmount,
        uint64 start,
        uint64 cliffSeconds,
        uint64 durationSeconds,
        bool revocable
    );

    /// @notice Emitted only after BOTH legs of the claim succeeded: the
    ///         Native allowance journal (bridge) and the ERC20 payout.
    ///         `nativeReply` is the CW20 contract's raw reply as returned
    ///         by the precompile (empty for CW20 allowance messages).
    event VestingClaimed(
        uint256 indexed scheduleId,
        address indexed beneficiary,
        string beneficiaryNative,
        uint256 amount,
        uint256 totalClaimed,
        bytes nativeReply
    );

    event ScheduleRevoked(
        uint256 indexed scheduleId,
        address indexed funder,
        uint256 unvestedAmount
    );

    event EscrowNativeAddressSet(string nativeAddress);

    // ────────────────────────────────────────────────────────────────────
    // Construction
    // ────────────────────────────────────────────────────────────────────
    /// @param crossVmPrecompile  Address of the CrossVM Bridge precompile
    ///                           (0x0000000000000000000000000000000000000901 on Diana).
    /// @param wdtContractAddress Bech32 address of the allowlisted CW20
    ///                           contract used as the Native journal.
    /// @param payoutTokenAddress The ERC20 this contract escrows and pays.
    constructor(
        address crossVmPrecompile,
        string memory wdtContractAddress,
        address payoutTokenAddress
    ) {
        if (crossVmPrecompile == address(0)) {
            revert InvalidCrossVmPrecompile();
        }
        if (bytes(wdtContractAddress).length == 0) {
            revert InvalidWdtContract();
        }
        if (payoutTokenAddress == address(0)) {
            revert InvalidPayoutToken();
        }
        crossVm = crossVmPrecompile;
        wdtContract = wdtContractAddress;
        payoutToken = IERC20(payoutTokenAddress);
        owner = msg.sender;
    }

    /// @notice Record the Native (qor1) form of this contract's address.
    ///         One-time, owner-only.
    function setEscrowNativeAddress(string calldata nativeAddress) external {
        if (msg.sender != owner) revert NotOwner();
        if (bytes(escrowNativeAddress).length != 0) {
            revert EscrowNativeAlreadySet();
        }
        if (bytes(nativeAddress).length == 0) {
            revert InvalidBeneficiaryNative();
        }
        escrowNativeAddress = nativeAddress;
        emit EscrowNativeAddressSet(nativeAddress);
    }

    // ────────────────────────────────────────────────────────────────────
    // Funding & schedule lifecycle
    // ────────────────────────────────────────────────────────────────────
    /// @notice Payout tokens held by this contract that are NOT committed
    ///         to any live schedule — the amount new schedules may reserve.
    ///         Fund the contract by transferring `payoutToken` to it.
    function unreservedBalance() public view returns (uint256) {
        return payoutToken.balanceOf(address(this)) - totalReserved;
    }

    /// @notice Create a vesting schedule, backed by payout tokens already
    ///         transferred to this contract (see `unreservedBalance`).
    /// @param beneficiary       EVM address that may claim (and is paid).
    /// @param beneficiaryNative qor1 address recorded as the spender in
    ///                          the WDT allowance journal for each claim.
    /// @param totalAmount       Total ERC20 base units to vest.
    /// @param cliffSeconds      Seconds from creation before anything vests.
    /// @param durationSeconds   Seconds from creation until fully vested
    ///                          (linear between start and start+duration,
    ///                          zero before the cliff). Must be >= cliff.
    /// @param revocable         If true, the funder may revoke BEFORE the
    ///                          cliff (after the cliff the schedule is
    ///                          irrevocable).
    function createSchedule(
        address beneficiary,
        string calldata beneficiaryNative,
        uint256 totalAmount,
        uint64 cliffSeconds,
        uint64 durationSeconds,
        bool revocable
    ) external returns (uint256 scheduleId) {
        if (beneficiary == address(0)) revert InvalidBeneficiary();
        if (bytes(beneficiaryNative).length == 0) {
            revert InvalidBeneficiaryNative();
        }
        if (totalAmount == 0) revert InvalidTotalAmount();
        if (durationSeconds == 0) revert InvalidDuration();
        if (cliffSeconds > durationSeconds) revert CliffExceedsDuration();
        if (unreservedBalance() < totalAmount) revert InsufficientEscrow();

        scheduleId = _schedules.length;
        _schedules.push(
            Schedule({
                funder: msg.sender,
                beneficiary: beneficiary,
                beneficiaryNative: beneficiaryNative,
                totalAmount: totalAmount,
                claimedAmount: 0,
                start: uint64(block.timestamp),
                cliffSeconds: cliffSeconds,
                durationSeconds: durationSeconds,
                revocable: revocable,
                revoked: false
            })
        );
        totalReserved += totalAmount;

        emit ScheduleCreated(
            scheduleId,
            msg.sender,
            beneficiary,
            beneficiaryNative,
            totalAmount,
            uint64(block.timestamp),
            cliffSeconds,
            durationSeconds,
            revocable
        );
    }

    /// @notice Revoke a schedule. Only the funder, only if revocable, and
    ///         ONLY BEFORE THE CLIFF (same rule as v1). The reservation is
    ///         released back to the unreserved pool; nothing is owed
    ///         pre-cliff because nothing has vested.
    function revoke(uint256 scheduleId) external {
        Schedule storage s = _scheduleAt(scheduleId);
        if (msg.sender != s.funder) revert NotFunder();
        if (!s.revocable) revert NotRevocable();
        if (s.revoked) revert AlreadyRevoked();
        if (block.timestamp >= uint256(s.start) + uint256(s.cliffSeconds)) {
            revert RevokeAfterCliff();
        }
        s.revoked = true;
        uint256 unvested = s.totalAmount - s.claimedAmount;
        totalReserved -= unvested;
        emit ScheduleRevoked(scheduleId, msg.sender, unvested);
    }

    // ────────────────────────────────────────────────────────────────────
    // Claim — the cross-VM payout + journal
    // ────────────────────────────────────────────────────────────────────
    /// @notice Claim everything currently vested. Leg 1 (Native): the
    ///         bridge writes the claim into the WDT allowance journal.
    ///         Leg 2 (EVM): the ERC20 payout. Effects are recorded only
    ///         after both legs succeed; any failure reverts the whole
    ///         transaction, so EVM balances, the contract's accounting and
    ///         the Native allowance can never disagree.
    /// @return amount ERC20 base units paid to the beneficiary.
    function claim(
        uint256 scheduleId
    ) external nonReentrant returns (uint256 amount) {
        Schedule storage s = _scheduleAt(scheduleId);
        if (msg.sender != s.beneficiary) revert NotBeneficiary();
        if (s.revoked) revert ScheduleIsRevoked();

        amount = vestedAmount(scheduleId) - s.claimedAmount;
        if (amount == 0) revert NothingToClaim();

        // Leg 1 — Native journal via the bridge.
        bytes memory payload = increaseAllowancePayload(
            s.beneficiaryNative,
            amount
        );
        bytes memory callData = abi.encodeCall(
            ICrossVm.executeCrossVMCall,
            (TARGET_VM_NATIVE, wdtContract, payload)
        );
        (bool ok, bytes memory ret) = crossVm.call(callData);
        if (!ok) revert CrossVmCallFailed(_revertReason(ret));
        // An inactive precompile returns success + empty data and executed
        // nothing. Never count a claim on an empty reply.
        if (ret.length < MIN_CROSSVM_REPLY) revert CrossVmEmptyReply();
        bytes memory nativeReply = abi.decode(ret, (bytes));

        // Leg 2 — EVM payout. If this reverts, the whole transaction (and
        // with it the journaled Native allowance) rolls back.
        payoutToken.safeTransfer(msg.sender, amount);

        // Effects — strictly AFTER both legs succeeded.
        s.claimedAmount += amount;
        totalReserved -= amount;

        emit VestingClaimed(
            scheduleId,
            msg.sender,
            s.beneficiaryNative,
            amount,
            s.claimedAmount,
            nativeReply
        );
    }

    // ────────────────────────────────────────────────────────────────────
    // Views & helpers
    // ────────────────────────────────────────────────────────────────────
    function scheduleCount() external view returns (uint256) {
        return _schedules.length;
    }

    function getSchedule(
        uint256 scheduleId
    ) external view returns (Schedule memory) {
        return _scheduleAt(scheduleId);
    }

    /// @notice Vested amount right now.
    function vestedAmount(
        uint256 scheduleId
    ) public view returns (uint256) {
        return vestedAmountAt(scheduleId, block.timestamp);
    }

    /// @notice Vested amount at an arbitrary timestamp. Zero before the
    ///         cliff; linear from `start` afterwards; total at/after
    ///         start+duration. A revoked schedule vests nothing beyond
    ///         what was already claimed.
    function vestedAmountAt(
        uint256 scheduleId,
        uint256 timestamp
    ) public view returns (uint256) {
        Schedule storage s = _scheduleAt(scheduleId);
        if (s.revoked) return s.claimedAmount;
        uint256 start = uint256(s.start);
        if (timestamp < start + uint256(s.cliffSeconds)) return 0;
        if (timestamp >= start + uint256(s.durationSeconds)) {
            return s.totalAmount;
        }
        return (s.totalAmount * (timestamp - start)) / uint256(s.durationSeconds);
    }

    /// @notice Amount a claim would pay out right now.
    function claimableAmount(
        uint256 scheduleId
    ) public view returns (uint256) {
        Schedule storage s = _scheduleAt(scheduleId);
        if (s.revoked) return 0;
        return vestedAmount(scheduleId) - s.claimedAmount;
    }

    /// @notice The exact CW20 execute message `claim` sends through the
    ///         bridge, as UTF-8 JSON bytes. Public so frontends, tests and
    ///         the live-proof script can reproduce the payload byte-for-byte.
    /// @dev `spender` is a bech32 address ([a-z0-9] only, no JSON escaping
    ///      needed) and `amount` is a decimal string, per the CW20 spec.
    function increaseAllowancePayload(
        string memory spender,
        uint256 amount
    ) public pure returns (bytes memory) {
        return
            bytes(
                string.concat(
                    '{"increase_allowance":{"spender":"',
                    spender,
                    '","amount":"',
                    _toDecimalString(amount),
                    '"}}'
                )
            );
    }

    /// @notice The function selector this contract uses for the bridge
    ///         (must be 0x3c11078c — see ICrossVm).
    function crossVmSelector() public pure returns (bytes4) {
        return ICrossVm.executeCrossVMCall.selector;
    }

    // ────────────────────────────────────────────────────────────────────
    // Internals
    // ────────────────────────────────────────────────────────────────────
    function _scheduleAt(
        uint256 scheduleId
    ) internal view returns (Schedule storage) {
        if (scheduleId >= _schedules.length) revert InvalidSchedule();
        return _schedules[scheduleId];
    }

    /// @dev Minimal uint -> decimal string (CW20 serialises Uint128 as a
    ///      string). Hand-rolled, as in v1, to keep the deployed bytecode
    ///      free of the Cancun-only `mcopy` paths in OZ 5.6's Bytes lib.
    function _toDecimalString(
        uint256 value
    ) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits = 0;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /// @dev Extract the reason string from a bridge refusal (the bridge
    ///      reverts with Error(string)); pass it through verbatim so an
    ///      on-chain refusal is self-explanatory. Same helper as v1.
    function _revertReason(
        bytes memory ret
    ) internal pure returns (string memory) {
        if (ret.length >= 68) {
            bytes4 selector;
            assembly {
                selector := mload(add(ret, 32))
            }
            if (selector == bytes4(0x08c379a0)) {
                bytes memory encoded = new bytes(ret.length - 4);
                for (uint256 i = 0; i < encoded.length; i++) {
                    encoded[i] = ret[i + 4];
                }
                return abi.decode(encoded, (string));
            }
        }
        return "cross-VM call reverted without a reason string";
    }
}

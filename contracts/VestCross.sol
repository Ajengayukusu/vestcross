// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ICrossVm.sol";

/// @title VestCross — cross-VM vesting for the CW20 WDT token.
/// @notice Vesting schedules live on the EVM lane; the tokens live on the
///         Native (CosmWasm) lane. When a beneficiary claims, this contract
///         pays out by calling the CrossVM Bridge precompile (0x0901), which
///         executes a CW20 `transfer` on the allowlisted WDT contract from
///         this contract's own Native escrow account to the beneficiary's
///         Native address — inside the SAME transaction.
///
///         Atomicity is the point: the bridge journals the nested Native
///         execution against the EVM frame. If the Native leg fails, the
///         precompile call fails, `claim` reverts, and NOTHING is recorded
///         on either side. If the EVM leg were to fail after the call, the
///         Native transfer would be rolled back with it. `claimedAmount` is
///         therefore only ever written AFTER the precompile confirms the
///         Native transfer succeeded.
///
/// @dev Why WDT, and why this shape: on Diana the bridge reaches ONLY the
///      governance allowlist (parameter `bridge_allowed_targets`) and Native
///      contract upload is permissioned shut — nobody can deploy their own
///      CosmWasm contract. The allowlist holds exactly three targets; the
///      CW20 token WDT is the only token among them, so a real cross-VM
///      token flow can only be built on top of it. The WDT address is a
///      constructor argument (dependency injection): production deployments
///      pass the allowlisted Diana address, local tests pass a mock, and a
///      non-allowlisted address can be used to demonstrate the bridge's
///      on-chain refusal (see scripts/plan-live-proof.md).
contract VestCross is ReentrancyGuard {
    // ────────────────────────────────────────────────────────────────────
    // Errors
    // ────────────────────────────────────────────────────────────────────
    error InvalidCrossVmPrecompile();
    error InvalidWdtContract();
    error InvalidBeneficiary();
    error InvalidBeneficiaryNative();
    error InvalidTotalAmount();
    error InvalidDuration();
    error CliffExceedsDuration();
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

    /// @notice CrossVM target id for QoreChain Native (CosmWasm) — the only
    ///         target VM the bridge supports.
    uint8 public constant TARGET_VM_NATIVE = 1;

    /// @dev Since chain v3.2.5 an active bridge ALWAYS returns
    ///      abi.encode(bytes), i.e. at least 64 bytes. A shorter reply means
    ///      the precompile is inactive (it no-ops with empty returndata) or
    ///      the callee is not really behind the bridge — either way the
    ///      transfer provably did not happen, so the claim must not count.
    uint256 internal constant MIN_CROSSVM_REPLY = 64;

    /// @notice The CrossVM Bridge precompile (0x0901 on Diana). Injected so
    ///         tests can substitute MockCrossVm.
    address public immutable crossVm;

    /// @notice Bech32 address of the CW20 token contract on the Native lane
    ///         (on Diana: the allowlisted WDT contract). Injected for the
    ///         same reason as `crossVm`.
    string public wdtContract;

    /// @notice Deployer. Only used to set `escrowNativeAddress` once.
    address public owner;

    /// @notice The qor1 (Native) form of THIS contract's address — the
    ///         escrow account that holds the WDT the bridge spends. The
    ///         bridge derives the Native sender from the calling contract,
    ///         so this is informational (funding target + frontend display);
    ///         it is set once, right after deployment, and can never change.
    string public escrowNativeAddress;

    // ────────────────────────────────────────────────────────────────────
    // Schedules
    // ────────────────────────────────────────────────────────────────────
    struct Schedule {
        address funder; // creator; the only account that may revoke
        address beneficiary; // EVM address allowed to call claim()
        string beneficiaryNative; // qor1 recipient of the CW20 transfers
        uint256 totalAmount; // total WDT (base units) the schedule pays out
        uint256 claimedAmount; // WDT already paid out (written post-success)
        uint64 start; // block.timestamp at creation
        uint64 cliffSeconds; // no vesting before start + cliffSeconds
        uint64 durationSeconds; // fully vested at start + durationSeconds
        bool revocable; // funder may revoke — but only before the cliff
        bool revoked;
    }

    Schedule[] private _schedules;

    /// @notice Sum over live schedules of (totalAmount - claimedAmount):
    ///         the WDT the escrow account is currently committed to pay.
    uint256 public totalReserved;

    // ────────────────────────────────────────────────────────────────────
    // Events — the two-sided receipt of every payout
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

    /// @notice Emitted only after the bridge confirmed the Native transfer.
    ///         `nativeReply` is the CW20 contract's raw reply as returned by
    ///         the precompile (empty for a CW20 transfer) — together with the
    ///         EVM transaction receipt this is the two-sided proof of a claim:
    ///         EVM event + Native balance delta (see plan-live-proof.md).
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
    /// @param wdtContractAddress Bech32 address of the CW20 WDT contract.
    constructor(address crossVmPrecompile, string memory wdtContractAddress) {
        if (crossVmPrecompile == address(0)) {
            revert InvalidCrossVmPrecompile();
        }
        if (bytes(wdtContractAddress).length == 0) {
            revert InvalidWdtContract();
        }
        crossVm = crossVmPrecompile;
        wdtContract = wdtContractAddress;
        owner = msg.sender;
    }

    /// @notice Record the Native (qor1) form of this contract's address.
    ///         One-time, owner-only: it is the funding target for the escrow
    ///         and must never be rewritable after schedules exist.
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
    // Schedule lifecycle
    // ────────────────────────────────────────────────────────────────────
    /// @notice Create a vesting schedule. Creation is pure EVM bookkeeping:
    ///         the WDT itself stays in this contract's Native escrow
    ///         account (funded on the Native lane — see README); the
    ///         schedule is a claim against that account, enforced at claim
    ///         time by the bridge + the CW20 contract itself.
    /// @param beneficiary       EVM address that may claim.
    /// @param beneficiaryNative qor1 address that receives the WDT.
    /// @param totalAmount       Total WDT base units to vest.
    /// @param cliffSeconds      Seconds from creation before anything vests.
    /// @param durationSeconds   Seconds from creation until fully vested
    ///                          (linear between start and start+duration,
    ///                          zero before the cliff). Must be >= cliff.
    /// @param revocable         If true, the funder may revoke BEFORE the
    ///                          cliff (after the cliff the schedule is
    ///                          irrevocable — the beneficiary's vested
    ///                          portion can never be taken away).
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

    /// @notice Revoke a schedule. Only the funder, only if the schedule was
    ///         created revocable, and ONLY BEFORE THE CLIFF — once vesting
    ///         has begun the beneficiary's claim is untouchable. A revoked
    ///         schedule pays nothing further (pre-cliff nothing has vested,
    ///         so nothing is owed) and its reservation is released.
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
    // Claim — the cross-VM payout
    // ────────────────────────────────────────────────────────────────────
    /// @notice Claim everything currently vested. Builds the CW20 transfer
    ///         message, executes it on the Native lane through the bridge,
    ///         and records the claim ONLY after the bridge confirms success.
    ///         Any failure — bridge refusal, CW20 error, inactive
    ///         precompile — reverts the whole transaction, so the EVM state
    ///         and the Native balances can never disagree.
    /// @return amount WDT base units transferred to the beneficiary.
    function claim(
        uint256 scheduleId
    ) external nonReentrant returns (uint256 amount) {
        Schedule storage s = _scheduleAt(scheduleId);
        if (msg.sender != s.beneficiary) revert NotBeneficiary();
        if (s.revoked) revert ScheduleIsRevoked();

        amount = vestedAmount(scheduleId) - s.claimedAmount;
        if (amount == 0) revert NothingToClaim();

        bytes memory payload = transferPayload(s.beneficiaryNative, amount);
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

        // Effects — strictly AFTER the Native leg succeeded.
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
    ///         cliff; linear from `start` afterwards (so exactly at the
    ///         cliff the vested amount jumps to total*cliff/duration);
    ///         total at/after start+duration. A revoked schedule vests
    ///         nothing beyond what was already claimed (pre-cliff that is
    ///         zero), so claimable-of-revoked is always zero.
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
    ///         bridge, as UTF-8 JSON bytes — the same shape the QoreChain
    ///         docs use for CW20 transfers. Public so frontends, tests and
    ///         the live-proof script can reproduce the payload byte-for-byte.
    /// @dev `recipient` is a bech32 address ([a-z0-9] only, no JSON escaping
    ///      needed) and `amount` is a decimal string, per the CW20 spec
    ///      (Uint128 serialises as a string).
    function transferPayload(
        string memory recipient,
        uint256 amount
    ) public pure returns (bytes memory) {
        return
            bytes(
                string.concat(
                    '{"transfer":{"recipient":"',
                    recipient,
                    '","amount":"',
                    _toDecimalString(amount),
                    '"}}'
                )
            );
    }

    /// @notice The function selector this contract uses for the bridge —
    ///         exposed so anyone can check it against the chain's decoder
    ///         (must be 0x3c11078c; the RDK <=0.5.0 two-argument encoding
    ///         produces a different selector and never reaches the bridge).
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
    ///      string). Hand-rolled instead of OpenZeppelin Strings so the
    ///      deployed bytecode avoids the Cancun-only `mcopy` paths that
    ///      OZ 5.6's Bytes library pulls into the compile graph.
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

    /// @dev Extract the reason string from a bridge refusal. The bridge
    ///      reverts with Error(string); pass that reason through verbatim so
    ///      a refusal on chain is self-explanatory (e.g. the allowlist
    ///      message). Anything else collapses to a generic reason.
    function _revertReason(
        bytes memory ret
    ) internal pure returns (string memory) {
        // Error(string) layout: 4-byte selector 0x08c379a0, then
        // abi.encode(string) = offset (32) + length (32) + data.
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

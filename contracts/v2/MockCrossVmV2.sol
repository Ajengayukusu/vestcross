// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../ICrossVm.sol";

/// @title MockCrossVmV2 — local stand-in for the CrossVM Bridge precompile
///        AND for the CW20 WDT allowance ledger behind it (tests only).
/// @notice Mirrors MockCrossVm's behaviour contract (chain v3.2.5+
///         semantics), but emulates the message VestCrossV2 sends:
///
///         - SUCCESS mode: parses the CW20 `increase_allowance` JSON
///           payload and credits the simulated allowance ledger —
///           allowance(owner = `escrowNative`, the Native identity the
///           bridge acts for, i.e. the calling contract's qor1 form;
///           spender = the payload's spender) — then returns bytes(""),
///           which the typed interface wraps in abi.encode(bytes),
///           exactly like the real bridge's >= 64-byte reply.
///         - REFUSE mode: reverts with an Error(string) reason, mirroring
///           the real bridge's allowlist refusal message.
///         - EMPTY mode: returns success with EMPTY returndata, mirroring
///           an INACTIVE precompile — the trap VestCrossV2's reply-length
///           check exists to catch.
///
///         Unlike a CW20 `transfer`, `increase_allowance` never checks a
///         balance — that is precisely why the v2 design works live with
///         a zero WDT balance everywhere. The mock therefore has no
///         balance ledger and no insufficient-funds path.
///
/// @dev Test tooling only: the "ledger" is a keyed hash map and the JSON
///      parsing is a naive scan that only has to handle payloads
///      VestCrossV2 itself produces. Never deploy to a network with value.
contract MockCrossVmV2 is ICrossVm {
    enum Mode {
        Success,
        RefuseWithReason,
        EmptyReply
    }

    Mode public mode;

    /// @notice The refusal text used in RefuseWithReason mode — defaults
    ///         to the real bridge's allowlist refusal wording.
    string public refusalReason =
        "cross-VM bridge call refused: target cosmwasm:qor1mock000000000000000000000000000000000000 is not allowlisted";

    // Last call received (observable after successful calls; a reverting
    // call rolls these back too, exactly like on chain).
    uint8 public lastTargetVm;
    string public lastTargetContract;
    bytes public lastPayload;
    uint256 public callCount;

    /// @notice Simulated Native identity of the caller (the allowance
    ///         OWNER the bridge would act for). Set by tests to the
    ///         vesting contract's fictional Native address.
    string public escrowNative;

    /// @dev Simulated CW20 allowances, keyed by
    ///      keccak256(owner) -> keccak256(spender) -> amount.
    mapping(bytes32 => mapping(bytes32 => uint256)) private _allowances;

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function setRefusalReason(string calldata reason) external {
        refusalReason = reason;
    }

    function setEscrowNative(string calldata account) external {
        escrowNative = account;
    }

    function wdtAllowanceOf(
        string calldata ownerAccount,
        string calldata spender
    ) external view returns (uint256) {
        return _allowances[_key(ownerAccount)][_key(spender)];
    }

    function executeCrossVMCall(
        uint8 targetVM,
        string calldata targetContract,
        bytes calldata payload
    ) external override returns (bytes memory) {
        callCount += 1;
        lastTargetVm = targetVM;
        lastTargetContract = targetContract;
        lastPayload = payload;

        if (mode == Mode.RefuseWithReason) {
            // The real bridge reverts with Error(string).
            require(false, refusalReason);
        }
        if (mode == Mode.EmptyReply) {
            // An inactive precompile: success, empty returndata, no effect.
            assembly {
                return(0, 0)
            }
        }

        // Success: emulate the CW20 increase_allowance on the ledger.
        (string memory spender, uint256 amount) = _parseIncreaseAllowance(
            payload
        );
        _allowances[_key(escrowNative)][_key(spender)] += amount;

        // A CW20 increase_allowance returns no data.
        return bytes("");
    }

    // ────────────────────────────────────────────────────────────────────
    // Naive payload parsing — test tooling only. Handles exactly the
    // payload shape VestCrossV2.increaseAllowancePayload produces:
    // {"increase_allowance":{"spender":"<bech32>","amount":"<uint128>"}}
    // ────────────────────────────────────────────────────────────────────
    function _key(string memory account) internal pure returns (bytes32) {
        return keccak256(bytes(account));
    }

    function _find(
        bytes memory haystack,
        bytes memory needle
    ) internal pure returns (uint256 index, bool found) {
        if (needle.length == 0 || haystack.length < needle.length) {
            return (0, false);
        }
        for (uint256 i = 0; i + needle.length <= haystack.length; i++) {
            bool same = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    same = false;
                    break;
                }
            }
            if (same) return (i, true);
        }
        return (0, false);
    }

    function _parseIncreaseAllowance(
        bytes memory payload
    ) internal pure returns (string memory spender, uint256 amount) {
        // spender: after `"spender":"` up to the next `"`.
        (uint256 idx, bool ok) = _find(payload, bytes('"spender":"'));
        require(ok, "mock: malformed payload (spender)");
        uint256 start = idx + 11; // length of `"spender":"`
        uint256 end = start;
        while (end < payload.length && payload[end] != bytes1('"')) {
            end++;
        }
        require(end < payload.length, "mock: malformed payload (spender end)");
        bytes memory r = new bytes(end - start);
        for (uint256 i = 0; i < r.length; i++) {
            r[i] = payload[start + i];
        }
        spender = string(r);

        // amount: after `"amount":"`, decimal digits up to the closing `"`.
        (idx, ok) = _find(payload, bytes('"amount":"'));
        require(ok, "mock: malformed payload (amount)");
        start = idx + 10; // length of `"amount":"`
        end = start;
        uint256 value = 0;
        while (end < payload.length && payload[end] != bytes1('"')) {
            uint8 digit = uint8(payload[end]) - 48; // '0'
            require(digit <= 9, "mock: malformed payload (amount digit)");
            value = value * 10 + digit;
            end++;
        }
        amount = value;
    }
}

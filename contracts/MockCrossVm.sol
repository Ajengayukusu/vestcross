// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ICrossVm.sol";

/// @title MockCrossVm — local stand-in for the CrossVM Bridge precompile AND
///        for the CW20 WDT contract behind it (tests only).
/// @notice Reproduces the *behaviour contract* of 0x0901 on Diana (chain
///         v3.2.5+ semantics) closely enough to prove VestCross's logic:
///
///         - SUCCESS mode: parses the CW20 `transfer` JSON payload, debits
///           the simulated escrow account (`escrowNative` — the Native
///           identity the bridge would act for, i.e. the calling contract's
///           qor1 form) and credits the recipient, then returns
///           `bytes("")` — a CW20 transfer returns no data, and the typed
///           return wraps it in abi.encode(bytes), exactly like the real
///           bridge's >= 64-byte reply.
///         - REFUSE mode: reverts with an Error(string) reason, mirroring
///           the real bridge's allowlist refusal message.
///         - EMPTY mode: returns success with EMPTY returndata, mirroring
///           an INACTIVE precompile (mainnet behaviour) — the trap that
///           VestCross's reply-length check exists to catch.
///         - An underfunded escrow reverts the transfer, mirroring a CW20
///           insufficient-balance error.
///
///         Because a reverting claim rolls back the whole transaction, the
///         mock's ledger and VestCross's `claimedAmount` move together or
///         not at all — the tests assert both sides after every failure,
///         which is the local form of the bridge's journaling guarantee.
///
/// @dev This is NOT the bridge and NOT cryptography: the "ledger" is a
///      keyed hash map and the JSON parsing is a naive scan that only has
///      to handle payloads VestCross itself produces. Never deploy this
///      mock to a network with real value.
contract MockCrossVm is ICrossVm {
    enum Mode {
        Success,
        RefuseWithReason,
        EmptyReply
    }

    Mode public mode;

    /// @notice The refusal text used in RefuseWithReason mode — defaults to
    ///         the real bridge's allowlist refusal wording.
    string public refusalReason =
        "cross-VM bridge call refused: target cosmwasm:qor1mock000000000000000000000000000000000000 is not allowlisted";

    // Last call received (observable after successful calls; a reverting
    // call rolls these back too, exactly like on chain).
    uint8 public lastTargetVm;
    string public lastTargetContract;
    bytes public lastPayload;
    uint256 public callCount;

    /// @notice Simulated Native identity of the caller (the escrow account
    ///         whose WDT the bridge spends). Set by tests to VestCross's
    ///         fictional Native address.
    string public escrowNative;

    /// @dev Simulated CW20 balances, keyed by keccak256(bech32 address).
    mapping(bytes32 => uint256) private _wdtBalances;

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function setRefusalReason(string calldata reason) external {
        refusalReason = reason;
    }

    function setEscrowNative(string calldata account) external {
        escrowNative = account;
    }

    /// @notice Test faucet: credit the escrow account with simulated WDT.
    function fundEscrow(uint256 amount) external {
        _wdtBalances[_key(escrowNative)] += amount;
    }

    /// @notice Credit any account directly (test setup).
    function fundAccount(string calldata account, uint256 amount) external {
        _wdtBalances[_key(account)] += amount;
    }

    function wdtBalanceOf(
        string calldata account
    ) external view returns (uint256) {
        return _wdtBalances[_key(account)];
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

        // Success: emulate the CW20 transfer on the simulated ledger.
        (string memory recipient, uint256 amount) = _parseTransfer(payload);
        bytes32 fromKey = _key(escrowNative);
        require(
            _wdtBalances[fromKey] >= amount,
            "mock cw20: insufficient escrow balance"
        );
        _wdtBalances[fromKey] -= amount;
        _wdtBalances[_key(recipient)] += amount;

        // A CW20 transfer returns no data.
        return bytes("");
    }

    // ────────────────────────────────────────────────────────────────────
    // Naive payload parsing — test tooling only. Handles exactly the
    // payload shape VestCross.transferPayload produces:
    // {"transfer":{"recipient":"<bech32>","amount":"<uint128-as-string>"}}
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

    function _parseTransfer(
        bytes memory payload
    ) internal pure returns (string memory recipient, uint256 amount) {
        // recipient: after `"recipient":"` up to the next `"`.
        (uint256 idx, bool ok) = _find(payload, bytes('"recipient":"'));
        require(ok, "mock: malformed payload (recipient)");
        uint256 start = idx + 13; // length of `"recipient":"`
        uint256 end = start;
        while (end < payload.length && payload[end] != bytes1('"')) {
            end++;
        }
        require(end < payload.length, "mock: malformed payload (recipient end)");
        bytes memory r = new bytes(end - start);
        for (uint256 i = 0; i < r.length; i++) {
            r[i] = payload[start + i];
        }
        recipient = string(r);

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

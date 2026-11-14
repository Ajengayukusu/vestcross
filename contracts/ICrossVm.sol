// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICrossVm — QoreChain CrossVM Bridge precompile (0x0901).
/// @notice Source of truth: the official QoreChain documentation —
///         "Multi-VM (cross-VM calls)" (docs.qorechain.io/rollups/multi-vm)
///         and "Cross-VM Interoperability"
///         (docs.qorechain.io/developer-guide/cross-vm-interoperability),
///         cross-checked against the chain parameters read live from Diana.
///
///         The node decodes exactly ONE function on this precompile:
///
///             executeCrossVMCall(uint8 targetVM, string targetContract, bytes payload)
///
///         function selector 0x3c11078c.
///
/// @dev WARNING — historical trap: `@qorechain/rdk` 0.5.0 and earlier (and the
///      `CrossVmCaller.sol` starter shipped with those releases) encoded
///      `executeCrossVMCall(string,bytes)` — a DIFFERENT selector that never
///      reaches the precompile. RDK 0.6.0+ encodes the 3-argument form below,
///      which is what the node decodes. Do not "simplify" this signature.
///
///      Behaviour on Diana (chain v3.2.5 semantics; the testnet runs v3.2.8):
///      - `targetVM` 1 = QoreChain Native (CosmWasm) — the ONLY supported
///        target. EVM-to-EVM through the bridge is refused.
///      - `payload` is the target contract's execute message as UTF-8 JSON
///        bytes, e.g. a CW20 transfer:
///        {"transfer":{"recipient":"qor1...","amount":"100"}}
///      - Only governance-allowlisted Native targets are reachable (chain
///        parameter `bridge_allowed_targets`, entries `<vm>:<contract>`).
///        Refusals REVERT with `Error(string)`, e.g.
///        "cross-VM bridge call refused: target cosmwasm:<addr> is not allowlisted".
///      - Since v3.2.5 the precompile returns `abi.encode(bytes)`: when it is
///        active the reply is ALWAYS at least 64 bytes; decode the callee's
///        raw return value with `abi.decode(ret, (bytes))`.
///      - The nested Native execution is JOURNALED against the EVM frame:
///        if the calling EVM transaction reverts, the Native side is rolled
///        back too — and a Native failure reverts the EVM side. One
///        transaction, both VMs, all-or-nothing.
///      - The precompile refuses STATICCALL and meters the nested call
///        against the calling frame's remaining gas.
///      - On a network where the precompile is INACTIVE (mainnet today) a
///        call to 0x0901 SUCCEEDS WITH EMPTY RETURNDATA and executes
///        nothing. The `ok` flag alone therefore proves nothing — callers
///        MUST validate the reply (VestCross requires >= 64 bytes).
interface ICrossVm {
    /// @param targetVM       Target VM id. 1 = QoreChain Native (CosmWasm).
    /// @param targetContract Bech32 address of the Native contract
    ///                       (must be in `bridge_allowed_targets`).
    /// @param payload        Execute message for the target, UTF-8 JSON bytes.
    /// @return result        The target contract's raw reply bytes (the
    ///                       precompile's abi.encode(bytes) wrapper is
    ///                       unwrapped by this typed declaration).
    function executeCrossVMCall(
        uint8 targetVM,
        string calldata targetContract,
        bytes calldata payload
    ) external returns (bytes memory result);
}

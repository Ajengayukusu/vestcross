// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title VestCrossToken — the EVM-lane vesting asset for VestCross v2.
/// @notice A plain, fixed-supply ERC20 issued by this project on the Diana
///         testnet. It exists because the v1 design's asset (the CW20 WDT
///         on the Native lane) cannot be obtained by anyone: the entire
///         WDT supply sits in its creator's account, and new CW20
///         instantiation is permissioned shut chain-wide (see README,
///         "Why v2 exists"). EVM deployment is permissionless, so the
///         vested asset lives here; the Native lane still participates in
///         every claim through the bridge journal (see VestCrossV2).
/// @dev 6 decimals, mirroring WDT, so amounts in the EVM payout and the
///      Native allowance journal are directly comparable base units.
///      The full supply is minted once, to the deployer, in the
///      constructor. There is no mint function and no owner.
contract VestCrossToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _mint(msg.sender, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

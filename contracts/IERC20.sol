// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @notice The minimal ERC20 surface EvmHashRail needs. Deliberately not the full
/// standard (no metadata, no allowance getter) — this rail only ever calls transferFrom/transfer.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

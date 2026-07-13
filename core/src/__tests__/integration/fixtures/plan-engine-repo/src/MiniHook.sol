// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MiniHook {
    // beforeSwap (bit 7) | afterSwap (bit 6), matching the v4 hook-address mask.
    uint160 internal constant PERMISSIONS = uint160(0x00c0);
    address public owner;

    struct Permissions {
        bool beforeInitialize;
        bool afterInitialize;
        bool beforeAddLiquidity;
        bool afterAddLiquidity;
        bool beforeRemoveLiquidity;
        bool afterRemoveLiquidity;
        bool beforeSwap;
        bool afterSwap;
        bool beforeDonate;
        bool afterDonate;
        bool beforeSwapReturnDelta;
        bool afterSwapReturnDelta;
        bool afterAddLiquidityReturnDelta;
        bool afterRemoveLiquidityReturnDelta;
    }

    constructor(address owner_) { owner = owner_; }

    function getHookPermissions() external pure returns (Permissions memory p) {
        p.beforeSwap = true;
        p.afterSwap = true;
    }
}


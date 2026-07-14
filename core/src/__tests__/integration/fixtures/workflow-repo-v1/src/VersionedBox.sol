// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract VersionedBox {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function version() external pure returns (uint256) {
        return 1;
    }
}


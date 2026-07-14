// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PointerConsumer {
    address public target;

    constructor(address target_) {
        target = target_;
    }
}

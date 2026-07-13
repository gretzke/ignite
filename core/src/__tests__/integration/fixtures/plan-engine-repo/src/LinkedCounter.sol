// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathLib} from "./MathLib.sol";

contract LinkedCounter {
    address public owner;
    address public peer;
    uint256 public value;

    constructor(address owner_, address peer_) {
        owner = owner_;
        peer = peer_;
    }

    function increment() external {
        value = MathLib.increment(value);
    }
}


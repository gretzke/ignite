// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract OwnedBox {
    address public owner;
    address public peer;

    constructor(address owner_, address peer_) {
        owner = owner_;
        peer = peer_;
    }

    function transferOwnership(address nextOwner) external {
        require(msg.sender == owner, "not owner");
        owner = nextOwner;
    }
}


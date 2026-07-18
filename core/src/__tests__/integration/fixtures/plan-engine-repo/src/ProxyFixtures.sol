// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract InitializableOwner {
    address public owner;
    function initialize(address owner_) external { owner = owner_; }
}

contract PayableInitializable {
    uint256 public received;
    function initialize() external payable { received = msg.value; }
}

contract SenderInitializable {
    address public initializerSender;
    function initialize() external { initializerSender = msg.sender; }
}

contract UupsFixture {
    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address public owner;
    function initialize(address owner_) external { owner = owner_; }
    function proxiableUUID() external pure returns (bytes32) { return IMPLEMENTATION_SLOT; }
    function upgradeToAndCall(address next, bytes calldata data) external payable {
        assembly { sstore(IMPLEMENTATION_SLOT, next) }
        if (data.length != 0) {
            (bool ok,) = address(this).delegatecall(data);
            require(ok, "delegatecall failed");
        }
    }
}

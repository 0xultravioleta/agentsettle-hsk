// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentSettleReceipts} from "../AgentSettleReceipts.sol";

/// @notice Deploys AgentSettleReceipts with the broadcaster as operator.
/// Use scripts/deploy.sh: it passes the key through DEPLOYER_PRIVATE_KEY (never on the command line),
/// verifies the source and records the address in .env. The mainnet guard lives here too, so a bare
/// `forge script ... --broadcast` against chain 177 also refuses without MAINNET_OWNER_OK=yes.
contract Deploy is Script {
    uint256 internal constant HASHKEY_MAINNET = 177;

    function run() external returns (AgentSettleReceipts deployed) {
        require(
            block.chainid != HASHKEY_MAINNET || keccak256(bytes(vm.envOr("MAINNET_OWNER_OK", string("")))) == keccak256("yes"),
            "refusing HashKey mainnet: set MAINNET_OWNER_OK=yes only after the owner approved the exact amount"
        );
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        deployed = new AgentSettleReceipts(sender);
        vm.stopBroadcast();
        console2.log("AgentSettleReceipts", address(deployed));
        console2.log("operator", sender);
    }
}

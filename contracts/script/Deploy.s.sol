// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentSettleReceipts} from "../AgentSettleReceipts.sol";

/// @notice Deploys AgentSettleReceipts with the broadcaster as operator.
/// Use scripts/deploy.sh: it passes the key through DEPLOYER_PRIVATE_KEY (never on the command line),
/// refuses mainnet without MAINNET_OWNER_OK=yes, verifies on Blockscout and records the address in .env.
contract Deploy is Script {
    function run() external returns (AgentSettleReceipts deployed) {
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

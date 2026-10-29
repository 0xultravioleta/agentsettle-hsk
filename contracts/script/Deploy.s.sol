// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentSettleReceipts} from "../AgentSettleReceipts.sol";

/// @notice Deploys AgentSettleReceipts with the broadcaster as operator.
/// Testnet:  forge script contracts/script/Deploy.s.sol --rpc-url https://testnet.hsk.xyz --broadcast \
///             --private-key "$TESTNET_OPERATOR_PRIVATE_KEY"
/// Mainnet:  ONLY with the owner's OK for the exact HSK amount (see PREGUNTA-c0der.md).
contract Deploy is Script {
    function run() external returns (AgentSettleReceipts deployed) {
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        deployed = new AgentSettleReceipts(sender);
        vm.stopBroadcast();
        console2.log("AgentSettleReceipts", address(deployed));
        console2.log("operator", sender);
    }
}

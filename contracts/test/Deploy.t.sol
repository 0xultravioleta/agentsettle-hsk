// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {AgentSettleReceipts} from "../AgentSettleReceipts.sol";

/// One sequential test on purpose: vm.setEnv is process-global and forge runs tests in parallel.
contract DeployScriptTest is Test {
    function test_mainnetGuard() public {
        Deploy d = new Deploy();

        vm.setEnv("MAINNET_OWNER_OK", "");
        vm.chainId(133);
        assertTrue(d.run().operator() != address(0), "testnet deploys without the flag");

        vm.chainId(177);
        vm.expectRevert(bytes("refusing HashKey mainnet: set MAINNET_OWNER_OK=yes only after the owner approved the exact amount"));
        d.run();

        vm.setEnv("MAINNET_OWNER_OK", "YES");
        vm.expectRevert();
        d.run();

        vm.setEnv("MAINNET_OWNER_OK", "yes");
        AgentSettleReceipts r = d.run();
        assertTrue(address(r).code.length > 0, "mainnet deploys with the owner's OK");

        vm.setEnv("MAINNET_OWNER_OK", "");
    }
}

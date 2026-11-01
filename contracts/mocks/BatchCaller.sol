// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Test helper: several calls to one contract in a single transaction (e.g. three transferWithAuthorization), so a
/// test can put a payment next to other authorizations in the same receipt. Never deployed outside anvil.
contract BatchCaller {
    function callAll(address target, bytes[] calldata data) external {
        for (uint256 i = 0; i < data.length; i++) {
            (bool ok, bytes memory reason) = target.call(data[i]);
            if (!ok) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
        }
    }
}

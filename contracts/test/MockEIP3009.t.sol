// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockEIP3009} from "../mocks/MockEIP3009.sol";

/// The mock stands in for USDC in the local e2e run, so its signature check must be the real one.
contract MockEIP3009Test is Test {
    MockEIP3009 internal usdc;
    uint256 internal buyerKey = 0xB0B;
    address internal buyer;
    address internal seller = makeAddr("seller");

    function setUp() public {
        usdc = new MockEIP3009("USD Coin", "2");
        buyer = vm.addr(buyerKey);
        usdc.mint(buyer, 1_000_000);
        vm.warp(1_000);
    }

    function _sign(uint256 key, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), buyer, to, value, validAfter, validBefore, nonce)
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_validAuthorization_movesFunds_once() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(buyerKey, seller, 100_000, 0, 2_000, bytes32(uint256(1)));
        usdc.transferWithAuthorization(buyer, seller, 100_000, 0, 2_000, bytes32(uint256(1)), v, r, s);
        assertEq(usdc.balanceOf(seller), 100_000);
        assertTrue(usdc.authorizationState(buyer, bytes32(uint256(1))));
        vm.expectRevert(bytes("authorization is used or canceled"));
        usdc.transferWithAuthorization(buyer, seller, 100_000, 0, 2_000, bytes32(uint256(1)), v, r, s);
    }

    function test_wrongSigner_reverts() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xBAD, seller, 100_000, 0, 2_000, bytes32(uint256(2)));
        vm.expectRevert(bytes("invalid signature"));
        usdc.transferWithAuthorization(buyer, seller, 100_000, 0, 2_000, bytes32(uint256(2)), v, r, s);
    }

    function test_tamperedValue_reverts() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(buyerKey, seller, 100_000, 0, 2_000, bytes32(uint256(3)));
        vm.expectRevert(bytes("invalid signature"));
        usdc.transferWithAuthorization(buyer, seller, 999_999, 0, 2_000, bytes32(uint256(3)), v, r, s);
    }

    function test_expired_reverts() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(buyerKey, seller, 100_000, 0, 999, bytes32(uint256(4)));
        vm.expectRevert(bytes("authorization is expired"));
        usdc.transferWithAuthorization(buyer, seller, 100_000, 0, 999, bytes32(uint256(4)), v, r, s);
    }

    function test_notYetValid_reverts() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(buyerKey, seller, 100_000, 1_000, 2_000, bytes32(uint256(5)));
        vm.expectRevert(bytes("authorization is not yet valid"));
        usdc.transferWithAuthorization(buyer, seller, 100_000, 1_000, 2_000, bytes32(uint256(5)), v, r, s);
    }
}

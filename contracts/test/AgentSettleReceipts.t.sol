// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentSettleReceipts} from "../AgentSettleReceipts.sol";

contract AgentSettleReceiptsTest is Test {
    event TaskSettled(
        bytes32 indexed taskId,
        address indexed payer,
        address indexed payee,
        address token,
        uint256 amount,
        bytes32 settleTx,
        bytes32 hspPaymentId,
        bytes32 resultHash
    );

    AgentSettleReceipts internal receipts;
    address internal operator = makeAddr("operator");
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal token = makeAddr("usdc");

    bytes32 internal constant TASK = keccak256("task-1");
    bytes32 internal constant SETTLE_TX = keccak256("settle-tx");
    bytes32 internal constant HSP_ID = keccak256("hsp-payment");
    bytes32 internal constant RESULT = keccak256("hola mundo");

    function setUp() public {
        receipts = new AgentSettleReceipts(operator);
    }

    function _record(bytes32 taskId) internal {
        receipts.recordReceipt(taskId, payer, payee, token, 100_000, SETTLE_TX, HSP_ID, RESULT);
    }

    function test_constructor_setsOperator() public view {
        assertEq(receipts.operator(), operator);
    }

    function test_constructor_rejectsZeroOperator() public {
        vm.expectRevert(bytes("zero operator"));
        new AgentSettleReceipts(address(0));
    }

    function test_operator_recordsReceipt_andStoresEveryField() public {
        vm.warp(1_761_760_000);
        vm.prank(operator);
        _record(TASK);

        (
            address p,
            address q,
            address t,
            uint256 amount,
            bytes32 settleTx,
            bytes32 hspId,
            bytes32 resultHash,
            uint64 at
        ) = receipts.receipts(TASK);
        assertEq(p, payer);
        assertEq(q, payee);
        assertEq(t, token);
        assertEq(amount, 100_000);
        assertEq(settleTx, SETTLE_TX);
        assertEq(hspId, HSP_ID);
        assertEq(resultHash, RESULT);
        assertEq(at, uint64(1_761_760_000));
    }

    function test_nonOperator_cannotRecord() public {
        vm.prank(payer);
        vm.expectRevert(bytes("only operator"));
        _record(TASK);
    }

    function testFuzz_nobodyButOperatorCanRecord(address caller) public {
        vm.assume(caller != operator);
        vm.prank(caller);
        vm.expectRevert(bytes("only operator"));
        _record(TASK);
    }

    function test_duplicateTaskId_reverts() public {
        vm.startPrank(operator);
        _record(TASK);
        vm.expectRevert(bytes("exists"));
        receipts.recordReceipt(TASK, payee, payer, token, 1, bytes32(0), bytes32(0), bytes32(0));
        vm.stopPrank();
    }

    function test_distinctTaskIds_bothRecorded() public {
        vm.startPrank(operator);
        _record(TASK);
        _record(keccak256("task-2"));
        vm.stopPrank();
        (,,,,,,, uint64 at2) = receipts.receipts(keccak256("task-2"));
        assertGt(at2, 0);
    }

    function test_record_emitsTaskSettled() public {
        vm.expectEmit(true, true, true, true, address(receipts));
        emit TaskSettled(TASK, payer, payee, token, 100_000, SETTLE_TX, HSP_ID, RESULT);
        vm.prank(operator);
        _record(TASK);
    }

    function test_x402ReceiptWithoutHspId_isAllowed() public {
        vm.prank(operator);
        receipts.recordReceipt(TASK, payer, payee, token, 100_000, SETTLE_TX, bytes32(0), RESULT);
        (,,,,, bytes32 hspId,,) = receipts.receipts(TASK);
        assertEq(hspId, bytes32(0));
    }

    function test_unknownTask_isEmpty() public view {
        (address p,,,,,,, uint64 at) = receipts.receipts(keccak256("nope"));
        assertEq(p, address(0));
        assertEq(at, 0);
    }
}

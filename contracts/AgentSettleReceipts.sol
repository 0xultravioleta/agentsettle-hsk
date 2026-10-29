// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentSettleReceipts
/// @notice One on-chain receipt per paid agent task. Links the payment (x402 settle tx and/or HSP paymentId),
///         the payer, the payee and a hash of the delivered work. Holds no funds.
/// @dev    Only the operator (W3 on mainnet, W5 on testnet) writes. A taskId can be written once.
contract AgentSettleReceipts {
    struct Receipt {
        address payer;
        address payee;
        address token;
        uint256 amount;
        bytes32 settleTx;
        bytes32 hspPaymentId;
        bytes32 resultHash;
        uint64 at;
    }

    /// @notice taskId => receipt
    mapping(bytes32 => Receipt) public receipts;
    address public immutable operator;

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

    constructor(address _operator) {
        require(_operator != address(0), "zero operator");
        operator = _operator;
    }

    function recordReceipt(
        bytes32 taskId,
        address payer,
        address payee,
        address token,
        uint256 amount,
        bytes32 settleTx,
        bytes32 hspPaymentId,
        bytes32 resultHash
    ) external {
        require(msg.sender == operator, "only operator");
        require(receipts[taskId].at == 0, "exists");
        receipts[taskId] = Receipt(payer, payee, token, amount, settleTx, hspPaymentId, resultHash, uint64(block.timestamp));
        emit TaskSettled(taskId, payer, payee, token, amount, settleTx, hspPaymentId, resultHash);
    }
}

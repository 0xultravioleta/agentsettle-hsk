import { encodePacked, getAddress, isHex, keccak256, toHex, zeroHash, type Address, type Hex, type LocalAccount } from 'viem';
import type { NetworkConfig } from './config.js';
import { RECEIPTS_ABI, publicClientFor, walletClientFor } from './chain.js';

/**
 * AgentSettleReceipts.recordReceipt(): one receipt per paid task, written by the operator.
 * taskId is derived from the payment itself (chain, payer, EIP-3009 nonce or HSP paymentId), so a retried
 * delivery of the same payment can never write a second receipt: the contract answers "exists".
 */

export function taskIdFor(chainId: number, payer: Address, paymentRef: Hex | string): Hex {
  const ref = isHex(paymentRef) && paymentRef.length === 66 ? paymentRef : keccak256(toHex(paymentRef));
  return keccak256(encodePacked(['string', 'uint256', 'address', 'bytes32'], ['agentsettle/v1', BigInt(chainId), getAddress(payer), ref]));
}

export const resultHashOf = (result: string): Hex => keccak256(toHex(result));

/** HSP paymentId is the mandateHash (bytes32). Anything else is hashed so it still fits the bytes32 slot. */
export function hspPaymentIdToBytes32(paymentId: string | undefined): Hex {
  if (!paymentId) return zeroHash;
  return isHex(paymentId) && paymentId.length === 66 ? paymentId : keccak256(toHex(paymentId));
}

export interface ReceiptInput {
  taskId: Hex;
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  settleTx?: Hex;
  hspPaymentId?: string;
  resultHash: Hex;
}

export interface RecordedReceipt {
  taskId: Hex;
  tx: Hex;
  block: bigint;
  contract: Address;
}

export async function recordReceipt(net: NetworkConfig, operator: LocalAccount, input: ReceiptInput): Promise<RecordedReceipt> {
  if (!net.receiptsAddress) throw new Error(`no AgentSettleReceipts address configured for ${net.name}`);
  const settleTx = input.settleTx ?? zeroHash;
  if (!isHex(settleTx) || settleTx.length !== 66) throw new Error(`settleTx is not a 32-byte tx hash: ${settleTx}`);
  const pub = publicClientFor(net);
  const wallet = walletClientFor(net, operator);
  const args = [
    input.taskId,
    getAddress(input.payer),
    getAddress(input.payee),
    getAddress(input.token),
    input.amount,
    settleTx,
    hspPaymentIdToBytes32(input.hspPaymentId),
    input.resultHash,
  ] as const;
  // simulate first: a duplicate taskId or a non-operator key fails here, with the revert reason, before gas is spent
  const { request } = await pub.simulateContract({ address: net.receiptsAddress, abi: RECEIPTS_ABI, functionName: 'recordReceipt', args, account: operator });
  const tx = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success') throw new Error(`recordReceipt reverted: ${tx}`);
  return { taskId: input.taskId, tx, block: receipt.blockNumber, contract: net.receiptsAddress };
}

export interface ReceiptRow {
  taskId: Hex;
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  settleTx: Hex;
  hspPaymentId: Hex;
  resultHash: Hex;
  tx: Hex;
  block: bigint;
}

/** Recent TaskSettled events, newest first (for the judge UI). */
export async function listReceipts(net: NetworkConfig, opts: { fromBlock?: bigint; limit?: number } = {}): Promise<ReceiptRow[]> {
  if (!net.receiptsAddress) return [];
  const pub = publicClientFor(net);
  const latest = await pub.getBlockNumber();
  // public RPCs cap eth_getLogs ranges; 50k blocks is ~1 day at HashKey's 2 s blocks
  const fromBlock = opts.fromBlock ?? (latest > 50_000n ? latest - 50_000n : 0n);
  const logs = await pub.getContractEvents({ address: net.receiptsAddress, abi: RECEIPTS_ABI, eventName: 'TaskSettled', fromBlock, toBlock: latest });
  return logs
    .map((l) => ({
      taskId: l.args.taskId!,
      payer: l.args.payer!,
      payee: l.args.payee!,
      token: l.args.token!,
      amount: l.args.amount!,
      settleTx: l.args.settleTx!,
      hspPaymentId: l.args.hspPaymentId!,
      resultHash: l.args.resultHash!,
      tx: l.transactionHash,
      block: l.blockNumber,
    }))
    .reverse()
    .slice(0, opts.limit ?? 20);
}

export interface ExistingReceipt {
  payer: Address;
  payee: Address;
  amount: bigint;
  settleTx: Hex;
  resultHash: Hex;
  at: bigint;
  /** The recordReceipt tx, when its TaskSettled log is still in the scanned range. */
  tx?: Hex;
}

/** The stored receipt for taskId, or undefined. */
export async function readReceipt(net: NetworkConfig, taskId: Hex): Promise<ExistingReceipt | undefined> {
  if (!net.receiptsAddress) return undefined;
  const pub = publicClientFor(net);
  const r = await pub.readContract({ address: net.receiptsAddress, abi: RECEIPTS_ABI, functionName: 'receipts', args: [taskId] });
  if (r[7] === 0n) return undefined;
  const latest = await pub.getBlockNumber();
  const logs = await pub.getContractEvents({
    address: net.receiptsAddress,
    abi: RECEIPTS_ABI,
    eventName: 'TaskSettled',
    args: { taskId },
    fromBlock: latest > 50_000n ? latest - 50_000n : 0n,
    toBlock: latest,
  });
  return { payer: r[0], payee: r[1], amount: r[3], settleTx: r[4], resultHash: r[6], at: r[7], tx: logs[0]?.transactionHash };
}

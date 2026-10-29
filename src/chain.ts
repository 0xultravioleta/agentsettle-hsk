import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type Chain,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Account,
} from 'viem';
import type { NetworkConfig } from './config.js';

export const ERC20_EIP3009_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'authorizationState',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [] },
] as const;

export const RECEIPTS_ABI = [
  { type: 'function', name: 'operator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'recordReceipt',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'taskId', type: 'bytes32' },
      { name: 'payer', type: 'address' },
      { name: 'payee', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'settleTx', type: 'bytes32' },
      { name: 'hspPaymentId', type: 'bytes32' },
      { name: 'resultHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'receipts',
    stateMutability: 'view',
    inputs: [{ name: 'taskId', type: 'bytes32' }],
    outputs: [
      { name: 'payer', type: 'address' },
      { name: 'payee', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'settleTx', type: 'bytes32' },
      { name: 'hspPaymentId', type: 'bytes32' },
      { name: 'resultHash', type: 'bytes32' },
      { name: 'at', type: 'uint64' },
    ],
  },
  {
    type: 'event',
    name: 'TaskSettled',
    inputs: [
      { name: 'taskId', type: 'bytes32', indexed: true },
      { name: 'payer', type: 'address', indexed: true },
      { name: 'payee', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'settleTx', type: 'bytes32', indexed: false },
      { name: 'hspPaymentId', type: 'bytes32', indexed: false },
      { name: 'resultHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export function viemChain(net: NetworkConfig): Chain {
  return defineChain({
    id: net.chainId,
    name: net.name === 'hashkey' ? 'HashKey Chain' : net.name === 'hashkey-testnet' ? 'HashKey Chain Testnet' : 'Local (anvil)',
    nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
    rpcUrls: { default: { http: [net.rpcUrl] } },
    ...(net.explorer ? { blockExplorers: { default: { name: 'Blockscout', url: net.explorer } } } : {}),
  });
}

export function publicClientFor(net: NetworkConfig): PublicClient<Transport, Chain> {
  return createPublicClient({ chain: viemChain(net), transport: http(net.rpcUrl) });
}

export function walletClientFor(net: NetworkConfig, account: LocalAccount): WalletClient<Transport, Chain, Account> {
  return createWalletClient({ chain: viemChain(net), transport: http(net.rpcUrl), account });
}

const AUTHORIZATION_USED_EVENT = {
  type: 'event',
  name: 'AuthorizationUsed',
  inputs: [
    { name: 'authorizer', type: 'address', indexed: true },
    { name: 'nonce', type: 'bytes32', indexed: true },
  ],
} as const;

const TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const;

export async function authorizationUsed(net: NetworkConfig, from: Address, nonce: Hex): Promise<boolean> {
  return publicClientFor(net).readContract({ address: net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'authorizationState', args: [from, nonce] });
}

/** The tx that consumed (from, nonce), from the token's AuthorizationUsed log (last ~50k blocks). */
export async function findAuthorizationTx(net: NetworkConfig, from: Address, nonce: Hex): Promise<Hex | undefined> {
  const pub = publicClientFor(net);
  const latest = await pub.getBlockNumber();
  const logs = await pub.getLogs({
    address: net.usdc.address,
    event: AUTHORIZATION_USED_EVENT,
    args: { authorizer: from, nonce },
    fromBlock: latest > 50_000n ? latest - 50_000n : 0n,
    toBlock: latest,
  });
  return logs[0]?.transactionHash ?? undefined;
}

/**
 * Did `tx` really move exactly `value` of the network's USDC from `from` to `to`? Read from the mined receipt, so a
 * facilitator (or HSP coordinator) answer is never taken on its word before delivering or writing a receipt.
 */
export async function confirmTransfer(
  net: NetworkConfig,
  tx: Hex,
  expect: { from: Address; to: Address; value: bigint; nonce?: Hex; afterBlock?: bigint },
  timeoutMs = 30_000,
): Promise<boolean> {
  try {
    const receipt = await publicClientFor(net).waitForTransactionReceipt({ hash: tx, timeout: timeoutMs });
    if (receipt.status !== 'success') return false;
    // without a nonce (HSP plain transfers) bind by time: the tx must be newer than the moment we asked to pay
    if (expect.afterBlock !== undefined && receipt.blockNumber <= expect.afterBlock) return false;
    if (expect.nonce) {
      // bind the tx to THIS authorization: an older payment of the same amount by the same payer does not count
      const used = parseEventLogs({ abi: [AUTHORIZATION_USED_EVENT], logs: receipt.logs, eventName: 'AuthorizationUsed' });
      const ours = used.some(
        (l) => getAddress(l.address) === getAddress(net.usdc.address) && getAddress(l.args.authorizer) === getAddress(expect.from) && l.args.nonce.toLowerCase() === expect.nonce!.toLowerCase(),
      );
      if (!ours) return false;
    }
    const transfers = parseEventLogs({ abi: [TRANSFER_EVENT], logs: receipt.logs, eventName: 'Transfer' });
    return transfers.some(
      (l) =>
        getAddress(l.address) === getAddress(net.usdc.address) &&
        getAddress(l.args.from) === getAddress(expect.from) &&
        getAddress(l.args.to) === getAddress(expect.to) &&
        l.args.value === expect.value,
    );
  } catch {
    return false;
  }
}

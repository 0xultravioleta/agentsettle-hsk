import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
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

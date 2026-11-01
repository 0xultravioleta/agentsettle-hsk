import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import type { CartContents } from './hsp-merchant.js';

/**
 * HSP Agentic Payment: HashKey's MCP server (Streamable HTTP) that lets an agent pay a cart mandate itself.
 *
 *   get_chain_config -> create_order -> get_order -> prepare_payment -> [our checks] -> EIP-712 signature (the payer
 *   wallet, here) -> finalize_payment -> submit_payment -> query_payment until safe / finalized / failed.
 *
 * The server builds the typed data and we sign it, so nothing it returns is trusted before `checkTypedData` passes.
 * App key and secret live on HSP's side; this client sends no credentials and never sends a private key.
 */

export const HSP_MCP_QA_URL = 'https://mcp-qa.hashkeymerchant.com/';
export const HSP_MCP_TOOLS = ['get_chain_config', 'create_order', 'get_order', 'prepare_payment', 'finalize_payment', 'estimate_fee', 'submit_payment', 'query_payment'] as const;
/** The guide's polling interval and the point at which a payment is reported as "Pending confirmation". */
export const HSP_POLL_MS = 15_000;
export const HSP_PENDING_AFTER_MS = 10 * 60_000;
/** The most we sign for a task: its price plus 10% (the payer may carry the gas fee when gas_fee_advanced is false). */
export const HSP_MAX_OVER_PRICE_PCT = 10n;
/** validBefore must not reach further than this into the future. */
export const HSP_MAX_VALIDITY_SECONDS = 3600;
/** The chains `pnpm hsp:pay` may pay on: HSP QA's HashKey testnet, and Base Sepolia as the fallback. Never mainnet. */
export const HSP_PAY_NETWORKS = ['hashkey-testnet', 'base-sepolia'] as const;
export type HspPayNetwork = (typeof HSP_PAY_NETWORKS)[number];

/** HSP_MCP_NETWORK -> the chain to pay on (default hashkey-testnet); anything else, mainnet included, is refused. */
export function hspPayNetwork(value: string | undefined): HspPayNetwork {
  const v = value?.trim() || 'hashkey-testnet';
  if (!(HSP_PAY_NETWORKS as readonly string[]).includes(v)) throw new Error(`HSP_MCP_NETWORK must be ${HSP_PAY_NETWORKS.join(' or ')}, not ${v}`);
  return v as HspPayNetwork;
}

export interface ChainNetwork {
  chain_id: number;
  name: string;
  display_name: string;
  is_testnet: boolean;
}

export interface ChainToken {
  chain_id: number;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  version: string;
  payment_protocol: string;
  permit2_spender: string;
}

export interface ChainConfig {
  networks: ChainNetwork[] | null;
  tokens: ChainToken[] | null;
}

export interface CreatedOrder {
  merchant_name: string;
  payment_request_id: string;
  flow_id: string;
  payment_url: string;
}

export interface OrderInfo {
  payment_request_id: string;
  cart_mandate_id: string;
  merchant_name: string;
  method_data: Array<Record<string, unknown>> | null;
  status: string;
  gas_fee_configs: Array<{ network: string; gas_fee_advanced: boolean }> | null;
  [k: string]: unknown;
}

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PreparedPayment {
  eip712: TypedData;
  cart_hash: string;
  token_total_raw: string;
  quote_expires_at: string;
  pay_to: string;
  payer: string;
  payment_request_id: string;
  payment_details_id: string;
  payment_details_total: string;
  payment_payload: Record<string, unknown>;
  payment_mandate_contents: Record<string, unknown>;
}

export interface FinalizedPayment {
  payment_mandate_json: string;
  payment_hash: string;
  cart_hash: string;
}

export interface PaymentQuery {
  merchant_name: string;
  expected_merchant_name: string;
  payment_request_id: string;
  flow_id: string;
  status: string;
  attribution_verified: boolean;
  payment: {
    gas_fee_advanced: boolean;
    chain?: string;
    payer_address?: string;
    to_pay_address?: string;
    token_address?: string;
    tx_signature?: string;
    status_reason?: string;
    amount?: string;
    [k: string]: unknown;
  };
}

/** Statuses at which polling stops (the guide's table); everything else keeps polling the same payment. */
export const HSP_STOP_STATES = ['payment-safe', 'payment-finalized', 'payment-failed'] as const;
export const HSP_ON_CHAIN_STATES = ['payment-safe', 'payment-finalized'] as const;

export class HspToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`${tool}: ${message}`);
  }
}

/** One MCP tool call: arguments in, the tool's structured result out (throws HspToolError on isError). */
export type HspToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface HspMcpSession {
  call: HspToolCall;
  tools: string[];
  close(): Promise<void>;
}

/** Connects, lists the tools and refuses to go on unless all eight are there (the guide: never without finalize_payment). */
export async function connectHspMcp(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<HspMcpSession> {
  const client = new Client({ name: 'agentsettle', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), opts.fetch ? { fetch: opts.fetch } : {});
  const timeout = opts.timeoutMs ?? 60_000;
  await client.connect(transport, { timeout });
  const listed = await client.listTools(undefined, { timeout });
  const tools = listed.tools.map((t) => t.name);
  const missing = HSP_MCP_TOOLS.filter((t) => !tools.includes(t));
  if (missing.length) {
    await client.close();
    throw new Error(`HSP MCP at ${url} is missing ${missing.join(', ')}: not paying`);
  }
  const call: HspToolCall = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
    const text = Array.isArray(res.content) ? res.content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('\n') : '';
    if (res.isError) throw new HspToolError(name, text || 'tool error');
    if (res.structuredContent !== undefined) return res.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      throw new HspToolError(name, `no structured result: ${text.slice(0, 200)}`);
    }
  };
  return { call, tools, close: () => client.close() };
}

/** Typed wrappers over the eight tools. Arguments go exactly as the live schemas name them. */
export class HspMcpClient {
  constructor(private readonly call: HspToolCall) {}

  getChainConfig = () => this.call('get_chain_config', {}) as Promise<ChainConfig>;
  createOrder = (args: { merchant_name: string; pay_to: string; cart_mandate: { contents: CartContents } }) => this.call('create_order', args) as Promise<CreatedOrder>;
  getOrder = (flowId: string) => this.call('get_order', { flow_id: flowId }) as Promise<OrderInfo>;
  preparePayment = (flowId: string, payer: string, protocol: 'eip3009') => this.call('prepare_payment', { flow_id: flowId, payer, protocol }) as Promise<PreparedPayment>;
  /** The three prepare_payment values go back unchanged; only the signature is ours. */
  finalizePayment = (signature: Hex, prep: PreparedPayment) =>
    this.call('finalize_payment', { signature, payment_payload: prep.payment_payload, payment_mandate_contents: prep.payment_mandate_contents, cart_hash: prep.cart_hash }) as Promise<FinalizedPayment>;
  submitPayment = (paymentMandateJson: string) => this.call('submit_payment', { payment_mandate_json: paymentMandateJson }) as Promise<{ data: unknown }>;
  queryPayment = (flowId: string, expectedMerchantName: string) => this.call('query_payment', { flow_id: flowId, expected_merchant_name: expectedMerchantName }) as Promise<PaymentQuery>;
}

const sameAddress = (a: unknown, b: string) => typeof a === 'string' && isAddress(a, { strict: false }) && getAddress(a) === getAddress(b);

/**
 * The EIP-3009 token we pay with, read from THIS get_chain_config: the one on `chainId` at `address` (our network
 * config), protocol eip3009. Duplicated rows (the QA server lists Base Sepolia USDC twice) are fine; two different
 * tokens at the same address are not.
 */
export function selectToken(cfg: ChainConfig, want: { chainId: number; address: Address }): { network: ChainNetwork; token: ChainToken } {
  const tokens = (cfg.tokens ?? []).filter((t) => t.chain_id === want.chainId && sameAddress(t.address, want.address));
  if (!tokens.length) throw new Error(`get_chain_config has no token ${want.address} on chain ${want.chainId}`);
  const distinct = new Set(tokens.map((t) => JSON.stringify([t.symbol, t.name, t.decimals, t.version, t.payment_protocol])));
  if (distinct.size > 1) throw new Error(`get_chain_config lists ${want.address} on chain ${want.chainId} with different settings`);
  const token = tokens[0]!;
  if (token.payment_protocol !== 'eip3009') throw new Error(`${token.symbol} on chain ${want.chainId} is ${token.payment_protocol}, not eip3009`);
  if (token.decimals !== 6) throw new Error(`${token.symbol} on chain ${want.chainId} has ${token.decimals} decimals, not 6`);
  const network = (cfg.networks ?? []).find((n) => n.chain_id === want.chainId);
  if (!network) throw new Error(`get_chain_config has no network ${want.chainId}`);
  return { network, token };
}

/** The ceiling for token_total_raw: the task price plus HSP_MAX_OVER_PRICE_PCT, in the token's units (6 decimals). */
export const maxRawFor = (price: bigint) => price + (price * HSP_MAX_OVER_PRICE_PCT) / 100n;

/** EIP-3009's struct, field for field: anything else would be a different signature. */
const TRANSFER_WITH_AUTHORIZATION = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

/** Field by field: the same names and types in the same order (member order is part of the hash; key order is not). */
const isTransferWithAuthorization = (fields: unknown) =>
  Array.isArray(fields) &&
  fields.length === TRANSFER_WITH_AUTHORIZATION.length &&
  fields.every((f, i) => f && typeof f === 'object' && f.name === TRANSFER_WITH_AUTHORIZATION[i]!.name && f.type === TRANSFER_WITH_AUTHORIZATION[i]!.type);

const uint = (v: unknown): bigint | undefined => {
  if (typeof v === 'bigint') return v >= 0n ? v : undefined;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return undefined;
};

export interface TypedDataExpectation {
  chainId: number;
  token: ChainToken;
  payer: Address;
  payTo: Address;
  maxRaw: bigint;
  now: Date;
}

/**
 * Why the server's typed data must NOT be signed, or undefined when it is exactly the transfer we agreed to:
 * TransferWithAuthorization on the chosen chain and token, from the confirmed payer to the confirmed pay_to, for
 * token_total_raw, within the cap, valid for at most an hour.
 */
export function checkTypedData(prep: PreparedPayment, x: TypedDataExpectation): string | undefined {
  const d = prep.eip712;
  if (!d || typeof d !== 'object' || !d.domain || !d.message || !d.types) return 'eip712 is missing domain, types or message';
  if (d.primaryType !== 'TransferWithAuthorization') return `primaryType is ${d.primaryType}, not TransferWithAuthorization`;
  if (!isTransferWithAuthorization(d.types.TransferWithAuthorization)) return 'types.TransferWithAuthorization is not the EIP-3009 struct';
  const extra = Object.keys(d.domain).filter((k) => !['name', 'version', 'chainId', 'verifyingContract'].includes(k));
  if (extra.length) return `domain has unexpected fields: ${extra.join(', ')}`;
  if (uint(d.domain.chainId) !== BigInt(x.chainId)) return `domain.chainId is ${String(d.domain.chainId)}, not ${x.chainId}`;
  if (!sameAddress(d.domain.verifyingContract, x.token.address)) return `domain.verifyingContract is ${String(d.domain.verifyingContract)}, not ${x.token.symbol} ${x.token.address}`;
  if (d.domain.name !== x.token.name || d.domain.version !== x.token.version) return `domain is "${String(d.domain.name)}" v${String(d.domain.version)}, not "${x.token.name}" v${x.token.version}`;
  if (!sameAddress(d.message.from, x.payer)) return `message.from is ${String(d.message.from)}, not the confirmed payer ${x.payer}`;
  if (!sameAddress(d.message.to, x.payTo)) return `message.to is ${String(d.message.to)}, not the confirmed pay_to ${x.payTo}`;
  const total = uint(prep.token_total_raw);
  if (total === undefined || total === 0n) return `token_total_raw "${prep.token_total_raw}" is not a positive integer`;
  if (uint(d.message.value) !== total) return `message.value ${String(d.message.value)} is not token_total_raw ${prep.token_total_raw}`;
  if (total > x.maxRaw) return `token_total_raw ${total} is over the cap of ${x.maxRaw}`;
  if (uint(d.message.validAfter) === undefined) return `validAfter ${String(d.message.validAfter)} is not an integer`;
  const before = uint(d.message.validBefore);
  const now = BigInt(Math.floor(x.now.getTime() / 1000));
  if (before === undefined || before <= now) return `validBefore ${String(d.message.validBefore)} has already passed`;
  if (before > now + BigInt(HSP_MAX_VALIDITY_SECONDS)) return `validBefore ${before} is more than ${HSP_MAX_VALIDITY_SECONDS / 60} min away`;
  if (!isHex(d.message.nonce) || (d.message.nonce as string).length !== 66) return 'message.nonce is not a bytes32';
  return undefined;
}

/** viem's signTypedData input, built only from fields checkTypedData has passed (EIP712Domain is derived from domain). */
export function toSignable(d: TypedData) {
  return {
    domain: { name: String(d.domain.name), version: String(d.domain.version), chainId: Number(uint(d.domain.chainId)), verifyingContract: getAddress(String(d.domain.verifyingContract)) },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: getAddress(String(d.message.from)),
      to: getAddress(String(d.message.to)),
      value: uint(d.message.value)!,
      validAfter: uint(d.message.validAfter)!,
      validBefore: uint(d.message.validBefore)!,
      nonce: d.message.nonce as Hex,
    },
  };
}

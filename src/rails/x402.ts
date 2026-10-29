import { getAddress, isAddress, isHex, toHex, type Address, type Hex, type LocalAccount } from 'viem';
import type { NetworkConfig } from '../config.js';

/**
 * x402 v2 "exact" scheme on EVM (EIP-3009 transferWithAuthorization), in the wire shape the Ultravioleta
 * facilitator (x402-rs, src/types_v2.rs) accepts. Buyer helpers sign; seller helpers price and check.
 * The seller hands the facilitator calls to uvd-x402-sdk's FacilitatorClient (see agents/seller.ts).
 */

export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

export interface PaymentRequirement {
  scheme: 'exact';
  network: string;
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface PaymentRequired {
  x402Version: 2;
  error: string;
  resource: ResourceInfo;
  accepts: PaymentRequirement[];
}

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface PaymentPayload {
  x402Version: 2;
  resource: ResourceInfo;
  accepted: PaymentRequirement;
  payload: { signature: Hex; authorization: Authorization };
}

export const PAYMENT_HEADER = 'X-PAYMENT';
/** x402 v2 spec name of the same header; the seller accepts either. */
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeHeader<T = unknown>(value: string): T {
  const json = Buffer.from(value.trim(), 'base64').toString('utf8');
  return JSON.parse(json) as T;
}

const sameAddress = (a: string, b: string): boolean =>
  isAddress(a, { strict: false }) && isAddress(b, { strict: false }) && getAddress(a) === getAddress(b);

const UINT = /^[0-9]+$/;

/** The network id may arrive as CAIP-2 ("eip155:133") or as the facilitator's v1 name ("hashkey-testnet"). */
export function networkMatches(value: string, net: NetworkConfig): boolean {
  const v = value.trim().toLowerCase();
  return v === net.caip2 || v === net.name;
}

/** Seller: the 402 body for one priced resource. */
export function buildPaymentRequired(
  net: NetworkConfig,
  opts: { payTo: Address; amount: bigint; resource: ResourceInfo; maxTimeoutSeconds?: number },
): PaymentRequired {
  return {
    x402Version: 2,
    error: `${PAYMENT_HEADER} header is required`,
    resource: opts.resource,
    accepts: [
      {
        scheme: 'exact',
        network: net.caip2,
        asset: net.usdc.address,
        amount: opts.amount.toString(),
        payTo: getAddress(opts.payTo),
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 120,
        extra: { ...net.usdc.eip712 },
      },
    ],
  };
}

export class NoAcceptableRequirementError extends Error {
  constructor(readonly reasons: string[]) {
    super(`no acceptable payment requirement: ${reasons.join('; ') || 'accepts is empty'}`);
    this.name = 'NoAcceptableRequirementError';
  }
}

/**
 * Buyer: pick the requirement it is willing to sign. It must be exact/EIP-3009 on the buyer's own network,
 * in the buyer's own USDC, with the token domain the buyer already knows; the seller never chooses the token.
 */
export function selectRequirement(body: unknown, net: NetworkConfig): PaymentRequirement {
  const accepts = (body as { accepts?: unknown })?.accepts;
  if (!Array.isArray(accepts)) throw new NoAcceptableRequirementError(['402 body has no accepts array']);
  const reasons: string[] = [];
  for (const [i, raw] of accepts.entries()) {
    const r = raw as Partial<PaymentRequirement> & { maxAmountRequired?: string };
    const amount = r.amount ?? r.maxAmountRequired;
    const why =
      r.scheme !== 'exact'
        ? `scheme ${String(r.scheme)}`
        : typeof r.network !== 'string' || !networkMatches(r.network, net)
          ? `network ${String(r.network)}`
          : typeof r.asset !== 'string' || !sameAddress(r.asset, net.usdc.address)
            ? `asset ${String(r.asset)}`
            : typeof amount !== 'string' || !UINT.test(amount) || BigInt(amount) <= 0n
              ? `amount ${String(amount)}`
              : typeof r.payTo !== 'string' || !isAddress(r.payTo, { strict: false })
                ? `payTo ${String(r.payTo)}`
                : r.extra?.name !== net.usdc.eip712.name || r.extra?.version !== net.usdc.eip712.version
                  ? `token domain ${JSON.stringify(r.extra)}`
                  : undefined;
    if (why) {
      reasons.push(`accepts[${i}]: ${why}`);
      continue;
    }
    return {
      scheme: 'exact',
      network: net.caip2,
      asset: net.usdc.address,
      amount: amount!,
      payTo: getAddress(r.payTo!),
      maxTimeoutSeconds: typeof r.maxTimeoutSeconds === 'number' && r.maxTimeoutSeconds > 0 ? r.maxTimeoutSeconds : 120,
      extra: { ...net.usdc.eip712 },
    };
  }
  throw new NoAcceptableRequirementError(reasons);
}

export function randomNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Buyer: sign the EIP-3009 authorization for `requirement`. No gas: the facilitator broadcasts. */
export async function signExactPayment(
  account: LocalAccount,
  net: NetworkConfig,
  requirement: PaymentRequirement,
  resource: ResourceInfo,
  opts: { nowSeconds?: number; nonce?: Hex } = {},
): Promise<PaymentPayload> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const authorization: Authorization = {
    from: account.address,
    to: requirement.payTo,
    value: requirement.amount,
    // 10 minutes of clock skew, as the x402 reference client does.
    validAfter: String(now - 600),
    validBefore: String(now + requirement.maxTimeoutSeconds),
    nonce: opts.nonce ?? randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: {
      name: net.usdc.eip712.name,
      version: net.usdc.eip712.version,
      chainId: net.chainId,
      verifyingContract: net.usdc.address,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return { x402Version: 2, resource, accepted: requirement, payload: { signature, authorization } };
}

/**
 * Seller: structural check of an incoming payment against the seller's OWN requirement, before any
 * facilitator call. Returns the reason it does not match, or undefined. The facilitator re-checks the
 * signature, balance, nonce and time window on-chain.
 */
export function mismatchReason(payment: unknown, requirement: PaymentRequirement): string | undefined {
  const p = payment as Partial<PaymentPayload>;
  if (!p || typeof p !== 'object') return 'payment is not an object';
  if (p.x402Version !== 2) return `x402Version ${String(p.x402Version)}`;
  const auth = p.payload?.authorization;
  const sig = p.payload?.signature;
  if (!auth || typeof sig !== 'string' || !isHex(sig)) return 'missing signature or authorization';
  if (!isAddress(String(auth.from), { strict: false })) return 'authorization.from is not an address';
  if (!sameAddress(String(auth.to), requirement.payTo)) return 'authorization.to is not the seller';
  if (typeof auth.value !== 'string' || !UINT.test(auth.value)) return 'authorization.value is not a uint';
  if (BigInt(auth.value) !== BigInt(requirement.amount)) return `authorization.value ${auth.value} != price ${requirement.amount}`;
  if (typeof auth.nonce !== 'string' || !isHex(auth.nonce) || auth.nonce.length !== 66) return 'authorization.nonce is not bytes32';
  if (!UINT.test(String(auth.validAfter)) || !UINT.test(String(auth.validBefore))) return 'validity window is not uint';
  const acc = p.accepted;
  if (!acc) return 'missing accepted';
  if (acc.scheme !== requirement.scheme) return `scheme ${String(acc.scheme)}`;
  if (String(acc.network).toLowerCase() !== requirement.network.toLowerCase()) return `network ${String(acc.network)}`;
  if (!sameAddress(String(acc.asset), requirement.asset)) return `asset ${String(acc.asset)}`;
  return undefined;
}

import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';
import type { Address } from 'viem';

/**
 * HashKey Merchant API (HSP): the merchant side, exactly as the gateway documents it.
 *
 *  - every /api/v1/merchant/* call is HMAC-SHA256 signed with app_secret (X-App-Key, X-Signature, X-Timestamp, X-Nonce);
 *  - a one-time order carries a Cart Mandate whose `merchant_authorization` is an ES256K JWT over the canonical
 *    JSON hash of `contents` (signed with the merchant's secp256k1 key, registered with the gateway);
 *  - payments are queried by payment_request_id / flow_id / cart_mandate_id;
 *  - webhooks are signed `X-Signature: t=<unix>,v1=hex(HMAC(app_secret, t + "." + raw body))`.
 */

export const MERCHANT_QA_URL = 'https://merchant-qa.hashkeymerchant.com';
export const X402_METHOD = 'https://www.x402.org/';
export const JWT_AUDIENCE = 'HashkeyMerchant';
/** HMAC timestamp skew and webhook tolerance the gateway enforces. */
export const MAX_SKEW_SECONDS = 300;

export interface MerchantCredentials {
  appKey: string;
  appSecret: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical JSON + hashes

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
  return out;
}

/** Keys sorted recursively, arrays in order, no whitespace: the gateway's canonical JSON (body hash and cart_hash). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** cart_hash = hex(SHA-256(canonicalJson(cart_mandate.contents))). */
export const cartHash = (contents: unknown) => sha256Hex(canonicalJson(contents));

// ---------------------------------------------------------------------------------------------------------------
// HMAC request signing

export interface SignedRequest {
  headers: Record<string, string>;
  /** The exact string that was signed (tests compare it with the documented format). */
  message: string;
  /** The body to send: the same canonical JSON that was hashed. */
  body?: string;
}

export function signMerchantRequest(
  creds: MerchantCredentials,
  req: { method: string; path: string; query?: string; body?: unknown },
  opts: { timestamp?: number; nonce?: string } = {},
): SignedRequest {
  const method = req.method.toUpperCase();
  const body = req.body === undefined ? undefined : canonicalJson(req.body);
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomBytes(16).toString('hex');
  const message = [method, req.path, req.query ?? '', body === undefined ? '' : sha256Hex(body), timestamp, nonce].join('\n');
  const headers: Record<string, string> = {
    'X-App-Key': creds.appKey,
    'X-Signature': createHmac('sha256', creds.appSecret).update(message, 'utf8').digest('hex'),
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return { headers, message, ...(body !== undefined ? { body } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// ES256K merchant_authorization

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** r||s with s folded into the lower half (verifiers that enforce low-s accept it; the rest do not care). */
function lowS(sig: Buffer): Buffer {
  const s = BigInt(`0x${sig.subarray(32).toString('hex')}`);
  if (s <= SECP256K1_N / 2n) return sig;
  return Buffer.concat([sig.subarray(0, 32), Buffer.from((SECP256K1_N - s).toString(16).padStart(64, '0'), 'hex')]);
}

export interface MerchantClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  cart_hash: string;
}

/** The ES256K JWT for `cart_mandate.merchant_authorization`. Accepts PKCS8 or SEC1 PEM; refuses any curve but secp256k1. */
export function signMerchantAuthorization(
  privateKeyPem: string,
  claims: { merchantName: string; cartHash: string; now?: number; ttlSeconds?: number; jti?: string },
): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyDetails?.namedCurve !== 'secp256k1') throw new Error('the merchant key must be secp256k1 (ES256K)');
  if (!/^[0-9a-f]{64}$/.test(claims.cartHash)) throw new Error('cart_hash must be 64 lowercase hex chars');
  const iat = claims.now ?? Math.floor(Date.now() / 1000);
  const payload: MerchantClaims = {
    iss: claims.merchantName,
    sub: claims.merchantName,
    aud: JWT_AUDIENCE,
    iat,
    exp: iat + (claims.ttlSeconds ?? 3600),
    jti: claims.jti ?? `JWT-${iat}-${randomBytes(8).toString('hex')}`,
    cart_hash: claims.cartHash,
  };
  const input = `${b64url(JSON.stringify({ alg: 'ES256K', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  const sig = lowS(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }));
  return `${input}.${b64url(sig)}`;
}

/** What the gateway checks on our JWT (used by the tests and the fake gateway; the real one does it server-side). */
export function verifyMerchantAuthorization(jwt: string, publicKeyPem: string, now = Math.floor(Date.now() / 1000)): MerchantClaims {
  const [h, p, s] = jwt.split('.');
  if (!h || !p || !s) throw new Error('not a compact JWT');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  if (header.alg !== 'ES256K') throw new Error(`alg ${header.alg} is not ES256K`);
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad ES256K signature');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as MerchantClaims;
  if (claims.aud !== JWT_AUDIENCE) throw new Error(`aud ${claims.aud} is not ${JWT_AUDIENCE}`);
  if (!(claims.exp > now)) throw new Error('JWT expired');
  return claims;
}

// ---------------------------------------------------------------------------------------------------------------
// Cart Mandate

export interface UsdAmount {
  currency: 'USD';
  value: string;
}

export interface CartContents {
  id: string;
  user_cart_confirmation_required: boolean;
  payment_request: {
    method_data: Array<{
      supported_methods: string;
      data: { x402Version: 2; network: string; chain_id: number; contract_address: string; pay_to: string; coin: string };
    }>;
    details: {
      id: string;
      display_items?: Array<{ label: string; amount: UsdAmount }>;
      total: { label: string; amount: UsdAmount };
    };
  };
  cart_expiry: string;
  merchant_name: string;
}

/** 100000n (6 decimals) -> "0.10": at least 2 decimals, never more than the token has. */
export function formatDecimal(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new Error('negative amount');
  const s = amount.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${frac}`;
}

/** "0.10" -> 100000n for 6 decimals. Exact: more decimals than the token has, signs or exponents are refused. */
export function parseDecimal(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!m) throw new Error(`"${value}" is not a decimal amount`);
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function buildCartContents(req: {
  cartMandateId: string;
  paymentRequestId: string;
  merchantName: string;
  label: string;
  amount: bigint;
  token: { address: Address; symbol: string; decimals: number };
  network: { name: string; chainId: number };
  payTo: Address;
  expiresAt: Date;
}): CartContents {
  const value = formatDecimal(req.amount, req.token.decimals);
  return {
    id: req.cartMandateId,
    user_cart_confirmation_required: true,
    payment_request: {
      method_data: [
        {
          supported_methods: X402_METHOD,
          data: {
            x402Version: 2,
            network: req.network.name,
            chain_id: req.network.chainId,
            contract_address: req.token.address,
            pay_to: req.payTo,
            coin: req.token.symbol,
          },
        },
      ],
      details: {
        id: req.paymentRequestId,
        display_items: [{ label: req.label, amount: { currency: 'USD', value } }],
        total: { label: 'Total', amount: { currency: 'USD', value } },
      },
    },
    cart_expiry: req.expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    merchant_name: req.merchantName,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Payment records + webhooks

export const PAYMENT_STATES = [
  'payment-required',
  'payment-submitted',
  'payment-verified',
  'payment-processing',
  'payment-included',
  'payment-safe',
  'payment-finalized',
  'payment-failed',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];
/** On chain (the gateway's own guidance: `payment-included` is enough for small, instant fulfilment). */
export const ON_CHAIN_STATES: readonly string[] = ['payment-included', 'payment-safe', 'payment-finalized'];
export const TERMINAL_STATES: readonly string[] = ['payment-finalized', 'payment-failed'];

/** The fields AgentSettle reads from a payment record (the gateway sends more; see the API reference). */
export interface PaymentRecord {
  content_id?: string;
  payment_request_id: string;
  request_id?: string;
  flow_id?: string;
  status: string;
  status_reason?: string | null;
  payer_address?: string;
  to_pay_address?: string;
  token?: string;
  token_address?: string;
  chain?: string;
  network?: string;
  pay_amount?: string;
  order_amount?: string;
  product_amount?: string;
  tx_signature?: string;
  extra_protocol?: string;
  [k: string]: unknown;
}

export interface WebhookEvent extends PaymentRecord {
  event_type: 'payment';
  cart_mandate_id?: string;
  amount?: string;
}

/** Checks `X-Signature: t=..,v1=..` over the RAW body (constant-time, ±300 s) and returns the parsed event. */
export function verifyWebhook(rawBody: string, signatureHeader: string | undefined | null, appSecret: string, nowSeconds = Math.floor(Date.now() / 1000)): WebhookEvent {
  if (!signatureHeader) throw new Error('missing X-Signature');
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of signatureHeader.split(',')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 't') t = Number(rest.join('='));
    else if (k === 'v1') v1 = rest.join('=');
  }
  if (t === undefined || !Number.isInteger(t) || !v1) throw new Error('malformed X-Signature');
  if (Math.abs(nowSeconds - t) > MAX_SKEW_SECONDS) throw new Error('webhook timestamp out of tolerance');
  const expected = Buffer.from(createHmac('sha256', appSecret).update(`${t}.${rawBody}`, 'utf8').digest('hex'));
  const received = Buffer.from(v1.toLowerCase());
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error('webhook signature mismatch');
  const event = JSON.parse(rawBody) as WebhookEvent;
  if (event?.event_type !== 'payment' || typeof event.payment_request_id !== 'string' || typeof event.status !== 'string') {
    throw new Error('not a payment webhook');
  }
  return event;
}

/** Signs a webhook body the way the gateway does (tests and the fake gateway). */
export function signWebhook(rawBody: string, appSecret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', appSecret).update(`${t}.${rawBody}`, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP client

export class MerchantApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`HashKey Merchant ${code ?? `HTTP ${httpStatus}`}: ${message}`);
  }
}

export interface CreatedOrder {
  paymentRequestId: string;
  paymentUrl: string;
  multiPay: boolean;
}

export class MerchantClient {
  private readonly base: string;
  constructor(
    private readonly opts: { baseUrl: string; creds: MerchantCredentials; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number },
  ) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, args: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const query = args.query ? new URLSearchParams(args.query).toString() : '';
    const fullPath = `/api/v1${path}`;
    const signed = signMerchantRequest(this.opts.creds, { method, path: fullPath, query, body: args.body }, { timestamp: this.opts.now?.() });
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.base}${fullPath}${query ? `?${query}` : ''}`, {
      method,
      headers: signed.headers,
      ...(signed.body !== undefined ? { body: signed.body } : {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    let envelope: any;
    try {
      envelope = await res.json();
    } catch {
      throw new MerchantApiError(res.status, undefined, 'answer is not JSON');
    }
    if (!res.ok || envelope?.code !== 0) {
      throw new MerchantApiError(res.status, typeof envelope?.code === 'number' ? envelope.code : undefined, String(envelope?.msg ?? 'request failed'));
    }
    return envelope.data as T;
  }

  /** POST /merchant/orders: one cart_mandate_id, one payment. */
  async createOrder(cartMandate: { contents: CartContents; merchant_authorization: string }, redirectUrl?: string): Promise<CreatedOrder> {
    const data: any = await this.call('POST', '/merchant/orders', { body: { cart_mandate: cartMandate, ...(redirectUrl ? { redirect_url: redirectUrl } : {}) } });
    if (typeof data?.payment_request_id !== 'string' || typeof data?.payment_url !== 'string') {
      throw new MerchantApiError(200, 0, 'create order answer has no payment_request_id / payment_url');
    }
    return { paymentRequestId: data.payment_request_id, paymentUrl: data.payment_url, multiPay: data.multi_pay === true };
  }

  async paymentByRequestId(paymentRequestId: string): Promise<PaymentRecord> {
    return this.call('GET', '/merchant/payments', { query: { payment_request_id: paymentRequestId } });
  }

  async paymentByFlowId(flowId: string): Promise<PaymentRecord> {
    return this.call('GET', '/merchant/payments', { query: { flow_id: flowId } });
  }

  async paymentsByCartMandateId(cartMandateId: string): Promise<PaymentRecord[]> {
    return this.call('GET', '/merchant/payments', { query: { cart_mandate_id: cartMandateId } });
  }
}

import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import type { NetworkConfig } from '../config.js';
import {
  MERCHANT_QA_URL,
  MerchantClient,
  ON_CHAIN_STATES,
  TERMINAL_STATES,
  buildCartContents,
  cartHash,
  parseDecimal,
  signMerchantAuthorization,
  verifyWebhook,
  type CreatedOrder,
  type PaymentRecord,
  type WebhookEvent,
} from './hsp-merchant.js';

/**
 * HSP rail behind one interface. HSP is the HashKey Merchant API (src/rails/hsp-merchant.ts):
 *
 *  - `merchant`: Agent B creates a one-time Cart Mandate (HMAC + ES256K merchant JWT), the payer pays it at the
 *                gateway's checkout (`payment_url`), and Agent B reads the outcome from the payments API (or a
 *                signed webhook). Used when app_key, app_secret and the merchant key are all available.
 *  - `stub`:     until then. It never claims a payment happened: every result is `simulated: true` and the demo
 *                writes no on-chain receipt for it.
 */

export interface HspOrder {
  cartMandateId: string;
  paymentRequestId: string;
  paymentUrl?: string;
  amount: bigint;
  payTo: Address;
  simulated: boolean;
}

/** A payment record reduced to what the seller acts on, with addresses and amounts already parsed. */
export interface HspPaymentState {
  status: string;
  /** On chain (included, safe or finalized). */
  paid: boolean;
  terminal: boolean;
  simulated: boolean;
  txHash?: Hex;
  payer?: Address;
  payTo?: Address;
  token?: Address;
  chain?: string;
  amount?: bigint;
  reason?: string;
}

export interface HspRail {
  readonly mode: 'merchant' | 'stub';
  /** Why the rail is in stub mode (shown in the UI). */
  readonly reason?: string;
  createOrder(req: { taskRef: string; amount: bigint; payTo: Address; label: string }): Promise<HspOrder>;
  payment(paymentRequestId: string): Promise<HspPaymentState>;
  /** Verifies a gateway webhook (HMAC over the raw body) and keeps it; throws when it is not authentic. */
  handleWebhook?(rawBody: string, signatureHeader: string | undefined): WebhookEvent;
}

export interface HspSecrets {
  appKey?: string;
  appSecret?: string;
  /** PEM (PKCS8 or SEC1) of the secp256k1 merchant key registered with the gateway. */
  merchantPrivateKeyPem?: string;
}

export interface HspConfig extends HspSecrets {
  baseUrl?: string;
  merchantName?: string;
}

export function hspConfigFromProcess(): Pick<HspConfig, 'baseUrl' | 'merchantName'> {
  const v = (k: string) => process.env[k]?.trim() || undefined;
  return { baseUrl: v('HSP_MERCHANT_BASE_URL') ?? MERCHANT_QA_URL, merchantName: v('HSP_MERCHANT_NAME') ?? 'AgentSettle' };
}

/** Stub rail: same shapes, loudly simulated. */
export class StubHspRail implements HspRail {
  readonly mode = 'stub' as const;
  constructor(readonly reason: string) {}

  async createOrder(req: { taskRef: string; amount: bigint; payTo: Address; label: string }): Promise<HspOrder> {
    const id = `SIM-${req.taskRef}`;
    return { cartMandateId: id, paymentRequestId: id, amount: req.amount, payTo: req.payTo, simulated: true };
  }

  async payment(_paymentRequestId: string): Promise<HspPaymentState> {
    return { status: 'SIMULATED', paid: false, terminal: true, simulated: true, reason: this.reason };
  }
}

const addr = (v: unknown): Address | undefined => (typeof v === 'string' && isAddress(v, { strict: false }) ? getAddress(v) : undefined);

/** Parses a gateway record for one network: anything malformed stays undefined, so the flow refuses to deliver on it. */
export function toPaymentState(rec: PaymentRecord, net: NetworkConfig): HspPaymentState {
  let amount: bigint | undefined;
  try {
    amount = rec.pay_amount === undefined ? undefined : parseDecimal(String(rec.pay_amount), net.usdc.decimals);
  } catch {
    amount = undefined;
  }
  const tx = typeof rec.tx_signature === 'string' && isHex(rec.tx_signature) && rec.tx_signature.length === 66 ? (rec.tx_signature as Hex) : undefined;
  return {
    status: String(rec.status),
    paid: ON_CHAIN_STATES.includes(String(rec.status)),
    terminal: TERMINAL_STATES.includes(String(rec.status)),
    simulated: false,
    txHash: tx,
    payer: addr(rec.payer_address),
    payTo: addr(rec.to_pay_address),
    token: addr(rec.token_address),
    chain: typeof rec.chain === 'string' ? rec.chain : undefined,
    amount,
    reason: typeof rec.status_reason === 'string' ? rec.status_reason : undefined,
  };
}

export class MerchantHspRail implements HspRail {
  readonly mode = 'merchant' as const;
  readonly reason = undefined;
  private readonly webhooks = new Map<string, WebhookEvent>();

  constructor(
    private readonly net: NetworkConfig,
    private readonly client: MerchantClient,
    private readonly merchant: { name: string; privateKeyPem: string; orderTtlSeconds?: number },
    private readonly webhookSecret: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async createOrder(req: { taskRef: string; amount: bigint; payTo: Address; label: string }): Promise<HspOrder> {
    const contents = buildCartContents({
      cartMandateId: `AS-${req.taskRef}`,
      paymentRequestId: `AS-PR-${req.taskRef}`,
      merchantName: this.merchant.name,
      label: req.label,
      amount: req.amount,
      token: { address: this.net.usdc.address, symbol: 'USDC', decimals: this.net.usdc.decimals },
      network: { name: this.net.name, chainId: this.net.chainId },
      payTo: req.payTo,
      expiresAt: new Date(this.now() + (this.merchant.orderTtlSeconds ?? 2 * 3600) * 1000),
    });
    const jwt = signMerchantAuthorization(this.merchant.privateKeyPem, {
      merchantName: this.merchant.name,
      cartHash: cartHash(contents),
      now: Math.floor(this.now() / 1000),
    });
    const created: CreatedOrder = await this.client.createOrder({ contents, merchant_authorization: jwt });
    if (created.paymentRequestId !== contents.payment_request.details.id) {
      throw new Error(`gateway answered payment_request_id ${created.paymentRequestId}, expected ${contents.payment_request.details.id}`);
    }
    return { cartMandateId: contents.id, paymentRequestId: created.paymentRequestId, paymentUrl: created.paymentUrl, amount: req.amount, payTo: req.payTo, simulated: false };
  }

  /** The payments API is the source of truth; a verified webhook only lets the UI show progress earlier. */
  async payment(paymentRequestId: string): Promise<HspPaymentState> {
    return toPaymentState(await this.client.paymentByRequestId(paymentRequestId), this.net);
  }

  handleWebhook(rawBody: string, signatureHeader: string | undefined): WebhookEvent {
    const event = verifyWebhook(rawBody, signatureHeader, this.webhookSecret, Math.floor(this.now() / 1000));
    this.webhooks.set(event.payment_request_id, event);
    if (this.webhooks.size > 1000) this.webhooks.delete(this.webhooks.keys().next().value!);
    return event;
  }

  lastWebhook(paymentRequestId: string): WebhookEvent | undefined {
    return this.webhooks.get(paymentRequestId);
  }
}

/** Picks the rail: merchant mode only with app_key, app_secret and the merchant key; otherwise a stub that says what is missing. */
export function createHspRail(net: NetworkConfig, cfg: HspConfig): HspRail {
  if (net.name !== 'hashkey-testnet') return new StubHspRail('HSP runs against the HashKey Merchant QA gateway on hashkey-testnet only');
  const missing = [!cfg.appKey && 'app_key', !cfg.appSecret && 'app_secret', !cfg.merchantPrivateKeyPem && 'merchant key'].filter(Boolean);
  if (missing.length) return new StubHspRail(`waiting for the HashKey Merchant credentials (${missing.join(', ')})`);
  const client = new MerchantClient({ baseUrl: cfg.baseUrl ?? MERCHANT_QA_URL, creds: { appKey: cfg.appKey!, appSecret: cfg.appSecret! } });
  return new MerchantHspRail(net, client, { name: cfg.merchantName ?? 'AgentSettle', privateKeyPem: cfg.merchantPrivateKeyPem! }, cfg.appSecret!);
}

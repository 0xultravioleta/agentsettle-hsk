import { Hono } from 'hono';
import { getAddress, type Address, type Hex, type LocalAccount } from 'viem';
import { FacilitatorClient } from 'uvd-x402-sdk/backend';
import { PREMIUM_TASK_PRICE, TASK_PRICE, explorerTx, type NetworkConfig } from '../config.js';
import { recordReceipt, resultHashOf, taskIdFor, type RecordedReceipt } from '../receipts.js';
import {
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  buildPaymentRequired,
  decodeHeader,
  encodeHeader,
  mismatchReason,
  type PaymentPayload,
  type PaymentRequirement,
  type ResourceInfo,
} from '../rails/x402.js';
import { MAX_TEXT_LENGTH, translateEnEs } from './translate.js';

/**
 * Agent B (seller, W3 on mainnet / W5 on testnet): an HTTP service that answers 402 until it is paid.
 * Paid flow: X-PAYMENT -> facilitator /verify -> /settle (the facilitator pays gas) -> do the task ->
 * AgentSettleReceipts.recordReceipt(taskId, ..., settleTx, 0x0, keccak(result)) -> 200 with the result.
 */

export type Facilitator = Pick<FacilitatorClient, 'verify' | 'settle'>;

export interface SellerOptions {
  net: NetworkConfig;
  /** Receives the USDC and writes receipts. */
  operator: LocalAccount;
  facilitator: Facilitator;
  /** Absolute base URL the buyer reaches us at (goes into resource.url). */
  publicUrl: string;
  /** Skip recordReceipt (e.g. no contract deployed yet); the payment flow still runs. */
  recordReceipts?: boolean;
  log?: (msg: string) => void;
}

export interface TaskResponse {
  taskId: Hex;
  task: 'translate';
  tier: 'standard' | 'premium';
  input: string;
  result: string;
  resultHash: Hex;
  payment: { network: string; payer: Address; payTo: Address; amount: string; asset: Address; settleTx: Hex; explorer?: string };
  receipt: (RecordedReceipt & { explorer?: string }) | { error: string } | null;
}

export function priceFor(tier: string | undefined): { tier: 'standard' | 'premium'; amount: bigint } {
  return tier === 'premium' ? { tier: 'premium', amount: PREMIUM_TASK_PRICE } : { tier: 'standard', amount: TASK_PRICE };
}

/** The facilitator wants the SDK's v1-style requirement object; network stays CAIP-2 so the SDK sends the v2 envelope. */
export function toSdkRequirement(req: PaymentRequirement, resource: ResourceInfo) {
  return {
    scheme: req.scheme,
    network: req.network,
    maxAmountRequired: req.amount,
    resource: resource.url,
    description: resource.description,
    mimeType: resource.mimeType,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    asset: req.asset,
    extra: req.extra,
  };
}

export function createSeller(opts: SellerOptions) {
  const { net, operator, facilitator } = opts;
  const payTo = getAddress(operator.address);
  const log = opts.log ?? (() => {});
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok', agent: 'B', role: 'seller', network: net.caip2, payTo }));

  app.get('/task/translate', async (c) => {
    const text = (c.req.query('text') ?? '').trim();
    if (!text) return c.json({ error: 'text is required' }, 400);
    if (text.length > MAX_TEXT_LENGTH) return c.json({ error: `text is longer than ${MAX_TEXT_LENGTH} characters` }, 400);
    const { tier, amount } = priceFor(c.req.query('tier'));
    const url = new URL(`/task/translate?text=${encodeURIComponent(text)}${tier === 'premium' ? '&tier=premium' : ''}`, opts.publicUrl).toString();
    const resource: ResourceInfo = {
      url,
      description: tier === 'premium' ? 'Certified EN->ES translation by Agent B' : 'EN->ES translation by Agent B',
      mimeType: 'application/json',
    };
    const required = buildPaymentRequired(net, { payTo, amount, resource });
    const requirement = required.accepts[0]!;
    const paymentRequired = (error: string) => {
      c.header(PAYMENT_REQUIRED_HEADER, encodeHeader({ ...required, error }));
      return c.json({ ...required, error }, 402);
    };

    const header = c.req.header(PAYMENT_HEADER) ?? c.req.header(PAYMENT_SIGNATURE_HEADER);
    if (!header) return paymentRequired(required.error);

    let payment: PaymentPayload;
    try {
      payment = decodeHeader<PaymentPayload>(header);
    } catch {
      return paymentRequired('payment header is not base64 JSON');
    }
    const mismatch = mismatchReason(payment, requirement);
    if (mismatch) return paymentRequired(`payment does not match the price: ${mismatch}`);

    // One idempotency key per authorization: a retry of the same payment gets the original answer back.
    const idempotencyKey = `agentsettle-${payment.payload.authorization.nonce.slice(2)}`;
    const sdkReq = toSdkRequirement(requirement, resource);
    const verified = await facilitator.verify(payment as any, sdkReq as any, { idempotencyKey });
    if (!verified.isValid) {
      log(`verify rejected: ${String(verified.invalidReason)}`);
      return paymentRequired(`facilitator rejected the payment: ${String(verified.invalidReason)}`);
    }
    const settled = await facilitator.settle(payment as any, sdkReq as any, { idempotencyKey });
    const settleTx = settled.transactionHash as Hex | undefined;
    if (!settled.success || !settleTx) {
      log(`settle failed: ${String(settled.errorReason ?? (settled as any).error)}`);
      return c.json({ error: 'settlement failed', reason: settled.errorReason ?? (settled as any).error ?? 'unknown' }, 502);
    }
    const payer = getAddress(payment.payload.authorization.from);
    log(`settled ${requirement.amount} from ${payer}: ${settleTx}`);

    // Paid: do the work, then write the receipt.
    const result = translateEnEs(text);
    const resultHash = resultHashOf(result);
    const taskId = taskIdFor(net.chainId, payer, payment.payload.authorization.nonce);
    let receipt: TaskResponse['receipt'] = null;
    if (opts.recordReceipts !== false && net.receiptsAddress) {
      try {
        const r = await recordReceipt(net, operator, {
          taskId,
          payer,
          payee: payTo,
          token: net.usdc.address,
          amount: BigInt(requirement.amount),
          settleTx,
          resultHash,
        });
        receipt = { ...r, explorer: explorerTx(net, r.tx) };
      } catch (err) {
        // The buyer paid and gets the work either way; the missing receipt is reported, not hidden.
        receipt = { error: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
      }
    }

    c.header(
      PAYMENT_RESPONSE_HEADER,
      encodeHeader({ success: true, transaction: settleTx, network: requirement.network, payer }),
    );
    const body: TaskResponse = {
      taskId,
      task: 'translate',
      tier,
      input: text,
      result,
      resultHash,
      payment: { network: requirement.network, payer, payTo, amount: requirement.amount, asset: requirement.asset, settleTx, explorer: explorerTx(net, settleTx) },
      receipt: receipt && 'tx' in receipt ? { ...receipt, block: receipt.block } : receipt,
    };
    return c.json(JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
  });

  return app;
}

export function facilitatorClient(baseUrl: string): Facilitator {
  return new FacilitatorClient({ baseUrl: baseUrl.replace(/\/+$/, ''), x402Version: 2, timeout: 60_000 });
}

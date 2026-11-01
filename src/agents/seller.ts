import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { getAddress, type Address, type Hex, type LocalAccount } from 'viem';
import { FacilitatorClient } from 'uvd-x402-sdk/backend';
import { PREMIUM_TASK_PRICE, TASK_PRICE, explorerTx, type NetworkConfig } from '../config.js';
import { authorizationUsed, confirmTransfer, findAuthorizationTx } from '../chain.js';
import { readReceipt, recordReceipt, resultHashOf, taskIdFor } from '../receipts.js';
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
  /** JSON file that keeps the nonce -> task binding across restarts (data/ in the demo). Memory only when unset. */
  bindingPath?: string;
  /** How long to wait for the settle tx receipt before refusing to deliver (default 30 s). */
  confirmTimeoutMs?: number;
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
  /** true when this answers a retry of a payment that was already settled (no second charge, no second receipt) */
  replayed: boolean;
  receipt: ({ taskId: Hex; tx?: Hex; contract: Address; block?: bigint; existing?: boolean; explorer?: string }) | { error: string } | null;
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
  // nonce -> the task text the FIRST attempt to settle that authorization was for. Written before settling, never
  // overwritten, kept after delivery (optionally on disk): it is what binds a payment to one task when there is no
  // receipt to compare against (lost settle response, receipts disabled, failed recordReceipt, restart).
  const paidFor = new TaskBinding(opts.bindingPath);
  // one request per authorization at a time: a second request for the same nonce waits for the first one's outcome
  const queues = new Map<string, Promise<unknown>>();
  const serialized = async <T>(nonce: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(nonce) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    queues.set(nonce, run);
    try {
      return await run;
    } finally {
      if (queues.get(nonce) === run) queues.delete(nonce);
    }
  };
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

    const auth = payment.payload.authorization;
    return serialized(auth.nonce.toLowerCase(), async () => {
      // One idempotency key per authorization, so a retry of the same payment can get the original answer back.
      const payer = getAddress(auth.from);
      const idempotencyKey = `agentsettle-${auth.nonce.slice(2)}`;
      const sdkReq = toSdkRequirement(requirement, resource);
      const taskId = taskIdFor(net.chainId, payer, auth.nonce);
      const result = translateEnEs(text);
      const resultHash = resultHashOf(result);

      let settleTx: Hex | undefined;
      let replayed = false;
      const verified = await facilitator.verify(payment as any, sdkReq as any, { idempotencyKey });
      if (!verified.isValid) {
        const reason = String((verified as any).errorCode ?? verified.invalidReason);
        let used: boolean | undefined = /authorization_already_settled|authorization_in_flight|authorization_used/i.test(reason) || undefined;
        used ??= await authorizationUsed(net, payer, auth.nonce).catch(() => undefined);
        if (used === undefined) {
          // cannot tell whether this authorization already paid: a fresh 402 here could make the client pay twice
          c.header('Retry-After', '5');
          return c.json({ error: 'cannot check the payment on-chain right now; retry the same request', reason }, 503);
        }
        if (!used) {
          log(`verify rejected: ${reason}`);
          return paymentRequired(`facilitator rejected the payment: ${reason}`);
        }
        // Already admitted. Never answer 402 here (a client would pay twice): ask settle for the original answer with
        // the same key, or find the tx on-chain, and deliver only if it is the SAME task this payment bought.
        const again = await facilitator.settle(payment as any, sdkReq as any, { idempotencyKey });
        settleTx = (again.success ? (again.transactionHash as Hex | undefined) : undefined) ?? (await findAuthorizationTx(net, payer, auth.nonce).catch(() => undefined));
        if (!settleTx) {
          c.header('Retry-After', '5');
          return c.json({ error: 'this authorization is already being settled; retry the same request', reason }, 409);
        }
        replayed = true;
      } else {
        if (!paidFor.claim(auth.nonce, text)) {
          return c.json({ error: 'this authorization already paid for another task', taskId }, 409);
        }
        const settled = await facilitator.settle(payment as any, sdkReq as any, { idempotencyKey });
        settleTx = settled.transactionHash as Hex | undefined;
        if (!settled.success || !settleTx) {
          // the request may still have reached the chain: a retry of the same X-PAYMENT reconciles through the path above
          log(`settle failed: ${String(settled.errorReason ?? (settled as any).error)}`);
          return c.json({ error: 'settlement failed', reason: settled.errorReason ?? (settled as any).error ?? 'unknown' }, 502);
        }
      }

      // The facilitator's word is not enough: the mined tx must move exactly the price, from the payer, to us.
      if (!(await confirmTransfer(net, settleTx, { from: payer, to: payTo, value: BigInt(requirement.amount), nonce: auth.nonce }, opts.confirmTimeoutMs))) {
        log(`settle tx ${settleTx} does not show the payment on-chain`);
        return c.json({ error: 'settlement not confirmed on-chain', settleTx }, 502);
      }
      log(`${replayed ? 'replayed' : 'settled'} ${requirement.amount} from ${payer}: ${settleTx}`);

      let receipt: TaskResponse['receipt'] = null;
      const existing = net.receiptsAddress ? await readReceipt(net, taskId) : undefined;
      // one payment, one task: the receipt (when there is one) and the first attempt's text must both be this request's
      const boundText = paidFor.get(auth.nonce);
      if ((existing && existing.resultHash !== resultHash) || (boundText !== undefined && boundText !== text) || (replayed && !existing && boundText === undefined)) {
        return c.json({ error: 'this authorization already paid for another task', taskId }, 409);
      }
      if (existing) {
        receipt = { taskId, tx: existing.tx, contract: net.receiptsAddress!, existing: true, explorer: existing.tx ? explorerTx(net, existing.tx) : undefined };
      } else if (opts.recordReceipts !== false && net.receiptsAddress) {
        try {
          const r = await recordReceipt(net, operator, { taskId, payer, payee: payTo, token: net.usdc.address, amount: BigInt(requirement.amount), settleTx, resultHash });
          receipt = { ...r, explorer: explorerTx(net, r.tx) };
        } catch (err) {
          // The buyer paid and gets the work either way; the missing receipt is reported, not hidden.
          receipt = { error: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
        }
      }
      c.header(PAYMENT_RESPONSE_HEADER, encodeHeader({ success: true, transaction: settleTx, network: requirement.network, payer }));
      const body: TaskResponse = {
        taskId,
        task: 'translate',
        tier,
        input: text,
        result,
        resultHash,
        replayed,
        payment: { network: requirement.network, payer, payTo, amount: requirement.amount, asset: requirement.asset, settleTx, explorer: explorerTx(net, settleTx) },
        receipt,
      };
      return c.json(JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
    });
  });

  return app;
}

export function facilitatorClient(baseUrl: string): Facilitator {
  return new FacilitatorClient({ baseUrl: baseUrl.replace(/\/+$/, ''), x402Version: 2, timeout: 60_000 });
}

/** nonce -> task text, first writer wins. Bounded; persisted as JSON when a path is given. */
export class TaskBinding {
  private readonly map = new Map<string, string>();
  constructor(private readonly path?: string, private readonly max = 5_000) {
    if (path && existsSync(path)) {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(path, 'utf8') || '{}') as Record<string, string>)) this.map.set(k, v);
    }
  }
  get(nonce: string): string | undefined {
    return this.map.get(nonce.toLowerCase());
  }
  /** true if `text` is (now) the task bound to `nonce`; false if another task already holds it. */
  claim(nonce: string, text: string): boolean {
    const key = nonce.toLowerCase();
    const prior = this.map.get(key);
    if (prior !== undefined) return prior === text;
    this.map.set(key, text);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
      renameSync(tmp, this.path);
    }
    return true;
  }
}

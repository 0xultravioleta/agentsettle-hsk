import type { Address, LocalAccount } from 'viem';
import { explorerTx, type NetworkConfig } from '../config.js';
import { SpendDeniedError, fmtUsdc, type SpendGuard } from '../spend-guard.js';
import {
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  decodeHeader,
  encodeHeader,
  buildAuthorization,
  selectRequirement,
  signAuthorization,
  type ResourceInfo,
} from '../rails/x402.js';
import type { TaskResponse } from './seller.js';

/**
 * Agent A (buyer, W4 on mainnet / W6 on testnet). Asks Agent B for a task, reads the 402, checks the spend
 * policy BEFORE signing, signs an EIP-3009 authorization (no gas) and retries with X-PAYMENT.
 * Returns a step-by-step trace that the CLI prints and the judge UI animates.
 */

export type StepName =
  | 'request'
  | 'payment_required'
  | 'spend_check'
  | 'spend_denied'
  | 'signed'
  | 'paid_request'
  | 'settled'
  | 'delivered'
  | 'receipt'
  | 'error';

export interface Step {
  step: StepName;
  at: string;
  title: string;
  detail?: Record<string, unknown>;
  link?: string;
}

export interface HireResult {
  ok: boolean;
  denied?: { code: string; reason: string };
  steps: Step[];
  response?: TaskResponse;
}

export interface BuyerOptions {
  net: NetworkConfig;
  account: LocalAccount;
  guard: SpendGuard;
  /** The agent we meant to hire: a 402 that names any other payee is refused (redirects, MITM, compromised URL). */
  expectedPayTo?: Address;
  /** Retries of the same X-PAYMENT after 502/503 or a 409 with Retry-After (default 3). */
  sameHeaderRetries?: number;
  /** Multiplier for Retry-After seconds (tests use a few ms). */
  retryUnitMs?: number;
  fetchImpl?: typeof fetch;
}

const isRetryable = (r: Response) => r.status === 502 || r.status === 503 || (r.status === 409 && r.headers.has('retry-after'));

export async function hire(opts: BuyerOptions, url: string): Promise<HireResult> {
  const steps: Step[] = [];
  try {
    return await hireInner(opts, url, steps);
  } catch (err) {
    // never throw at the caller: a hostile seller must not be able to crash the agent
    steps.push({ step: 'error', at: new Date().toISOString(), title: err instanceof Error ? err.message.split('\n')[0]! : String(err) });
    return { ok: false, steps };
  }
}

async function hireInner(opts: BuyerOptions, url: string, steps: Step[]): Promise<HireResult> {
  const { net, account, guard } = opts;
  const f = opts.fetchImpl ?? fetch;
  const push = (step: StepName, title: string, detail?: Record<string, unknown>, link?: string) =>
    steps.push({ step, at: new Date().toISOString(), title, ...(detail ? { detail } : {}), ...(link ? { link } : {}) });

  const u = new URL(url);
  let shown = `${u.pathname}${u.search}`;
  try {
    shown = decodeURIComponent(shown);
  } catch {
    /* keep it encoded */
  }
  push('request', `Agent A -> GET ${shown}`, { url });
  const first = await f(url);
  if (first.status !== 402) {
    push('error', `expected 402 Payment Required, got ${first.status}`, { body: await first.text() });
    return { ok: false, steps };
  }
  const headerValue = first.headers.get(PAYMENT_REQUIRED_HEADER);
  const body: any = headerValue ? decodeHeader(headerValue) : await first.json();
  push('payment_required', '402 Payment Required', { accepts: body.accepts, resource: body.resource });

  let requirement;
  try {
    requirement = selectRequirement(body, net, { expectedPayTo: opts.expectedPayTo });
  } catch (err) {
    push('error', err instanceof Error ? err.message : String(err));
    return { ok: false, steps };
  }
  const amount = BigInt(requirement.amount);
  const resource: ResourceInfo = body.resource ?? { url, description: '', mimeType: 'application/json' };
  // everything that can fail is built BEFORE the spend is booked; after booking only the signature remains
  const authorization = buildAuthorization(account.address, requirement);

  try {
    const d = guard.authorize(amount, url);
    push('spend_check', `Spend policy OK: ${fmtUsdc(amount)} USDC`, {
      perTxCap: fmtUsdc(d.policy.perTxCap),
      dailyCap: fmtUsdc(d.policy.dailyCap),
      spentToday: fmtUsdc(d.spentToday),
      remainingToday: fmtUsdc(d.remainingToday),
    });
  } catch (err) {
    if (err instanceof SpendDeniedError) {
      push('spend_denied', `Spend policy DENIED: ${err.message}`, {
        code: err.code,
        amount: fmtUsdc(err.amount),
        perTxCap: fmtUsdc(guard.policy.perTxCap),
        dailyCap: fmtUsdc(guard.policy.dailyCap),
        spentToday: fmtUsdc(err.spentToday),
        signed: false,
      });
      return { ok: false, denied: { code: err.code, reason: err.message }, steps };
    }
    throw err;
  }

  const payment = await signAuthorization(account, net, requirement, resource, authorization);
  const a = payment.payload.authorization;
  push('signed', 'EIP-3009 authorization signed (no gas)', {
    from: a.from,
    to: a.to,
    value: a.value,
    validBefore: a.validBefore,
    nonce: a.nonce,
    network: requirement.network,
    token: `${net.usdc.eip712.name} v${net.usdc.eip712.version} ${requirement.asset}`,
  });

  // A lost or failed settle answer is retried with the SAME signed payment: it can only settle once, and the seller
  // answers a retry with the original delivery. Never sign again for the same task.
  const header = encodeHeader(payment);
  let paid = await f(url, { headers: { [PAYMENT_HEADER]: header } });
  push('paid_request', `retry with ${PAYMENT_HEADER} -> ${paid.status}`);
  for (let attempt = 1; attempt <= (opts.sameHeaderRetries ?? 3) && isRetryable(paid); attempt++) {
    const wait = Math.min(10, Number(paid.headers.get('retry-after') ?? '2') || 2) * (opts.retryUnitMs ?? 1000);
    push('paid_request', `${paid.status}: retrying the same ${PAYMENT_HEADER} in ${wait} ms (no new signature)`);
    await new Promise((r) => setTimeout(r, wait));
    paid = await f(url, { headers: { [PAYMENT_HEADER]: header } });
    push('paid_request', `same ${PAYMENT_HEADER} -> ${paid.status}`);
  }
  if (paid.status !== 200) {
    push('error', `seller answered ${paid.status}`, { body: await paid.text() });
    return { ok: false, steps };
  }
  const response = (await paid.json()) as TaskResponse;
  push('settled', 'Facilitator settled on-chain', { tx: response.payment.settleTx, payer: response.payment.payer }, explorerTx(net, response.payment.settleTx));
  push('delivered', `Agent B delivered: "${response.result}"`, { resultHash: response.resultHash, taskId: response.taskId });
  if (response.receipt && 'contract' in response.receipt) {
    const r = response.receipt;
    push(
      'receipt',
      r.existing ? 'Receipt already on AgentSettleReceipts (this was a retry: no second charge)' : 'recordReceipt() on AgentSettleReceipts',
      { tx: r.tx, contract: r.contract, taskId: response.taskId },
      r.tx ? explorerTx(net, r.tx) : undefined,
    );
  } else if (response.receipt && 'error' in response.receipt) {
    push('error', `receipt not written: ${response.receipt.error}`);
  }
  return { ok: true, steps, response };
}

import type { LocalAccount } from 'viem';
import { explorerTx, type NetworkConfig } from '../config.js';
import { SpendDeniedError, fmtUsdc, type SpendGuard } from '../spend-guard.js';
import {
  PAYMENT_HEADER,
  PAYMENT_REQUIRED_HEADER,
  decodeHeader,
  encodeHeader,
  selectRequirement,
  signExactPayment,
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
  fetchImpl?: typeof fetch;
}

export async function hire(opts: BuyerOptions, url: string): Promise<HireResult> {
  const { net, account, guard } = opts;
  const f = opts.fetchImpl ?? fetch;
  const steps: Step[] = [];
  const push = (step: StepName, title: string, detail?: Record<string, unknown>, link?: string) =>
    steps.push({ step, at: new Date().toISOString(), title, ...(detail ? { detail } : {}), ...(link ? { link } : {}) });

  push('request', `Agent A -> GET ${new URL(url).pathname}${new URL(url).search}`, { url });
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
    requirement = selectRequirement(body, net);
  } catch (err) {
    push('error', err instanceof Error ? err.message : String(err));
    return { ok: false, steps };
  }
  const amount = BigInt(requirement.amount);

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

  const resource: ResourceInfo = body.resource ?? { url, description: '', mimeType: 'application/json' };
  const payment = await signExactPayment(account, net, requirement, resource);
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

  const paid = await f(url, { headers: { [PAYMENT_HEADER]: encodeHeader(payment) } });
  push('paid_request', `retry with ${PAYMENT_HEADER} -> ${paid.status}`);
  if (paid.status !== 200) {
    push('error', `seller answered ${paid.status}`, { body: await paid.text() });
    return { ok: false, steps };
  }
  const response = (await paid.json()) as TaskResponse;
  push('settled', 'Facilitator settled on-chain', { tx: response.payment.settleTx, payer: response.payment.payer }, explorerTx(net, response.payment.settleTx));
  push('delivered', `Agent B delivered: "${response.result}"`, { resultHash: response.resultHash, taskId: response.taskId });
  if (response.receipt && 'tx' in response.receipt) {
    push('receipt', 'recordReceipt() on AgentSettleReceipts', { tx: response.receipt.tx, contract: response.receipt.contract, taskId: response.taskId }, explorerTx(net, response.receipt.tx));
  } else if (response.receipt && 'error' in response.receipt) {
    push('error', `receipt not written: ${response.receipt.error}`);
  }
  return { ok: true, steps, response };
}

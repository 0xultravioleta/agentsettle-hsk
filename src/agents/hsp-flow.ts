import { randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { explorerTx, type NetworkConfig } from '../config.js';
import { confirmTransfer, publicClientFor } from '../chain.js';
import { SpendDeniedError, fmtUsdc } from '../spend-guard.js';
import { recordReceipt, resultHashOf, taskIdFor } from '../receipts.js';
import type { HspOrder, HspPaymentState, HspRail } from '../rails/hsp.js';
import type { Runtime } from '../runtime.js';
import type { Step } from './buyer.js';
import { translateEnEs } from './translate.js';

export interface HspFlowResult {
  ok: boolean;
  simulated: boolean;
  steps: Step[];
}

export interface HspFlowOptions {
  amount?: bigint;
  /** How long Agent B waits for the payment (default 10 min: the payer opens payment_url and signs in a wallet). */
  waitMs?: number;
  pollMs?: number;
  taskRef?: string;
  /** Push steps here as they happen (the UI follows a running HSP job). */
  steps?: Step[];
  /** Called once the order exists, so the CLI / UI can show the checkout link. */
  onOrder?: (order: HspOrder) => void | Promise<void>;
  /** The payer. By default whoever opens payment_url; tests plug a wallet in here. */
  pay?: (order: HspOrder) => Promise<void>;
}

/** Why a gateway record cannot be delivered on, or undefined when it matches the order exactly. */
export function paymentMismatch(state: HspPaymentState, expect: { net: NetworkConfig; payTo: Address; amount: bigint }): string | undefined {
  if (!state.txHash) return 'no tx_signature';
  if (!state.payer) return 'no valid payer_address';
  if (state.payTo !== getAddress(expect.payTo)) return `to_pay_address is ${state.payTo ?? 'missing'}, not Agent B`;
  if (state.token !== getAddress(expect.net.usdc.address)) return `token_address is ${state.token ?? 'missing'}, not USDC`;
  if (state.chain !== expect.net.caip2) return `chain is ${state.chain ?? 'missing'}, not ${expect.net.caip2}`;
  if (state.amount !== expect.amount) return `pay_amount is ${state.amount === undefined ? 'unreadable' : fmtUsdc(state.amount)}, not ${fmtUsdc(expect.amount)}`;
  return undefined;
}

async function waitForPayment(rail: HspRail, paymentRequestId: string, waitMs: number, pollMs: number): Promise<HspPaymentState & { lastError?: string }> {
  const deadline = Date.now() + waitMs;
  let last: HspPaymentState | undefined;
  let lastError: string | undefined;
  for (;;) {
    try {
      last = await rail.payment(paymentRequestId);
      lastError = undefined;
      if (last.paid || last.terminal) return last;
    } catch (err) {
      // before the payer submits, the record may not exist yet: keep asking until the deadline
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() + pollMs > deadline) return { ...(last ?? { status: 'no record', paid: false, terminal: false, simulated: false }), lastError };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Flow 2: the same task paid over HSP (HashKey Merchant). Agent B creates a one-time Cart Mandate, the payer pays it
 * at the gateway's checkout, Agent B reads the payment record, checks it against the order AND on-chain, then
 * delivers and writes the receipt with the payment_request_id. In stub mode every step says SIMULATED and nothing
 * is written on-chain.
 */
export async function hireViaHsp(rt: Runtime, text: string, opts: HspFlowOptions = {}): Promise<HspFlowResult> {
  const amount = opts.amount ?? 100_000n;
  const steps: Step[] = opts.steps ?? [];
  const push = (step: string, title: string, detail?: Record<string, unknown>, link?: string) =>
    steps.push({ step: step as Step['step'], at: new Date().toISOString(), title, ...(detail ? { detail } : {}), ...(link ? { link } : {}) });
  const taskRef = opts.taskRef ?? `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const order0 = { taskRef, amount, payTo: rt.operator.address, label: 'AgentSettle translation task' };

  if (rt.hsp.mode === 'stub') {
    await rt.hsp.createOrder(order0);
    push('hsp_order', `HSP cart mandate SIMULATED: ${rt.hsp.reason}`, { simulated: true, payTo: rt.operator.address, amount: fmtUsdc(amount) });
    push('hsp_payment', 'HSP payment SIMULATED (no real payment, no receipt written)', { simulated: true });
    return { ok: false, simulated: true, steps };
  }

  try {
    rt.guard.authorize(amount, 'hsp:merchant');
  } catch (err) {
    if (err instanceof SpendDeniedError) {
      push('spend_denied', `Spend policy DENIED: ${err.message}`, { code: err.code });
      return { ok: false, simulated: false, steps };
    }
    throw err;
  }
  const startBlock = await publicClientFor(rt.net).getBlockNumber();
  let order: HspOrder;
  try {
    order = await rt.hsp.createOrder(order0);
  } catch (err) {
    push('error', `HSP cart mandate not created: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, simulated: false, steps };
  }
  push('hsp_order', `Agent B created an HSP cart mandate for ${fmtUsdc(amount)} USDC (HMAC + ES256K merchant JWT)`, {
    paymentRequestId: order.paymentRequestId,
    cartMandateId: order.cartMandateId,
    paymentUrl: order.paymentUrl,
  }, order.paymentUrl);
  await opts.onOrder?.(order);
  if (opts.pay) await opts.pay(order);

  const waitMs = opts.waitMs ?? 10 * 60_000;
  const state = await waitForPayment(rt.hsp, order.paymentRequestId, waitMs, opts.pollMs ?? 5_000);
  push('hsp_payment', `HSP payment ${state.status}`, { tx: state.txHash, payer: state.payer, reason: state.reason ?? state.lastError }, state.txHash ? explorerTx(rt.net, state.txHash) : undefined);
  if (!state.paid) {
    push('error', state.terminal ? `HSP payment ${state.status}${state.reason ? `: ${state.reason}` : ''}: not delivering` : `no HSP payment on chain within ${Math.round(waitMs / 1000)} s: not delivering`);
    return { ok: false, simulated: false, steps };
  }
  const mismatch = paymentMismatch(state, { net: rt.net, payTo: rt.operator.address, amount });
  if (mismatch) {
    push('error', `HSP payment record does not match the order (${mismatch}): not delivering`);
    return { ok: false, simulated: false, steps };
  }
  // the gateway's word is not enough: the mined tx must move exactly this USDC from the payer to Agent B, after the order
  if (!(await confirmTransfer(rt.net, state.txHash!, { from: state.payer!, to: rt.operator.address, value: amount, afterBlock: startBlock }))) {
    push('error', `HSP tx ${state.txHash} does not show ${fmtUsdc(amount)} USDC from ${state.payer} to Agent B on-chain: not delivering`);
    return { ok: false, simulated: false, steps };
  }

  const result = translateEnEs(text);
  push('delivered', `Agent B delivered: "${result}"`, { payer: state.payer, payerIsAgentA: state.payer === getAddress(rt.buyer.address) });
  if (rt.net.receiptsAddress) {
    const r = await recordReceipt(rt.net, rt.operator, {
      taskId: taskIdFor(rt.net.chainId, state.payer!, order.paymentRequestId),
      payer: state.payer!,
      payee: rt.operator.address,
      token: rt.net.usdc.address,
      amount,
      settleTx: state.txHash!,
      hspPaymentId: order.paymentRequestId,
      resultHash: resultHashOf(result),
    });
    push('receipt', 'recordReceipt() with the HSP payment_request_id', { tx: r.tx, contract: r.contract }, explorerTx(rt.net, r.tx));
  }
  return { ok: true, simulated: false, steps };
}

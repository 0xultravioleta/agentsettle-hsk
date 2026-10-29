import { explorerTx } from '../config.js';
import { SpendDeniedError, fmtUsdc } from '../spend-guard.js';
import { recordReceipt, resultHashOf, taskIdFor } from '../receipts.js';
import type { Runtime } from '../runtime.js';
import type { Step } from './buyer.js';
import { translateEnEs } from './translate.js';

export interface HspFlowResult {
  ok: boolean;
  simulated: boolean;
  steps: Step[];
}

/**
 * Flow 2 of the brief: the same task paid through HSP on testnet. pay() -> awaitSettled() -> HSPVerifier
 * ACCEPT -> Agent B delivers -> recordReceipt with the hspPaymentId. In stub mode every step says SIMULATED
 * and nothing is written on-chain.
 */
export async function hireViaHsp(rt: Runtime, text: string, opts: { amount?: bigint; via?: 'pay' | 'payX402' } = {}): Promise<HspFlowResult> {
  const amount = opts.amount ?? 100_000n;
  const via = opts.via ?? 'pay';
  const steps: Step[] = [];
  const push = (step: Step['step'] | string, title: string, detail?: Record<string, unknown>, link?: string) =>
    steps.push({ step: step as Step['step'], at: new Date().toISOString(), title, ...(detail ? { detail } : {}), ...(link ? { link } : {}) });

  if (rt.hsp.mode === 'stub') {
    push('hsp_pay', `HSP ${via}() SIMULATED: ${rt.hsp.reason}`, { simulated: true, to: rt.operator.address, amount: fmtUsdc(amount) });
    const p = via === 'pay' ? await rt.hsp.pay({ to: rt.operator.address, amount }) : await rt.hsp.payX402({ merchant: rt.operator.address, amount });
    const v = await rt.hsp.verify(p.paymentId);
    push('hsp_verify', `HSPVerifier: ${v.outcomeClass} (no real payment, no receipt written)`, { simulated: true });
    return { ok: false, simulated: true, steps };
  }

  try {
    rt.guard.authorize(amount, `hsp:${via}`);
  } catch (err) {
    if (err instanceof SpendDeniedError) {
      push('spend_denied', `Spend policy DENIED: ${err.message}`, { code: err.code });
      return { ok: false, simulated: false, steps };
    }
    throw err;
  }
  const payment = via === 'pay' ? await rt.hsp.pay({ to: rt.operator.address, amount }) : await rt.hsp.payX402({ merchant: rt.operator.address, amount });
  push('hsp_pay', `HSP ${via}(): ${payment.status}`, { paymentId: payment.paymentId, tx: payment.txHash }, payment.txHash ? explorerTx(rt.net, payment.txHash) : payment.explorerUrl);
  const verdict = await rt.hsp.verify(payment.paymentId);
  push('hsp_verify', `HSPVerifier (local, pinned adapter): ${verdict.outcomeClass}`, { required: verdict.requiredCapabilities, satisfied: verdict.satisfiedCapabilities }, payment.explorerUrl);
  if (!verdict.ok) return { ok: false, simulated: false, steps };

  const result = translateEnEs(text);
  push('delivered', `Agent B delivered: "${result}"`);
  if (rt.net.receiptsAddress && payment.txHash) {
    const r = await recordReceipt(rt.net, rt.operator, {
      taskId: taskIdFor(rt.net.chainId, rt.buyer.address, payment.paymentId),
      payer: rt.buyer.address,
      payee: rt.operator.address,
      token: rt.net.usdc.address,
      amount,
      settleTx: payment.txHash,
      hspPaymentId: payment.paymentId,
      resultHash: resultHashOf(result),
    });
    push('receipt', 'recordReceipt() with hspPaymentId', { tx: r.tx, contract: r.contract }, explorerTx(rt.net, r.tx));
  }
  return { ok: true, simulated: false, steps };
}

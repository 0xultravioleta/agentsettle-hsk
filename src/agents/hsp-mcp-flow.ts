import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, recoverTypedDataAddress, type Hex, type LocalAccount } from 'viem';
import { assertMainnetAllowed, explorerTx, type NetworkConfig } from '../config.js';
import { ERC20_EIP3009_ABI, confirmTransfer, publicClientFor } from '../chain.js';
import { SpendDeniedError, fmtUsdc, type SpendGuard } from '../spend-guard.js';
import { recordReceipt, resultHashOf, taskIdFor } from '../receipts.js';
import { buildCartContents, formatDecimal } from '../rails/hsp-merchant.js';
import {
  HSP_ON_CHAIN_STATES,
  HSP_PENDING_AFTER_MS,
  HSP_POLL_MS,
  HSP_STOP_STATES,
  HspMcpClient,
  checkTypedData,
  maxRawFor,
  selectToken,
  toSignable,
  type HspToolCall,
  type PaymentQuery,
} from '../rails/hsp-mcp.js';
import type { Step } from './buyer.js';
import { translateEnEs } from './translate.js';

/**
 * The person at the terminal. HSP's guide and server require it: merchant_name and pay_to are asked one at a time
 * with no default, the payer is confirmed on its own, and the transfer is approved before signing and again before
 * submitting. Nothing here answers for them.
 */
export interface HumanConfirm {
  ask(question: string): Promise<string>;
  approve(question: string): Promise<boolean>;
}

export interface HspMcpFlowOptions {
  /** The chain the payment happens on (hashkey-testnet, or base-sepolia as the fallback). */
  payNet: NetworkConfig;
  operator: LocalAccount;
  /** Agent A's wallet: it signs the EIP-712 authorization here; the key never goes to the MCP server. */
  payer: LocalAccount;
  guard: SpendGuard;
  call: HspToolCall;
  human: HumanConfirm;
  text: string;
  amount?: bigint;
  taskRef?: string;
  pollMs?: number;
  pendingAfterMs?: number;
  now?: () => Date;
  steps?: Step[];
  /** Each step as it happens (the CLI prints them live). */
  onStep?: (s: Step) => void;
}

export interface HspMcpFlowResult {
  ok: boolean;
  /** "Pending confirmation": the ids to resume query_payment with. */
  pending?: { flowId: string; paymentRequestId: string };
  steps: Step[];
  report?: string;
}

/** The guide's result template, with "unavailable" for anything the gateway did not return. */
export function resultReport(q: PaymentQuery | undefined, merchantName: string, tokenTotalRaw: string | undefined): string {
  const v = (x: unknown) => (x === undefined || x === null || x === '' ? 'unavailable' : String(x));
  return [
    'HSP Agentic Payment — QA Result',
    `Payment status: ${v(q?.status)}`,
    `Hackathon team: ${merchantName}`,
    `Team attribution verified: ${v(q?.attribution_verified)}`,
    `Network: ${v(q?.payment?.network)}`,
    `Raw authorization amount (raw units): ${v(tokenTotalRaw)}`,
    `Recipient address: ${v(q?.payment?.to_pay_address)}`,
    `Payer address: ${v(q?.payment?.payer_address)}`,
    `Transaction hash: ${v(q?.payment?.tx_signature)}`,
  ].join('\n');
}

const statusLine = (q: PaymentQuery) =>
  q.status === 'payment-safe'
    ? 'The transaction is on-chain and has received half of the required block confirmations. It is not yet finalized.'
    : q.status === 'payment-finalized'
      ? 'The payment has reached final confirmation.'
      : q.status === 'payment-failed'
        ? `payment-failed: ${q.payment?.status_reason ?? 'no status_reason'}`
        : q.status;

/**
 * Flow 2 over HSP Agentic Payment: Agent A pays Agent B's cart mandate itself. Every value that moves money is
 * confirmed by the person at the terminal, every byte we sign is checked first, and B delivers only after the
 * transfer of exactly the signed authorization is on-chain.
 */
export async function payViaHspMcp(opts: HspMcpFlowOptions): Promise<HspMcpFlowResult> {
  const { payNet, human } = opts;
  const amount = opts.amount ?? 100_000n;
  const now = opts.now ?? (() => new Date());
  const steps: Step[] = opts.steps ?? [];
  const push = (step: string, title: string, detail?: Record<string, unknown>, link?: string) => {
    const s = { step: step as Step['step'], at: now().toISOString(), title, ...(detail ? { detail } : {}), ...(link ? { link } : {}) };
    steps.push(s);
    opts.onStep?.(s);
  };
  const stop = (title: string, extra: Partial<HspMcpFlowResult> = {}): HspMcpFlowResult => {
    push('error', title);
    return { ok: false, steps, ...extra };
  };
  const mcp = new HspMcpClient(opts.call);
  const taskRef = opts.taskRef ?? `${now().getTime().toString(36)}${randomBytes(4).toString('hex')}`;

  // HSP Agentic Payment is only approved on testnets; the same guard as every other mainnet path
  assertMainnetAllowed(payNet);
  const pre = opts.guard.check(amount);
  if (!pre.allowed) {
    push('spend_denied', `Spend policy DENIED: ${pre.reason}`, { code: pre.code });
    return { ok: false, steps };
  }

  // 1. what the gateway accepts right now: our USDC on our chain, eip3009
  let chain: ReturnType<typeof selectToken>;
  try {
    chain = selectToken(await mcp.getChainConfig(), { chainId: payNet.chainId, address: payNet.usdc.address });
  } catch (err) {
    return stop(`HSP get_chain_config: ${err instanceof Error ? err.message : String(err)}`);
  }
  push('hsp_config', `HSP get_chain_config: ${chain.token.symbol} ${chain.token.address} on ${chain.network.display_name} (${chain.token.payment_protocol})`, { chainId: payNet.chainId, token: chain.token.address });

  // 2. one at a time, no defaults
  const merchantName = await human.ask('merchant_name (the team name HSP aggregates this payment under; we propose AgentSettle):');
  if (!merchantName.trim()) return stop('no merchant_name: not creating the order');
  const payToIn = (await human.ask(`pay_to (the recipient; Agent B is ${opts.operator.address}):`)).trim();
  if (!isAddress(payToIn, { strict: false })) return stop(`pay_to "${payToIn}" is not an address: not creating the order`);
  const payTo = getAddress(payToIn);
  if (payTo !== opts.operator.address) return stop(`pay_to ${payTo} is not Agent B (${opts.operator.address}): not creating the order`);
  const payer = getAddress(opts.payer.address);
  if (payer === payTo) return stop('the payer cannot be pay_to: not creating the order');
  if (!(await human.approve(`payer: Agent A's wallet ${payer}. Is this the payer?`))) return stop('payer not confirmed: not creating the order');

  // 3. the cart mandate (the server signs merchant_authorization and overwrites data.pay_to with our pay_to)
  const contents = buildCartContents({
    cartMandateId: `AS-${taskRef}`,
    paymentRequestId: `AS-PR-${taskRef}`,
    merchantName,
    label: 'AgentSettle translation task',
    amount,
    token: { address: getAddress(chain.token.address), symbol: chain.token.symbol, decimals: chain.token.decimals },
    network: { name: chain.network.name, chainId: chain.network.chain_id },
    payTo,
    expiresAt: new Date(now().getTime() + 15 * 60_000),
  });
  let order;
  try {
    order = await mcp.createOrder({ merchant_name: merchantName, pay_to: payTo, cart_mandate: { contents } });
  } catch (err) {
    return stop(`HSP create_order failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ids = { flowId: order.flow_id, paymentRequestId: order.payment_request_id };
  push('hsp_order', `HSP cart mandate created for ${fmtUsdc(amount)} USD`, { ...ids, merchantName: order.merchant_name, paymentUrl: order.payment_url });
  if (order.payment_request_id !== contents.payment_request.details.id) return stop(`create_order answered payment_request_id ${order.payment_request_id}, not ours: not paying`);

  // 4. read the same order back before anything is signed
  const info = await mcp.getOrder(order.flow_id);
  const method = (info.method_data ?? []).find((m) => Number(m.chain_id) === payNet.chainId && typeof m.contract_address === 'string' && getAddress(m.contract_address) === getAddress(chain.token.address));
  if (info.payment_request_id !== order.payment_request_id) return stop(`get_order is for ${info.payment_request_id}, not ${order.payment_request_id}: not paying`);
  if (!method || typeof method.pay_to !== 'string' || !isAddress(method.pay_to, { strict: false }) || getAddress(method.pay_to) !== payTo) {
    return stop(`get_order has no ${chain.token.symbol} method paying ${payTo} on chain ${payNet.chainId}: not paying`);
  }
  const gasAdvanced = info.gas_fee_configs?.find((g) => g.network === chain.network.name)?.gas_fee_advanced;
  push('hsp_order', `get_order: ${info.status}; gas_fee_advanced=${String(gasAdvanced ?? 'unknown')}`, { merchantName: info.merchant_name });

  // 5. the quote and the typed data, then OUR checks (the server writes eip712; we sign it)
  let prep;
  try {
    prep = await mcp.preparePayment(order.flow_id, payer, 'eip3009');
  } catch (err) {
    return stop(`HSP prepare_payment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const maxRaw = maxRawFor(amount);
  const why = checkTypedData(prep, { chainId: payNet.chainId, token: chain.token, payer, payTo, maxRaw, now: now() });
  if (why) return stop(`REFUSED to sign the HSP authorization: ${why}`);
  const total = BigInt(prep.token_total_raw);
  const balance = await publicClientFor(payNet).readContract({ address: payNet.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'balanceOf', args: [payer] });
  if (balance < total) return stop(`payer ${payer} holds ${formatDecimal(balance, 6)} ${chain.token.symbol}, less than token_total_raw ${total}: fund it by hand, nothing was signed`);
  const summary = `pay_to ${payTo} · payer ${payer} · token_total_raw ${total} raw units (${formatDecimal(total, chain.token.decimals)} ${chain.token.symbol}, quote until ${prep.quote_expires_at})`;
  push('hsp_check', `Local check passed: TransferWithAuthorization of ${total} raw units on chain ${payNet.chainId}, cap ${maxRaw}`, { tokenTotalRaw: prep.token_total_raw, cap: maxRaw.toString() });
  if (!(await human.approve(`Sign? ${summary}`))) return stop('signature not approved: nothing was signed');

  // 6. book the spend, sign, and let the server turn the signature into the PaymentMandate
  try {
    opts.guard.authorize(total, `hsp-mcp:${order.payment_request_id}`);
  } catch (err) {
    if (err instanceof SpendDeniedError) {
      push('spend_denied', `Spend policy DENIED: ${err.message}`, { code: err.code });
      return { ok: false, steps };
    }
    throw err;
  }
  const typed = toSignable(prep.eip712);
  const signature = await opts.payer.signTypedData(typed);
  if ((await recoverTypedDataAddress({ ...typed, signature })) !== payer) return stop('the signature does not recover to the payer: not submitting');
  const fee = gasAdvanced === false ? 'the network fee is inside token_total_raw (gas_fee_advanced=false)' : 'gas paid by Agent A: 0';
  push('signed', `Agent A signed the EIP-712 authorization (${typed.message.nonce.slice(0, 10)}…) locally; ${fee}`, { nonce: typed.message.nonce });

  // 7. the signature leaves this process only after the second yes: whoever holds it can execute the transfer until
  //    validBefore, so finalize_payment (which hands it to HSP) comes after the quote check and the approval
  const quoteLive = () => new Date(prep.quote_expires_at).getTime() > now().getTime();
  const expired = () => stop(`the quote expired at ${prep.quote_expires_at}: the signature was not sent (run again for a new quote)`);
  if (!quoteLive()) return expired();
  if (!(await human.approve(`Submit? ${summary}`))) return stop('submission not approved: the signature never left this process');
  // the person may take longer than the quote: a late yes must not hand HSP a signature for an expired quote (30043)
  if (!quoteLive()) return expired();
  let fin;
  try {
    fin = await mcp.finalizePayment(signature, prep);
  } catch (err) {
    const until = new Date(Number(typed.message.validBefore) * 1000).toISOString();
    return stop(`HSP finalize_payment failed: ${err instanceof Error ? err.message : String(err)}. The signature may have reached HSP; it can only pay ${total} raw units to Agent B (${payTo}) and expires at ${until}`, { pending: ids });
  }
  push('hsp_check', `Handed to HSP for submission: ${summary}`, { payTo, payer, tokenTotalRaw: prep.token_total_raw });

  // 8. submit the mandate exactly as finalize_payment returned it
  try {
    await mcp.submitPayment(fin.payment_mandate_json);
  } catch (err) {
    // an unclear answer is not a failure: query before anything else, never resubmit blindly
    push('error', `HSP submit_payment: ${err instanceof Error ? err.message : String(err)}; querying the same payment`, ids);
  }
  push('hsp_submitted', 'HSP submit_payment sent; polling query_payment', ids);

  // 9. query every 15 s until safe / finalized / failed; after 10 min report "Pending confirmation"
  const pollMs = opts.pollMs ?? HSP_POLL_MS;
  const deadline = now().getTime() + (opts.pendingAfterMs ?? HSP_PENDING_AFTER_MS);
  let q: PaymentQuery | undefined;
  for (;;) {
    try {
      q = await mcp.queryPayment(order.flow_id, merchantName);
      if ((HSP_STOP_STATES as readonly string[]).includes(q.status)) break;
    } catch (err) {
      push('error', `HSP query_payment: ${err instanceof Error ? err.message : String(err)}`, ids);
    }
    if (now().getTime() + pollMs > deadline) {
      push('hsp_payment', `Pending confirmation (last status: ${q?.status ?? 'no answer'})`, ids);
      return { ok: false, pending: ids, steps, report: resultReport(q, merchantName, prep.token_total_raw) };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const report = resultReport(q, merchantName, prep.token_total_raw);
  const tx = q.payment?.tx_signature as Hex | undefined;
  push('hsp_payment', `HSP ${statusLine(q)} · attribution_verified=${q.attribution_verified}`, { ...ids, tx, attributionVerified: q.attribution_verified }, tx ? explorerTx(payNet, tx) : undefined);
  if (!(HSP_ON_CHAIN_STATES as readonly string[]).includes(q.status)) return stop(`HSP ${q.status}: not delivering`, { report });

  // 10. never on the gateway's word: the mined tx must consume OUR authorization and move exactly what we signed
  if (!tx) return stop('HSP reports the payment on-chain without a tx_signature: not delivering', { report });
  const p = q.payment;
  if (!p.payer_address || !isAddress(p.payer_address, { strict: false }) || getAddress(p.payer_address) !== payer) return stop(`payer_address is ${p.payer_address}, not ${payer}: not delivering`, { report });
  if (!p.to_pay_address || !isAddress(p.to_pay_address, { strict: false }) || getAddress(p.to_pay_address) !== payTo) return stop(`to_pay_address is ${p.to_pay_address}, not Agent B: not delivering`, { report });
  if (!(await confirmTransfer(payNet, tx, { from: payer, to: payTo, value: total, nonce: typed.message.nonce }))) {
    return stop(`tx ${tx} does not consume our authorization or move ${total} raw units from ${payer} to Agent B: not delivering`, { report });
  }

  const result = translateEnEs(opts.text);
  push('delivered', `Agent B delivered: "${result}"`, { payer });
  if (payNet.receiptsAddress) {
    const r = await recordReceipt(payNet, opts.operator, {
      taskId: taskIdFor(payNet.chainId, payer, order.payment_request_id),
      payer,
      payee: payTo,
      token: payNet.usdc.address,
      amount: total,
      settleTx: tx,
      hspPaymentId: order.payment_request_id,
      resultHash: resultHashOf(result),
    });
    push('receipt', 'recordReceipt() with the HSP payment_request_id', { tx: r.tx, contract: r.contract }, explorerTx(payNet, r.tx));
  } else {
    push('receipt', `no AgentSettleReceipts on ${payNet.name}: delivered without an on-chain receipt`);
  }
  return { ok: true, steps, report };
}


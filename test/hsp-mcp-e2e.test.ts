import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, parseSignature, toHex, type Address, type Hex, type LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { payViaHspMcp, type HumanConfirm } from '../src/agents/hsp-mcp-flow.js';
import { ERC20_EIP3009_ABI, publicClientFor, walletClientFor } from '../src/chain.js';
import { ensureLocalChain, type LocalChain } from '../src/local-chain.js';
import { connectHspMcp } from '../src/rails/hsp-mcp.js';
import { listReceipts } from '../src/receipts.js';
import { MemoryLedger, SpendGuard } from '../src/spend-guard.js';
import { fakeHspMcp, type FakeHspMcpOptions, type FakePrep } from './fake-hsp-mcp.js';
import { ensureForgeArtifacts, hasBinary, listen, startAnvil } from './helpers.js';

/**
 * HSP Agentic Payment end to end on anvil: the real flow and SDK client against a fake MCP server whose gateway checks
 * the payer's EIP-712 signature itself and broadcasts transferWithAuthorization on the EIP-3009 mock. The person at
 * the terminal is scripted; every prompt is recorded.
 */

const canRun = hasBinary('anvil') && hasBinary('forge');

describe.skipIf(!canRun)('HSP Agentic Payment (MCP) on anvil', () => {
  let stopAnvil = () => {};
  let chain: LocalChain;
  let chainConfig: any;

  beforeAll(async () => {
    ensureForgeArtifacts();
    const anvil = await startAnvil(24545 + Math.floor(Math.random() * 1000));
    stopAnvil = anvil.stop;
    chain = await ensureLocalChain({ rpcUrl: anvil.url, statePath: join(mkdtempSync(join(tmpdir(), 'agentsettle-mcp-')), 'c.json') });
    chainConfig = {
      networks: [{ chain_id: chain.net.chainId, name: 'local', display_name: 'Local (anvil)', is_testnet: true }],
      tokens: [{ chain_id: chain.net.chainId, symbol: 'USDC', name: 'USD Coin', address: chain.net.usdc.address, decimals: 6, version: '2', payment_protocol: 'eip3009', is_stablecoin: true, permit2_spender: '0x85Afd346143690AFbEc392524A8bae1e9ea8f500' }],
    };
  });
  afterAll(() => stopAnvil());

  const operator = () => privateKeyToAccount(chain.keys.operator);
  const buyer = () => privateKeyToAccount(chain.keys.buyer);
  const balance = (a: Address) => publicClientFor(chain.net).readContract({ address: chain.net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'balanceOf', args: [a] });
  /** The gateway broadcasts the signed authorization (its own gas). */
  const broadcast = async (p: FakePrep): Promise<Hex> => {
    const m = p.eip712.message;
    const { v, r, s } = parseSignature(p.signature!);
    const hash = await walletClientFor(chain.net, privateKeyToAccount(chain.keys.facilitator)).writeContract({
      address: chain.net.usdc.address,
      abi: ERC20_EIP3009_ABI,
      functionName: 'transferWithAuthorization',
      args: [m.from, m.to, BigInt(m.value), BigInt(m.validAfter), BigInt(m.validBefore), m.nonce, Number(v), r, s],
    });
    await publicClientFor(chain.net).waitForTransactionReceipt({ hash });
    return hash;
  };
  const scripted = (answers: Array<string | boolean>) => {
    const prompts: string[] = [];
    const next = (q: string) => {
      prompts.push(q);
      if (!answers.length) throw new Error(`unexpected prompt: ${q}`);
      return answers.shift()!;
    };
    const human: HumanConfirm = { ask: async (q) => String(next(q)), approve: async (q) => next(q) === true };
    return { human, prompts };
  };
  const yes = () => ['AgentSettle', operator().address, true, true, true] as Array<string | boolean>;

  async function run(answers: Array<string | boolean>, fake: Partial<FakeHspMcpOptions> = {}, flow: { payer?: LocalAccount; operator?: LocalAccount; guard?: SpendGuard; amount?: bigint } = {}) {
    const f = fakeHspMcp({ chainConfig, networkName: 'local', broadcast, ...fake });
    const srv = await listen(f.app);
    const session = await connectHspMcp(`${srv.url}/`);
    const { human, prompts } = scripted(answers);
    const guard = flow.guard ?? new SpendGuard(undefined, new MemoryLedger());
    try {
      const r = await payViaHspMcp({
        payNet: chain.net,
        operator: flow.operator ?? operator(),
        payer: flow.payer ?? buyer(),
        guard,
        call: session.call,
        human,
        text: 'hello',
        amount: flow.amount,
        pollMs: 20,
        pendingAfterMs: 300,
      });
      return { r, f, prompts, guard, last: r.steps.at(-1)!.title };
    } finally {
      await session.close();
      await srv.close();
    }
  }

  it('pays end to end: confirmations in the guide order, our signature, the gateway broadcast, on-chain check, receipt', async () => {
    const before = await balance(buyer().address);
    const { r, f, prompts, guard } = await run(yes());
    expect(r.ok, JSON.stringify(r.steps, null, 1)).toBe(true);
    expect(guard.spentToday()).toBe(100_000n);
    expect(f.rejected).toEqual([]);
    expect(f.calls).toEqual(['get_chain_config', 'create_order', 'get_order', 'prepare_payment', 'finalize_payment', 'submit_payment', 'query_payment']);
    expect(prompts.map((p) => p.split(' ')[0])).toEqual(['merchant_name', 'pay_to', 'payer:', 'Sign?', 'Submit?']);
    expect(prompts[3]).toContain('token_total_raw 100000 raw units');
    expect(r.steps.map((s) => s.step)).toContain('delivered');
    expect(await balance(buyer().address)).toBe(before - 100_000n);
    const prId = [...f.orders.values()][0].paymentRequestId as string;
    const receipt = (await listReceipts(chain.net)).find((x) => x.hspPaymentId === keccak256(toHex(prId)));
    expect(receipt).toMatchObject({ payer: buyer().address, amount: 100_000n });
    expect(r.report).toContain('Payment status: payment-safe');
    expect(r.report).toContain('Team attribution verified: true');
    expect(r.report).toContain('Raw authorization amount (raw units): 100000');
  });

  it('when the payer carries the gas fee: up to price + 10% is paid, more is refused before signing', async () => {
    const ok = await run(yes(), { gasFeeAdvanced: false, gasRaw: 5_000n });
    expect(ok.r.ok, ok.last).toBe(true);
    const over = await run(['AgentSettle', operator().address, true], { gasFeeAdvanced: false, gasRaw: 10_001n });
    expect(over.r.ok).toBe(false);
    expect(over.last).toMatch(/REFUSED to sign .* over the cap of 110000/);
    expect(over.f.calls).not.toContain('finalize_payment');
  });

  it('a server that rewrites the recipient in eip712 gets no signature and no money moves', async () => {
    const thief = privateKeyToAccount(generatePrivateKey()).address;
    const before = await balance(buyer().address);
    const { r, f, last } = await run(['AgentSettle', operator().address, true], { tamper: (p) => ((p.eip712.message.to = thief), (p.payment_payload.payload.authorization.to = thief)) });
    expect(r.ok).toBe(false);
    expect(last).toMatch(/REFUSED to sign the HSP authorization: message.to/);
    expect(f.calls).not.toContain('finalize_payment');
    expect(await balance(buyer().address)).toBe(before);
  });

  it('every "no" stops where it is asked: payer (no order), signature (nothing signed or booked), submission (nothing sent)', async () => {
    const payerNo = await run(['AgentSettle', operator().address, false]);
    expect(payerNo.f.calls).toEqual(['get_chain_config']);
    const signNo = await run(['AgentSettle', operator().address, true, false]);
    expect(signNo.f.calls).not.toContain('finalize_payment');
    expect(signNo.guard.spentToday()).toBe(0n);
    expect(signNo.last).toMatch(/nothing was signed/);
    const before = await balance(buyer().address);
    const submitNo = await run(['AgentSettle', operator().address, true, true, false]);
    expect(submitNo.f.calls).toContain('finalize_payment');
    expect(submitNo.f.calls).not.toContain('submit_payment');
    expect(submitNo.last).toMatch(/was not sent/);
    expect(await balance(buyer().address)).toBe(before);
  });

  it('no merchant_name, a pay_to that is not Agent B, or a payer equal to pay_to: no order', async () => {
    expect((await run([''])).f.calls).toEqual(['get_chain_config']);
    const other = await run(['AgentSettle', privateKeyToAccount(generatePrivateKey()).address]);
    expect(other.last).toMatch(/is not Agent B/);
    expect((await run(['AgentSettle', 'not-an-address'])).last).toMatch(/is not an address/);
    const self = await run(['AgentSettle', buyer().address], {}, { operator: buyer() });
    expect(self.last).toMatch(/payer cannot be pay_to/);
    expect(self.f.calls).toEqual(['get_chain_config']);
  });

  it('an order answer that is not ours (payment_request_id, or a pay_to other than the confirmed one) is not paid', async () => {
    const otherId = await run(['AgentSettle', operator().address, true], { rewrite: (tool, out) => tool === 'create_order' && (out.payment_request_id = 'AS-PR-someone-else') });
    expect(otherId.last).toMatch(/not ours: not paying/);
    expect(otherId.f.calls).not.toContain('prepare_payment');
    const thief = privateKeyToAccount(generatePrivateKey()).address;
    const otherPayTo = await run(['AgentSettle', operator().address, true], { rewrite: (tool, out) => tool === 'get_order' && (out.method_data[0].pay_to = thief) });
    expect(otherPayTo.last).toMatch(/get_order has no USDC method paying/);
    expect(otherPayTo.f.calls).not.toContain('prepare_payment');
  });

  it('a quote that expired while the person decided is not submitted', async () => {
    const { r, f, last } = await run(['AgentSettle', operator().address, true, true], { tamper: (p) => (p.quote_expires_at = new Date(Date.now() - 1000).toISOString()) });
    expect(r.ok).toBe(false);
    expect(last).toMatch(/the quote expired .*: not submitting/);
    expect(f.calls).not.toContain('submit_payment');
  });

  it('a payer without enough of the token is not asked to sign', async () => {
    const empty = privateKeyToAccount(generatePrivateKey());
    const { r, f, last, prompts } = await run(['AgentSettle', operator().address, true], {}, { payer: empty });
    expect(r.ok).toBe(false);
    expect(last).toMatch(/less than token_total_raw 100000: fund it by hand/);
    expect(prompts.some((p) => p.startsWith('Sign?'))).toBe(false);
    expect(f.calls).not.toContain('finalize_payment');
  });

  it('the gateway says payment-safe for a tx that is not our authorization: not delivered', async () => {
    const hash = await walletClientFor(chain.net, buyer()).writeContract({ address: chain.net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'transfer', args: [operator().address, 100_000n] });
    await publicClientFor(chain.net).waitForTransactionReceipt({ hash });
    const { r, last } = await run(yes(), { query: (_p, base) => ({ ...base, payment: { ...base.payment, tx_signature: hash } }) });
    expect(r.ok).toBe(false);
    expect(last).toMatch(/does not consume our authorization/);
    const wrongPayer = await run(yes(), { query: (_p, base) => ({ ...base, payment: { ...base.payment, payer_address: operator().address } }) });
    expect(wrongPayer.last).toMatch(/payer_address is .*: not delivering/);
  });

  it('payment-failed is reported with its reason; a payment that never settles is "Pending confirmation" with both ids', async () => {
    const failed = await run(yes(), { query: (_p, base) => ({ ...base, status: 'payment-failed', payment: { ...base.payment, status: 'payment-failed', status_reason: 'insufficient balance', tx_signature: '' } }) });
    expect(failed.r.ok).toBe(false);
    expect(failed.r.steps.some((s) => /payment-failed: insufficient balance/.test(s.title))).toBe(true);
    expect(failed.r.report).toContain('Payment status: payment-failed');
    const pending = await run(yes(), { query: (_p, base) => ({ ...base, status: 'payment-processing' }) });
    expect(pending.r.ok).toBe(false);
    expect(pending.r.pending?.flowId).toMatch(/^flow-/);
    expect(pending.r.pending?.paymentRequestId).toMatch(/^AS-PR-/);
    expect(pending.last).toMatch(/Pending confirmation \(last status: payment-processing\)/);
  });

  it('payment-failed is not delivered even when its tx_signature is a real transfer', async () => {
    const { r, last } = await run(yes(), { query: (_p, base) => ({ ...base, status: 'payment-failed', payment: { ...base.payment, status: 'payment-failed', status_reason: 'reconciliation' } }) });
    expect(r.ok).toBe(false);
    expect(last).toMatch(/HSP payment-failed: not delivering/);
  });

  it('attribution_verified=false is reported as it is', async () => {
    const { r } = await run(yes(), { query: (_p, base) => ({ ...base, attribution_verified: false }) });
    expect(r.ok).toBe(true);
    expect(r.report).toContain('Team attribution verified: false');
  });

  it('the spend is booked at signing for the real token_total_raw: more than what is left today is refused unsigned', async () => {
    const guard = new SpendGuard({ perTxCap: 500_000n, dailyCap: 150_000n }, new MemoryLedger());
    guard.authorize(50_000n, 'earlier');
    const { r, f } = await run(['AgentSettle', operator().address, true, true], { gasFeeAdvanced: false, gasRaw: 5_000n }, { guard });
    expect(r.steps.at(-1)!.step).toBe('spend_denied');
    expect(f.calls).not.toContain('finalize_payment');
    expect(guard.spentToday()).toBe(50_000n);
  });

  it('the daily cap applies before the server is even asked', async () => {
    const guard = new SpendGuard({ perTxCap: 500_000n, dailyCap: 150_000n }, new MemoryLedger());
    guard.authorize(100_000n, 'earlier');
    const { r, f } = await run([], {}, { guard });
    expect(r.steps.map((s) => s.step)).toEqual(['spend_denied']);
    expect(f.calls).toEqual([]);
  });
});

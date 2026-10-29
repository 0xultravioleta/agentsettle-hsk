import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { hire } from '../src/agents/buyer.js';
import { createSeller, facilitatorClient } from '../src/agents/seller.js';
import { ERC20_EIP3009_ABI, RECEIPTS_ABI, publicClientFor } from '../src/chain.js';
import { createLocalFacilitator } from '../src/facilitator/local.js';
import { ensureLocalChain, type LocalChain } from '../src/local-chain.js';
import { encodeHeader, selectRequirement, signExactPayment } from '../src/rails/x402.js';
import { listReceipts, resultHashOf } from '../src/receipts.js';
import { MemoryLedger, SpendGuard } from '../src/spend-guard.js';
import { ensureForgeArtifacts, hasBinary, listen, startAnvil } from './helpers.js';

/**
 * Whole x402 flow on anvil, over real HTTP: buyer -> seller (402) -> buyer signs EIP-3009 -> seller ->
 * uvd-x402-sdk FacilitatorClient -> local facilitator -> transferWithAuthorization on-chain ->
 * recordReceipt on AgentSettleReceipts. Skipped when anvil/forge are not installed.
 */
const canRun = hasBinary('anvil') && hasBinary('forge');

describe.skipIf(!canRun)('e2e on anvil', () => {
  let stopAnvil = () => {};
  const closers: Array<() => Promise<void>> = [];
  let chain: LocalChain;
  let sellerUrl: string;

  beforeAll(async () => {
    ensureForgeArtifacts();
    const anvil = await startAnvil(18545 + Math.floor(Math.random() * 1000));
    stopAnvil = anvil.stop;
    chain = await ensureLocalChain({ rpcUrl: anvil.url, statePath: join(mkdtempSync(join(tmpdir(), 'agentsettle-e2e-')), 'local-chain.json') });
    const fac = createLocalFacilitator({ net: chain.net, signer: privateKeyToAccount(chain.keys.facilitator) });
    const facSrv = await listen(fac.app);
    closers.push(facSrv.close);
    // the seller needs its own URL before it exists: listen on a port, then mount
    const { Hono } = await import('hono');
    const shell = new Hono();
    const sellerSrv = await listen(shell);
    closers.push(sellerSrv.close);
    sellerUrl = sellerSrv.url;
    shell.route('/', createSeller({ net: chain.net, operator: privateKeyToAccount(chain.keys.operator), facilitator: facilitatorClient(facSrv.url), publicUrl: sellerUrl }));
  });

  afterAll(async () => {
    for (const c of closers) await c();
    stopAnvil();
  });

  const balance = (addr: `0x${string}`) =>
    publicClientFor(chain.net).readContract({ address: chain.net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'balanceOf', args: [addr] });

  it('pays 0.10 USDC, delivers, and writes one receipt that matches the payment', async () => {
    const buyer = privateKeyToAccount(chain.keys.buyer);
    const operator = privateKeyToAccount(chain.keys.operator);
    const guard = new SpendGuard(undefined, new MemoryLedger());
    const before = { buyer: await balance(buyer.address), seller: await balance(operator.address) };

    const r = await hire({ net: chain.net, account: buyer, guard }, `${sellerUrl}/task/translate?text=${encodeURIComponent('Hello world')}`);
    expect(r.ok, JSON.stringify(r.steps, null, 1)).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(['request', 'payment_required', 'spend_check', 'signed', 'paid_request', 'settled', 'delivered', 'receipt']);
    expect(r.response!.result).toBe('Hola mundo');
    expect(await balance(buyer.address)).toBe(before.buyer - 100_000n);
    expect(await balance(operator.address)).toBe(before.seller + 100_000n);
    expect(guard.spentToday()).toBe(100_000n);

    const pub = publicClientFor(chain.net);
    const settleReceipt = await pub.getTransactionReceipt({ hash: r.response!.payment.settleTx });
    expect(settleReceipt.status).toBe('success');
    // the buyer never paid gas on x402: the facilitator's wallet sent the settle
    expect(settleReceipt.from.toLowerCase()).toBe(privateKeyToAccount(chain.keys.facilitator).address.toLowerCase());

    const stored = await pub.readContract({ address: chain.net.receiptsAddress!, abi: RECEIPTS_ABI, functionName: 'receipts', args: [r.response!.taskId] });
    expect(stored[0]).toBe(buyer.address);
    expect(stored[1]).toBe(operator.address);
    expect(stored[2]).toBe(chain.net.usdc.address);
    expect(stored[3]).toBe(100_000n);
    expect(stored[4]).toBe(r.response!.payment.settleTx);
    expect(stored[5]).toBe(`0x${'0'.repeat(64)}`);
    expect(stored[6]).toBe(resultHashOf('Hola mundo'));

    const rows = await listReceipts(chain.net);
    expect(rows[0]!.taskId).toBe(r.response!.taskId);
  });

  it('denies the 2 USDC premium task before signing; no money moves', async () => {
    const buyer = privateKeyToAccount(chain.keys.buyer);
    const guard = new SpendGuard(undefined, new MemoryLedger());
    const before = await balance(buyer.address);
    const r = await hire({ net: chain.net, account: buyer, guard }, `${sellerUrl}/task/translate?text=hello&tier=premium`);
    expect(r.ok).toBe(false);
    expect(r.denied?.code).toBe('PER_TX_CAP');
    expect(r.steps.map((s) => s.step)).toEqual(['request', 'payment_required', 'spend_denied']);
    expect(await balance(buyer.address)).toBe(before);
    expect(guard.spentToday()).toBe(0n);
  });

  it('denies once the daily cap is used up', async () => {
    const buyer = privateKeyToAccount(chain.keys.buyer);
    const ledger = new MemoryLedger();
    const guard = new SpendGuard(undefined, ledger);
    ledger.append(new Date().toISOString().slice(0, 10), { at: new Date().toISOString(), amount: '4950000', ref: 'seed' });
    const r = await hire({ net: chain.net, account: buyer, guard }, `${sellerUrl}/task/translate?text=hello`);
    expect(r.denied?.code).toBe('DAILY_CAP');
  });

  it('a replayed X-PAYMENT is refused and writes no second receipt', async () => {
    const buyer = privateKeyToAccount(chain.keys.buyer);
    const url = `${sellerUrl}/task/translate?text=thanks`;
    const first = await fetch(url);
    const body = await first.json();
    const req = selectRequirement(body, chain.net);
    const header = encodeHeader(await signExactPayment(buyer, chain.net, req, body.resource));
    const ok = await fetch(url, { headers: { 'X-PAYMENT': header } });
    expect(ok.status).toBe(200);
    const before = (await listReceipts(chain.net)).length;
    const again = await fetch(url, { headers: { 'X-PAYMENT': header } });
    expect(again.status).toBe(402);
    expect((await again.json()).error).toMatch(/authorization_used|already|in_flight/);
    expect((await listReceipts(chain.net)).length).toBe(before);
  });

  it('refuses a payment signed for another price, payee or with a bad signature', async () => {
    const buyer = privateKeyToAccount(chain.keys.buyer);
    const url = `${sellerUrl}/task/translate?text=hello`;
    const body = await (await fetch(url)).json();
    const req = selectRequirement(body, chain.net);

    const cheap = await signExactPayment(buyer, chain.net, { ...req, amount: '1' }, body.resource);
    const r1 = await fetch(url, { headers: { 'X-PAYMENT': encodeHeader(cheap) } });
    expect(r1.status).toBe(402);
    expect((await r1.json()).error).toMatch(/value 1 != price 100000/);

    const forged = await signExactPayment(buyer, chain.net, req, body.resource);
    forged.payload.authorization.from = privateKeyToAccount(chain.keys.operator).address; // claims to be someone else
    const r2 = await fetch(url, { headers: { 'X-PAYMENT': encodeHeader(forged) } });
    expect(r2.status).toBe(402);
    expect((await r2.json()).error).toMatch(/signature/);

    const garbage = await fetch(url, { headers: { 'X-PAYMENT': 'not-base64-json' } });
    expect(garbage.status).toBe(402);

    const v2name = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': encodeHeader(await signExactPayment(buyer, chain.net, req, body.resource)) } });
    expect(v2name.status).toBe(200);
  });

  it('a buyer with no USDC is refused by the facilitator before any transfer', async () => {
    const { generatePrivateKey } = await import('viem/accounts');
    const broke = privateKeyToAccount(generatePrivateKey());
    const r = await hire({ net: chain.net, account: broke, guard: new SpendGuard() }, `${sellerUrl}/task/translate?text=hello`);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.steps)).toMatch(/insufficient_funds/);
  });
});

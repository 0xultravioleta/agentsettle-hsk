import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { consoleGuard } from '../src/app.js';
import { hire } from '../src/agents/buyer.js';
import { createSeller, facilitatorClient, type Facilitator } from '../src/agents/seller.js';
import { ERC20_EIP3009_ABI, publicClientFor, walletClientFor } from '../src/chain.js';
import { getNetwork } from '../src/config.js';
import { createLocalFacilitator } from '../src/facilitator/local.js';
import { ensureLocalChain, type LocalChain } from '../src/local-chain.js';
import { buildPaymentRequired, encodeHeader, selectRequirement, signExactPayment, type PaymentRequirement } from '../src/rails/x402.js';
import { listReceipts, readReceipt } from '../src/receipts.js';
import type { Runtime } from '../src/runtime.js';
import { FileLedger, MemoryLedger, SpendGuard } from '../src/spend-guard.js';
import { ensureForgeArtifacts, hasBinary, listen, startAnvil } from './helpers.js';

/** One test (or more) per finding of the adversarial review, round 1. */

describe('P2-1: a hostile 402 cannot burn the cap without a signature, and hire() never throws', () => {
  it('fractional and huge maxTimeoutSeconds: every booked spend has a signature behind it', async () => {
    const net = getNetwork('hashkey-testnet');
    for (const maxTimeoutSeconds of [0.5, 1e21, 2 ** 52, -3]) {
      const evil = new Hono();
      evil.get('/t', (c) =>
        c.json(
          {
            x402Version: 2,
            error: 'pay',
            resource: { url: 'http://x/t', description: '', mimeType: 'application/json' },
            accepts: [{ scheme: 'exact', network: net.caip2, asset: net.usdc.address, amount: '500000', payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds, extra: net.usdc.eip712 }],
          },
          402,
        ),
      );
      const srv = await listen(evil);
      const guard = new SpendGuard(undefined, new MemoryLedger());
      const r = await hire({ net, account: privateKeyToAccount(generatePrivateKey()), guard }, `${srv.url}/t`);
      await srv.close();
      const signed = r.steps.find((s) => s.step === 'signed');
      expect(signed, String(maxTimeoutSeconds)).toBeDefined();
      expect(guard.spentToday()).toBe(500_000n);
      const window = BigInt(String(signed!.detail!.validBefore)) - BigInt(Math.floor(Date.now() / 1000));
      expect(window <= 600n && window >= 25n, `window ${window}`).toBe(true);
    }
  });

  it('a seller that answers garbage gets an error step, not an exception', async () => {
    const evil = new Hono();
    evil.get('/t', (c) => c.body('not json', 402));
    const srv = await listen(evil);
    const r = await hire({ net: getNetwork('hashkey-testnet'), account: privateKeyToAccount(generatePrivateKey()), guard: new SpendGuard() }, `${srv.url}/t`);
    await srv.close();
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)!.step).toBe('error');
  });
});

describe('P3-3: the buyer only pays the agent it hired', () => {
  it('refuses a 402 that names another payee', () => {
    const net = getNetwork('hashkey-testnet');
    const b = privateKeyToAccount(generatePrivateKey()).address;
    const body = buildPaymentRequired(net, { payTo: privateKeyToAccount(generatePrivateKey()).address, amount: 1n, resource: { url: 'u', description: '', mimeType: '' } });
    expect(() => selectRequirement(body, net, { expectedPayTo: b })).toThrow(/not the agent we hired/);
    body.accepts[0]!.payTo = getAddress(b.toLowerCase());
    expect(selectRequirement(body, net, { expectedPayTo: b }).payTo).toBe(b);
  });
});

describe('P2-2: the console API and the local facilitator refuse cross-site requests', () => {
  const app = new Hono();
  app.use('/api/*', consoleGuard('http://127.0.0.1:8402'));
  app.post('/api/hire', (c) => c.json({ ran: true }));
  app.get('/api/config', (c) => c.json({ ok: true }));
  const post = (headers: Record<string, string>, body = '{"text":"x"}') => app.request('http://127.0.0.1:8402/api/hire', { method: 'POST', headers, body });

  it('a cross-site text/plain "simple request" is refused', async () => {
    expect((await post({ 'content-type': 'text/plain', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', host: '127.0.0.1:8402' })).status).toBe(403);
    expect((await post({ 'content-type': 'text/plain', host: '127.0.0.1:8402' })).status).toBe(415);
  });
  it('a foreign Origin, a cross-site fetch or a rebinding Host is refused even with JSON', async () => {
    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:8402' })).status).toBe(403);
    expect((await post({ 'content-type': 'application/json', 'sec-fetch-site': 'same-site', host: '127.0.0.1:8402' })).status).toBe(403);
    expect((await post({ 'content-type': 'application/json', origin: 'http://evil.example:8402', 'sec-fetch-site': 'same-origin', host: 'evil.example:8402' })).status).toBe(403);
  });
  it('DNS rebinding: a same-origin GET carries no Origin, so the Host check is what stops it', async () => {
    const get = (host: string) => app.request('http://127.0.0.1:8402/api/config', { headers: { host, 'sec-fetch-site': 'same-origin' } });
    expect((await get('evil.example:8402')).status).toBe(403);
    expect((await get('127.0.0.1:8402')).status).toBe(200);
  });

  it('the console itself (and the Vite dev server) gets through', async () => {
    expect((await post({ 'content-type': 'application/json', origin: 'http://127.0.0.1:8402', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:8402' })).status).toBe(200);
    expect((await post({ 'content-type': 'application/json; charset=utf-8', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin', host: 'localhost:5173' })).status).toBe(200);
    expect((await post({ 'content-type': 'application/json', host: '127.0.0.1:8402' })).status).toBe(200);
  });
});

const canRun = hasBinary('anvil') && hasBinary('forge');

describe.skipIf(!canRun)('on anvil', () => {
  let stopAnvil = () => {};
  let chain: LocalChain;
  let facUrl: string;
  let closeFac = async () => {};
  const resource = (text: string) => ({ url: `http://seller.test/task/translate?text=${encodeURIComponent(text)}`, description: 'EN->ES translation by Agent B', mimeType: 'application/json' });

  beforeAll(async () => {
    ensureForgeArtifacts();
    const anvil = await startAnvil(20545 + Math.floor(Math.random() * 1000));
    stopAnvil = anvil.stop;
    chain = await ensureLocalChain({ rpcUrl: anvil.url, statePath: join(mkdtempSync(join(tmpdir(), 'agentsettle-h-')), 'c.json') });
    const fac = createLocalFacilitator({ net: chain.net, signer: privateKeyToAccount(chain.keys.facilitator), allowedPayTo: [privateKeyToAccount(chain.keys.operator).address] });
    const srv = await listen(fac.app);
    facUrl = srv.url;
    closeFac = srv.close;
  });
  afterAll(async () => {
    await closeFac();
    stopAnvil();
  });

  const operator = () => privateKeyToAccount(chain.keys.operator);
  const buyer = () => privateKeyToAccount(chain.keys.buyer);
  const balance = (a: `0x${string}`) => publicClientFor(chain.net).readContract({ address: chain.net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'balanceOf', args: [a] });
  const pay = async (text: string) => {
    const req = buildPaymentRequired(chain.net, { payTo: operator().address, amount: 100_000n, resource: resource(text) }).accepts[0]!;
    return encodeHeader(await signExactPayment(buyer(), chain.net, req, resource(text)));
  };
  const sellerWith = (f: Facilitator) => createSeller({ net: chain.net, operator: operator(), facilitator: f, publicUrl: 'http://seller.test', confirmTimeoutMs: 5_000 });

  it('P2-2: the local facilitator refuses browsers, non-JSON bodies and payees other than our seller', async () => {
    expect((await fetch(`${facUrl}/settle`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${facUrl}/settle`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const req: PaymentRequirement = { ...buildPaymentRequired(chain.net, { payTo: stranger, amount: 100_000n, resource: resource('x') }).accepts[0]! };
    const p = await signExactPayment(buyer(), chain.net, req, resource('x'));
    const r = await fetch(`${facUrl}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, resource: resource('x'), accepted: req, payload: p.payload }, resource: resource('x'), accepted: req }) });
    expect((await r.json()).invalidReason).toBe('payee_not_allowed_on_this_facilitator');
  });

  it('P3-1: a high-s copy of a valid signature is refused before any broadcast', async () => {
    const fac = createLocalFacilitator({ net: chain.net, signer: privateKeyToAccount(chain.keys.facilitator) });
    const req = buildPaymentRequired(chain.net, { payTo: operator().address, amount: 100_000n, resource: resource('x') }).accepts[0]!;
    const p = await signExactPayment(buyer(), chain.net, req, resource('x'));
    const sig = p.payload.signature;
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (n - BigInt(`0x${sig.slice(66, 130)}`)).toString(16).padStart(64, '0');
    const v = sig.slice(130) === '1b' ? '1c' : '1b';
    const flipped = `${sig.slice(0, 66)}${highS}${v}` as Hex;
    const body = (s: Hex) => ({ x402Version: 2, paymentPayload: { x402Version: 2, resource: resource('x'), accepted: req, payload: { ...p.payload, signature: s } }, resource: resource('x'), accepted: req });
    expect((await fac.verify(body(sig))).isValid).toBe(true);
    expect((await fac.verify(body(flipped))).invalidReason).toBe('invalid_exact_evm_payload_signature_high_s');
  });

  it('P2-3: a settle response lost after broadcasting is reconciled by the retry: one charge, one receipt, delivered', async () => {
    const real = facilitatorClient(facUrl);
    let lose = true;
    const flaky: Facilitator = {
      verify: (p, r, o) => real.verify(p, r, o),
      settle: async (p, r, o) => {
        const res = await real.settle(p, r, o);
        if (lose) {
          lose = false;
          return { success: false, error: 'timeout' } as any; // the tx went out; the answer did not come back
        }
        return res;
      },
    };
    const app = sellerWith(flaky);
    const header = await pay('thank you');
    const before = await balance(buyer().address);
    const receiptsBefore = (await listReceipts(chain.net)).length;
    const url = `/task/translate?text=${encodeURIComponent('thank you')}`;

    const first = await app.request(url, { headers: { 'X-PAYMENT': header } });
    expect(first.status).toBe(502);
    expect(await balance(buyer().address)).toBe(before - 100_000n); // it was charged

    const retry = await app.request(url, { headers: { 'X-PAYMENT': header } });
    expect(retry.status).toBe(200);
    const body = await retry.json();
    expect(body.replayed).toBe(true);
    expect(body.result).toBe('gracias tú');
    expect(body.receipt.tx).toMatch(/^0x/);
    expect(await readReceipt(chain.net, body.taskId)).toBeDefined();

    const third = await app.request(url, { headers: { 'X-PAYMENT': header } });
    expect((await third.json()).receipt.existing).toBe(true);
    expect(await balance(buyer().address)).toBe(before - 100_000n); // still one charge
    expect((await listReceipts(chain.net)).length).toBe(receiptsBefore + 1); // one receipt
  });

  it('a facilitator "no" is not overridden on the first pass even if the tx landed; the retry reconciles from the chain', async () => {
    const real = facilitatorClient(facUrl);
    let first = true;
    const saysNo: Facilitator = {
      verify: (p, r, o) => real.verify(p, r, o),
      settle: async (p, r, o) => {
        const res = await real.settle(p, r, o);
        if (!first) return res;
        first = false;
        return { ...res, success: false, errorReason: 'transaction_reverted' } as any;
      },
    };
    const app = sellerWith(saysNo);
    const header = await pay('good');
    expect((await app.request('/task/translate?text=good', { headers: { 'X-PAYMENT': header } })).status).toBe(502);
    const retry = await app.request('/task/translate?text=good', { headers: { 'X-PAYMENT': header } });
    expect(retry.status).toBe(200);
    expect((await retry.json()).replayed).toBe(true);
  });

  it('P2-3: a facilitator that answers with an older tx of the same payer and amount is not believed', async () => {
    const real = facilitatorClient(facUrl);
    const paid = await sellerWith(real).request('/task/translate?text=hello', { headers: { 'X-PAYMENT': await pay('hello') } });
    const oldTx = (await paid.json()).payment.settleTx as Hex;
    const liar: Facilitator = { verify: (p, r, o) => real.verify(p, r, o), settle: async () => ({ success: true, transactionHash: oldTx }) as any };
    const before = await balance(operator().address);
    const res = await sellerWith(liar).request('/task/translate?text=hello', { headers: { 'X-PAYMENT': await pay('hello') } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/not confirmed on-chain/);
    expect(await balance(operator().address)).toBe(before);
  });

  // P2-4 (HSP delivers only on the exact on-chain transfer) moved to test/hsp-merchant-e2e.test.ts with the HashKey Merchant rail.
});

describe('P3-5: the file ledger locks check + book across processes', () => {
  it('waits for a held lock, then gives up; a stale lock is taken over', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentsettle-lock-')), 'spend.json');
    const ledger = new FileLedger(path);
    writeFileSync(`${path}.lock`, '');
    const t0 = Date.now();
    expect(() => ledger.atomically(() => 1, { waitMs: 150 })).toThrow(/locked by another process/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    expect(ledger.atomically(() => 2)).toBe(2);
    const guard = new SpendGuard(undefined, ledger);
    guard.authorize(100_000n, 'a');
    expect(new SpendGuard(undefined, new FileLedger(path)).spentToday()).toBe(100_000n);
  });
});

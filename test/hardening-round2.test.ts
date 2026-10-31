import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient, http, keccak256, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../src/app.js';
import { hire } from '../src/agents/buyer.js';
import { hireViaHsp } from '../src/agents/hsp-flow.js';
import { TaskBinding, createSeller, facilitatorClient, type Facilitator } from '../src/agents/seller.js';
import { ERC20_EIP3009_ABI, publicClientFor, walletClientFor } from '../src/chain.js';
import { getNetwork } from '../src/config.js';
import { createLocalFacilitator } from '../src/facilitator/local.js';
import { ensureLocalChain, type LocalChain } from '../src/local-chain.js';
import { StubHspRail } from '../src/rails/hsp.js';
import { buildPaymentRequired, encodeHeader, signExactPayment } from '../src/rails/x402.js';
import { listReceipts, readReceipt, resultHashOf } from '../src/receipts.js';
import type { Runtime } from '../src/runtime.js';
import { FileLedger, MemoryLedger, SpendGuard } from '../src/spend-guard.js';
import { ensureForgeArtifacts, hasBinary, listen, startAnvil } from './helpers.js';

/** One test (or more) per finding of the adversarial review, round 2. */

describe('P2-B: the console cannot be driven by another page', () => {
  it('no autorun in the UI, and every response forbids framing', async () => {
    expect(readFileSync('web/src/main.ts', 'utf8')).not.toMatch(/autorun/);
    const rt: Runtime = {
      net: getNetwork('local'),
      operator: privateKeyToAccount(generatePrivateKey()),
      buyer: privateKeyToAccount(generatePrivateKey()),
      guard: new SpendGuard(),
      hsp: new StubHspRail('test'),
      facilitatorUrl: 'http://127.0.0.1:9',
      facilitatorLabel: 'x',
      close: () => {},
    };
    const app = createApp(rt, 'http://127.0.0.1:8402');
    for (const path of ['/', '/api/config', '/health']) {
      const r = await app.request(`http://127.0.0.1:8402${path}`, { headers: { host: '127.0.0.1:8402' } });
      expect(r.headers.get('x-frame-options'), path).toBe('DENY');
      expect(r.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
    }
  });
});

describe('P3-1: retries and doubt', () => {
  it('the buyer retries the SAME X-PAYMENT after a 502 and books the spend once', async () => {
    const net = getNetwork('hashkey-testnet');
    const seller = privateKeyToAccount(generatePrivateKey());
    const seen: string[] = [];
    const app = new Hono();
    app.get('/t', (c) => {
      const h = c.req.header('x-payment');
      if (!h) return c.json(buildPaymentRequired(net, { payTo: seller.address, amount: 100_000n, resource: { url: 'http://x/t', description: '', mimeType: 'application/json' } }), 402);
      seen.push(h);
      if (seen.length === 1) return c.json({ error: 'settlement failed' }, 502);
      return c.json({ taskId: '0x', result: 'ok', resultHash: '0x', replayed: true, payment: { settleTx: `0x${'1'.repeat(64)}`, payer: seller.address }, receipt: null });
    });
    const srv = await listen(app);
    const guard = new SpendGuard(undefined, new MemoryLedger());
    const r = await hire({ net, account: privateKeyToAccount(generatePrivateKey()), guard, retryUnitMs: 1 }, `${srv.url}/t`);
    await srv.close();
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(guard.spentToday()).toBe(100_000n);
    expect(r.steps.filter((s) => s.step === 'signed')).toHaveLength(1);
  });

  it('when the chain cannot be asked whether a payment was used, the seller answers 503, never a fresh 402', async () => {
    const net = getNetwork('hashkey-testnet', { rpcUrl: 'http://127.0.0.1:9', receiptsAddress: undefined });
    const operator = privateKeyToAccount(generatePrivateKey());
    const f: Facilitator = { verify: async () => ({ isValid: false, invalidReason: 'unexpected_verify_error' }) as any, settle: async () => ({ success: false }) as any };
    const app = createSeller({ net, operator, facilitator: f, publicUrl: 'http://seller.test' });
    const resource = { url: 'http://seller.test/task/translate?text=hello', description: 'EN->ES translation by Agent B', mimeType: 'application/json' };
    const req = buildPaymentRequired(net, { payTo: operator.address, amount: 100_000n, resource }).accepts[0]!;
    const header = encodeHeader(await signExactPayment(privateKeyToAccount(generatePrivateKey()), net, req, resource));
    const r = await app.request('/task/translate?text=hello', { headers: { 'X-PAYMENT': header } });
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('5');
  });

  it('the nonce -> task binding survives a restart and the first writer wins', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentsettle-bind-')), 'b.json');
    const n = `0x${'ab'.repeat(32)}`;
    expect(new TaskBinding(path).claim(n, 'hello')).toBe(true);
    const again = new TaskBinding(path);
    expect(again.get(n.toUpperCase().replace('0X', '0x'))).toBe('hello');
    expect(again.claim(n, 'other')).toBe(false);
    expect(again.claim(n, 'hello')).toBe(true);
  });
});

describe('P3-4: deploy.sh never puts the key in argv', () => {
  it('no --private-key anywhere in the script', () => {
    expect(readFileSync('scripts/deploy.sh', 'utf8')).not.toMatch(/--private-key/);
  });
});

describe('P3-5: the ledger lock knows its owner', () => {
  it('a lock held by a live pid is respected; one held by a dead pid is taken over at once', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentsettle-lock2-')), 'spend.json');
    const ledger = new FileLedger(path);
    writeFileSync(`${path}.lock`, String(process.pid));
    expect(() => ledger.atomically(() => 1, { waitMs: 100 })).toThrow(/locked/);
    writeFileSync(`${path}.lock`, '999999999'); // no such process
    const t0 = Date.now();
    expect(ledger.atomically(() => 2, { waitMs: 100 })).toBe(2);
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

const canRun = hasBinary('anvil') && hasBinary('forge');

describe.skipIf(!canRun)('on anvil (1 s blocks, like a real chain)', () => {
  let stopAnvil = () => {};
  let chain: LocalChain;
  let facUrl: string;
  let closeFac = async () => {};
  const resource = (text: string) => ({ url: `http://seller.test/task/translate?text=${encodeURIComponent(text)}`, description: 'EN->ES translation by Agent B', mimeType: 'application/json' });

  beforeAll(async () => {
    ensureForgeArtifacts();
    const anvil = await startAnvil(21545 + Math.floor(Math.random() * 1000));
    stopAnvil = anvil.stop;
    chain = await ensureLocalChain({ rpcUrl: anvil.url, statePath: join(mkdtempSync(join(tmpdir(), 'agentsettle-r2-')), 'c.json') });
    const fac = createLocalFacilitator({ net: chain.net, signer: privateKeyToAccount(chain.keys.facilitator), allowedPayTo: [privateKeyToAccount(chain.keys.operator).address] });
    const srv = await listen(fac.app);
    facUrl = srv.url;
    closeFac = srv.close;
    const test = createTestClient({ mode: 'anvil', transport: http(chain.net.rpcUrl) });
    await test.setAutomine(false);
    await test.setIntervalMining({ interval: 1 });
  });
  afterAll(async () => {
    await closeFac();
    stopAnvil();
  });

  const operator = () => privateKeyToAccount(chain.keys.operator);
  const buyer = () => privateKeyToAccount(chain.keys.buyer);
  const balance = (a: `0x${string}`) => publicClientFor(chain.net).readContract({ address: chain.net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'balanceOf', args: [a] });

  it('P2-A: one payment sent to two tasks at once buys exactly one, and the receipt hashes that one', async () => {
    const app = createSeller({ net: chain.net, operator: operator(), facilitator: facilitatorClient(facUrl), publicUrl: 'http://seller.test', confirmTimeoutMs: 20_000 });
    const req = buildPaymentRequired(chain.net, { payTo: operator().address, amount: 100_000n, resource: resource('hello world') }).accepts[0]!;
    const header = encodeHeader(await signExactPayment(buyer(), chain.net, req, resource('hello world')));
    const before = await balance(buyer().address);
    const receiptsBefore = (await listReceipts(chain.net)).length;
    const a = app.request(`/task/translate?text=${encodeURIComponent('hello world')}`, { headers: { 'X-PAYMENT': header } });
    await new Promise((r) => setTimeout(r, 300));
    const b = app.request(`/task/translate?text=${encodeURIComponent('thank you')}`, { headers: { 'X-PAYMENT': header } });
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const won = await (ra.status === 200 ? ra : rb).json();
    expect(won.result).toBe('hola mundo');
    expect((await readReceipt(chain.net, won.taskId))!.resultHash).toBe(resultHashOf('hola mundo'));
    expect(await balance(buyer().address)).toBe(before - 100_000n);
    expect((await listReceipts(chain.net)).length).toBe(receiptsBefore + 1);
  }, 60_000);

  it('P2-A: the same task sent twice at once is delivered twice from one payment and one receipt', async () => {
    const app = createSeller({ net: chain.net, operator: operator(), facilitator: facilitatorClient(facUrl), publicUrl: 'http://seller.test', confirmTimeoutMs: 20_000 });
    const req = buildPaymentRequired(chain.net, { payTo: operator().address, amount: 100_000n, resource: resource('thanks') }).accepts[0]!;
    const header = encodeHeader(await signExactPayment(buyer(), chain.net, req, resource('thanks')));
    const before = await balance(buyer().address);
    const [r1, r2] = await Promise.all([0, 1].map(() => app.request('/task/translate?text=thanks', { headers: { 'X-PAYMENT': header } })));
    expect([r1!.status, r2!.status]).toEqual([200, 200]);
    const [b1, b2] = [await r1!.json(), await r2!.json()];
    expect(b1.taskId).toBe(b2.taskId);
    expect([b1.replayed, b2.replayed].sort()).toEqual([false, true]);
    expect(await balance(buyer().address)).toBe(before - 100_000n);
  }, 60_000);

  it('after a restart (empty memory), the receipt alone still refuses a paid authorization for another task', async () => {
    const mk = () => createSeller({ net: chain.net, operator: operator(), facilitator: facilitatorClient(facUrl), publicUrl: 'http://seller.test', confirmTimeoutMs: 20_000 });
    const req = buildPaymentRequired(chain.net, { payTo: operator().address, amount: 100_000n, resource: resource('hello') }).accepts[0]!;
    const header = encodeHeader(await signExactPayment(buyer(), chain.net, req, resource('hello')));
    expect((await mk().request('/task/translate?text=hello', { headers: { 'X-PAYMENT': header } })).status).toBe(200);
    const restarted = mk();
    expect((await restarted.request('/task/translate?text=thanks', { headers: { 'X-PAYMENT': header } })).status).toBe(409);
    expect((await restarted.request('/task/translate?text=hello', { headers: { 'X-PAYMENT': header } })).status).toBe(200);
  }, 60_000);

  it('a facilitator that gives a generic reason for a used authorization: the chain says used, so it is a retry, not a new 402', async () => {
    const real = facilitatorClient(facUrl);
    const vague: Facilitator = {
      verify: async (p, r, o) => {
        const v = await real.verify(p, r, o);
        return v.isValid ? v : ({ isValid: false, invalidReason: 'unexpected_verify_error' } as any);
      },
      settle: (p, r, o) => real.settle(p, r, o),
    };
    const app = createSeller({ net: chain.net, operator: operator(), facilitator: vague, publicUrl: 'http://seller.test', confirmTimeoutMs: 20_000 });
    const req = buildPaymentRequired(chain.net, { payTo: operator().address, amount: 100_000n, resource: resource('money') }).accepts[0]!;
    const header = encodeHeader(await signExactPayment(buyer(), chain.net, req, resource('money')));
    expect((await app.request('/task/translate?text=money', { headers: { 'X-PAYMENT': header } })).status).toBe(200);
    const again = await app.request('/task/translate?text=money', { headers: { 'X-PAYMENT': header } });
    expect(again.status).toBe(200);
    expect((await again.json()).replayed).toBe(true);
  }, 60_000);

  it('a payment bound to one task is never sent to settle for another', async () => {
    let settles = 0;
    const real = facilitatorClient(facUrl);
    const failsOnce: Facilitator = {
      verify: (p, r, o) => real.verify(p, r, o),
      settle: async () => {
        settles++;
        return { success: false, errorReason: 'rpc_down' } as any; // nothing was broadcast
      },
    };
    const app = createSeller({ net: chain.net, operator: operator(), facilitator: failsOnce, publicUrl: 'http://seller.test', confirmTimeoutMs: 5_000 });
    const req = buildPaymentRequired(chain.net, { payTo: operator().address, amount: 100_000n, resource: resource('fast') }).accepts[0]!;
    const header = encodeHeader(await signExactPayment(buyer(), chain.net, req, resource('fast')));
    expect((await app.request('/task/translate?text=fast', { headers: { 'X-PAYMENT': header } })).status).toBe(502);
    expect((await app.request('/task/translate?text=money', { headers: { 'X-PAYMENT': header } })).status).toBe(409);
    expect(settles).toBe(1);
  }, 30_000);

  // P3-2 (an HSP record pointing at an older transfer) moved to test/hsp-merchant-e2e.test.ts with the HashKey Merchant rail.
});

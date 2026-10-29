import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient, getAddress, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSeller, type Facilitator } from '../src/agents/seller.js';
import { publicClientFor } from '../src/chain.js';
import { createLocalFacilitator } from '../src/facilitator/local.js';
import { ensureLocalChain, type LocalChain } from '../src/local-chain.js';
import { buildPaymentRequired, encodeHeader, signExactPayment, type PaymentPayload, type PaymentRequirement } from '../src/rails/x402.js';
import { ensureForgeArtifacts, hasBinary, startAnvil } from './helpers.js';

/** Each guard of the local facilitator and of the seller, hit directly (the e2e flow only reaches some of them). */
const canRun = hasBinary('anvil') && hasBinary('forge');

describe.skipIf(!canRun)('guards on anvil', () => {
  let stopAnvil = () => {};
  let chain: LocalChain;
  let fac: ReturnType<typeof createLocalFacilitator>;
  const resource = { url: 'http://127.0.0.1/task/translate?text=x', description: 'd', mimeType: 'application/json' };

  beforeAll(async () => {
    ensureForgeArtifacts();
    const anvil = await startAnvil(19545 + Math.floor(Math.random() * 1000));
    stopAnvil = anvil.stop;
    chain = await ensureLocalChain({ rpcUrl: anvil.url, statePath: join(mkdtempSync(join(tmpdir(), 'agentsettle-g-')), 'c.json') });
    fac = createLocalFacilitator({ net: chain.net, signer: privateKeyToAccount(chain.keys.facilitator) });
  });
  afterAll(() => stopAnvil());

  const seller = () => privateKeyToAccount(chain.keys.operator);
  const buyer = () => privateKeyToAccount(chain.keys.buyer);
  const requirement = (): PaymentRequirement => buildPaymentRequired(chain.net, { payTo: seller().address, amount: 100_000n, resource }).accepts[0]!;
  const envelope = (p: PaymentPayload, accepted: PaymentRequirement) => ({ x402Version: 2, paymentPayload: { x402Version: 2, resource, accepted, payload: p.payload }, resource, accepted });
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('accepts a correct payment (control)', async () => {
    const req = requirement();
    const v = await fac.verify(envelope(await signExactPayment(buyer(), chain.net, req, resource), req));
    expect(v.isValid).toBe(true);
  });

  it('rejects an expired authorization (validBefore)', async () => {
    const req = requirement();
    const p = await signExactPayment(buyer(), chain.net, req, resource, { nowSeconds: nowSec() - 3600 });
    expect((await fac.verify(envelope(p, req))).invalidReason).toMatch(/valid_before/);
  });

  it('rejects an authorization that is not valid yet (validAfter)', async () => {
    const req = requirement();
    const p = await signExactPayment(buyer(), chain.net, req, resource, { nowSeconds: nowSec() + 3600 });
    expect((await fac.verify(envelope(p, req))).invalidReason).toMatch(/valid_after/);
  });

  it('rejects when the authorization pays someone other than payTo', async () => {
    const req = requirement();
    const p = await signExactPayment(buyer(), chain.net, req, resource);
    const other = { ...req, payTo: getAddress(privateKeyToAccount(generatePrivateKey()).address) };
    expect((await fac.verify(envelope(p, other))).invalidReason).toMatch(/recipient_mismatch/);
  });

  it('rejects a value different from the required amount (both directions)', async () => {
    const req = requirement();
    const p = await signExactPayment(buyer(), chain.net, req, resource);
    expect((await fac.verify(envelope(p, { ...req, amount: '100001' }))).invalidReason).toMatch(/authorization_value/);
    expect((await fac.verify(envelope(p, { ...req, amount: '99999' }))).invalidReason).toMatch(/authorization_value/);
  });

  it('rejects another network and another asset', async () => {
    const req = requirement();
    const p = await signExactPayment(buyer(), chain.net, req, resource);
    expect((await fac.verify(envelope(p, { ...req, network: 'eip155:133' }))).invalidReason).toBe('invalid_network');
    expect((await fac.verify(envelope(p, { ...req, asset: getAddress(seller().address) }))).invalidReason).toMatch(/asset/);
  });

  it('rejects a signature made under another token domain', async () => {
    const req = requirement();
    const wrongDomain = { ...chain.net, usdc: { ...chain.net.usdc, eip712: { name: 'Bridged USDC', version: '2' } } };
    const p = await signExactPayment(buyer(), wrongDomain, req, resource);
    expect((await fac.verify(envelope(p, req))).invalidReason).toMatch(/signature/);
  });

  it('two concurrent settles with 1 s blocks (like a real chain) still send exactly one transaction', async () => {
    const req = requirement();
    const body = envelope(await signExactPayment(buyer(), chain.net, req, resource), req);
    const pub = publicClientFor(chain.net);
    const gasWallet = privateKeyToAccount(chain.keys.facilitator).address;
    const test = createTestClient({ mode: 'anvil', transport: http(chain.net.rpcUrl) });
    const n0 = await pub.getTransactionCount({ address: gasWallet });
    await test.setAutomine(false);
    await test.setIntervalMining({ interval: 1 });
    try {
      const [a, b] = await Promise.all([fac.settle(body), fac.settle(body)]);
      expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
      expect([a.errorReason, b.errorReason]).toContain('authorization_in_flight');
    } finally {
      await test.setIntervalMining({ interval: 0 });
      await test.setAutomine(true);
    }
    expect(await pub.getTransactionCount({ address: gasWallet })).toBe(n0 + 1);
  }, 30_000);

  it('two concurrent settles of one authorization send exactly one transaction', async () => {
    const req = requirement();
    const body = envelope(await signExactPayment(buyer(), chain.net, req, resource), req);
    const pub = publicClientFor(chain.net);
    const gasWallet = privateKeyToAccount(chain.keys.facilitator).address;
    const n0 = await pub.getTransactionCount({ address: gasWallet });
    const [a, b] = await Promise.all([fac.settle(body), fac.settle(body)]);
    expect([a.success, b.success].filter(Boolean)).toHaveLength(1);
    expect(await pub.getTransactionCount({ address: gasWallet })).toBe(n0 + 1);
  });

  describe('seller with a scripted facilitator', () => {
    async function callSeller(f: Facilitator) {
      const app = createSeller({ net: chain.net, operator: seller(), facilitator: f, publicUrl: 'http://seller.test', recordReceipts: false });
      const req = requirement();
      const p = await signExactPayment(buyer(), chain.net, req, { ...resource, url: 'http://seller.test/task/translate?text=hello' });
      p.accepted = { ...p.accepted, payTo: getAddress(buyer().address), amount: '1' }; // the buyer's copy lies; the seller must not use it
      return app.request('/task/translate?text=hello', { headers: { 'X-PAYMENT': encodeHeader(p) } });
    }

    it('does not settle or deliver when verify says invalid', async () => {
      let settled = false;
      const res = await callSeller({
        verify: async () => ({ isValid: false, invalidReason: 'nope' }) as any,
        settle: async () => {
          settled = true;
          return { success: true, transactionHash: `0x${'aa'.repeat(32)}` } as any;
        },
      });
      expect(res.status).toBe(402);
      expect(settled).toBe(false);
    });

    it('does not deliver when settle fails, and sends its OWN requirement to the facilitator', async () => {
      const seen: any[] = [];
      const res = await callSeller({
        verify: async (_p, r) => {
          seen.push(r);
          return { isValid: true } as any;
        },
        settle: async (_p, r) => {
          seen.push(r);
          return { success: false, errorReason: 'reverted' } as any;
        },
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.result).toBeUndefined();
      for (const r of seen) {
        expect(r.payTo).toBe(seller().address);
        expect(r.maxAmountRequired).toBe('100000');
        expect(r.asset).toBe(chain.net.usdc.address);
      }
    });

    it('does not deliver when the settle tx was mined but reverted (success false WITH a hash)', async () => {
      const res = await callSeller({
        verify: async () => ({ isValid: true }) as any,
        settle: async () => ({ success: false, errorReason: 'transaction_reverted', transactionHash: `0x${'bb'.repeat(32)}` }) as any,
      });
      expect(res.status).toBe(502);
    });

    it('does not deliver on success without a transaction hash', async () => {
      const res = await callSeller({ verify: async () => ({ isValid: true }) as any, settle: async () => ({ success: true }) as any });
      expect(res.status).toBe(502);
    });
  });
});

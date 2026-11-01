import { describe, expect, it } from 'vitest';
import { verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getNetwork } from '../src/config.js';
import {
  NoAcceptableRequirementError,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  buildPaymentRequired,
  decodeHeader,
  encodeHeader,
  mismatchReason,
  networkMatches,
  selectRequirement,
  signExactPayment,
} from '../src/rails/x402.js';

const testnet = getNetwork('hashkey-testnet');
const mainnet = getNetwork('hashkey');
const seller = privateKeyToAccount(generatePrivateKey());
const buyer = privateKeyToAccount(generatePrivateKey());
const resource = { url: 'http://127.0.0.1:8402/task/translate?text=hello', description: 'd', mimeType: 'application/json' };

describe('402 body (brief §6.B flow 1)', () => {
  it('mainnet: exact, eip155:177, Bridged USDC, 100000, payTo, domain name/version', () => {
    const body = buildPaymentRequired(mainnet, { payTo: seller.address, amount: 100_000n, resource });
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toEqual([
      {
        scheme: 'exact',
        network: 'eip155:177',
        asset: '0x054ed45810DbBAb8B27668922D110669c9D88D0a',
        amount: '100000',
        payTo: seller.address,
        maxTimeoutSeconds: 120,
        extra: { name: 'Bridged USDC', version: '2' },
      },
    ]);
  });

  it('testnet: eip155:133 and the HSP sandbox USDC with domain "USD Coin" v2', () => {
    const a = buildPaymentRequired(testnet, { payTo: seller.address, amount: 100_000n, resource }).accepts[0]!;
    expect(a.network).toBe('eip155:133');
    expect(a.asset).toBe('0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6');
    expect(a.extra).toEqual({ name: 'USD Coin', version: '2' });
  });
});

describe('selectRequirement (buyer)', () => {
  const good = () => buildPaymentRequired(testnet, { payTo: seller.address, amount: 100_000n, resource });

  it('accepts the seller requirement on its own network', () => {
    expect(selectRequirement(good(), testnet).amount).toBe('100000');
  });

  it('accepts a lowercase asset and the v1 network name, and maxAmountRequired', () => {
    const b: any = good();
    b.accepts[0].asset = testnet.usdc.address.toLowerCase();
    b.accepts[0].network = ' HashKey-Testnet ';
    b.accepts[0].maxAmountRequired = b.accepts[0].amount;
    delete b.accepts[0].amount;
    expect(selectRequirement(b, testnet).network).toBe('eip155:133');
  });

  it.each([
    ['network', (a: any) => (a.network = 'eip155:177')],
    ['asset', (a: any) => (a.asset = '0x18Ec8e93627c893ae61ae0491c1C98769FD4Dfa2')],
    ['scheme', (a: any) => (a.scheme = 'upto')],
    ['amount', (a: any) => (a.amount = '1e5')],
    ['amount', (a: any) => (a.amount = '0')],
    ['amount', (a: any) => (a.amount = '-5')],
    ['payTo', (a: any) => (a.payTo = '0x1234')],
    ['token domain', (a: any) => (a.extra = { name: 'Bridged USDC', version: '2' })],
    ['token domain', (a: any) => delete a.extra],
  ])('refuses a bad %s', (label, mutate) => {
    const b: any = good();
    mutate(b.accepts[0]);
    expect(() => selectRequirement(b, testnet)).toThrow(new RegExp(label));
  });

  it('bounds how long the signature stays valid, whatever the seller asks', () => {
    for (const [asked, used] of [[1e12, 600], [600, 600], [5, 30], [-1, 120], [Number.NaN, 120], ['300', 120], [299.9, 299]] as const) {
      const b: any = good();
      b.accepts[0].maxTimeoutSeconds = asked;
      expect(selectRequirement(b, testnet).maxTimeoutSeconds, String(asked)).toBe(used);
    }
  });

  it('refuses a body without accepts', () => {
    expect(() => selectRequirement({}, testnet)).toThrow(NoAcceptableRequirementError);
    expect(() => selectRequirement(null, testnet)).toThrow(NoAcceptableRequirementError);
  });

  it('skips a bad entry and takes the next good one', () => {
    const b: any = good();
    b.accepts.unshift({ ...b.accepts[0], network: 'eip155:8453' });
    expect(selectRequirement(b, testnet).network).toBe('eip155:133');
  });
});

describe('signExactPayment (EIP-3009)', () => {
  it('signs a TransferWithAuthorization the token domain verifies', async () => {
    const req = selectRequirement(buildPaymentRequired(testnet, { payTo: seller.address, amount: 100_000n, resource }), testnet);
    const p = await signExactPayment(buyer, testnet, req, resource, { nowSeconds: 1_800_000_000 });
    const a = p.payload.authorization;
    expect(a).toMatchObject({ from: buyer.address, to: seller.address, value: '100000', validAfter: '1799999400', validBefore: '1800000120' });
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const ok = await verifyTypedData({
      address: buyer.address,
      domain: { name: 'USD Coin', version: '2', chainId: 133, verifyingContract: testnet.usdc.address },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature: p.payload.signature,
    });
    expect(ok).toBe(true);
    // a signature for testnet does not verify under the mainnet domain
    const cross = await verifyTypedData({
      address: buyer.address,
      domain: { name: 'Bridged USDC', version: '2', chainId: 177, verifyingContract: mainnet.usdc.address },
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature: p.payload.signature,
    });
    expect(cross).toBe(false);
  });

  it('uses a fresh nonce every time', async () => {
    const req = selectRequirement(buildPaymentRequired(testnet, { payTo: seller.address, amount: 1n, resource }), testnet);
    const [x, y] = await Promise.all([signExactPayment(buyer, testnet, req, resource), signExactPayment(buyer, testnet, req, resource)]);
    expect(x.payload.authorization.nonce).not.toBe(y.payload.authorization.nonce);
  });
});

describe('header encoding and seller matching', () => {
  it('round-trips base64 JSON', () => {
    const v = { a: 1, s: 'ñ✓' };
    expect(decodeHeader(encodeHeader(v))).toEqual(v);
  });

  it('networkMatches is case and space tolerant, CAIP-2 or v1 name', () => {
    expect(networkMatches('EIP155:133', testnet)).toBe(true);
    expect(networkMatches('hashkey-testnet', testnet)).toBe(true);
    expect(networkMatches('hashkey', testnet)).toBe(false);
  });

  it('mismatchReason passes a correct payment and names every tampering', async () => {
    const req = buildPaymentRequired(testnet, { payTo: seller.address, amount: 100_000n, resource }).accepts[0]!;
    const p = await signExactPayment(buyer, testnet, req, resource);
    expect(mismatchReason(p, req)).toBeUndefined();
    const cases: Array<[string, (x: any) => void]> = [
      ['value', (x) => (x.payload.authorization.value = '99999')],
      ['seller', (x) => (x.payload.authorization.to = buyer.address)],
      ['nonce', (x) => (x.payload.authorization.nonce = '0x1234')],
      ['network', (x) => (x.accepted.network = 'eip155:177')],
      ['asset', (x) => (x.accepted.asset = mainnet.usdc.address)],
      ['x402Version', (x) => (x.x402Version = 1)],
      ['signature', (x) => delete x.payload.signature],
      ['value', (x) => (x.payload.authorization.value = '0x186a0')],
    ];
    for (const [label, mutate] of cases) {
      const copy = structuredClone(p);
      mutate(copy);
      expect(mismatchReason(copy, req), label).toMatch(new RegExp(label === 'seller' ? 'seller' : label));
    }
    expect(mismatchReason(null, req)).toBeDefined();
  });
});

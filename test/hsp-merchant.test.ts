import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNetwork } from '../src/config.js';
import {
  MerchantApiError,
  MerchantClient,
  buildCartContents,
  canonicalJson,
  cartHash,
  formatDecimal,
  parseDecimal,
  sha256Hex,
  signMerchantAuthorization,
  signMerchantRequest,
  signWebhook,
  verifyMerchantAuthorization,
  verifyWebhook,
} from '../src/rails/hsp-merchant.js';
import { MerchantHspRail, toPaymentState } from '../src/rails/hsp.js';
import { paymentMismatch } from '../src/agents/hsp-flow.js';
import { fakeMerchantGateway } from './fake-merchant.js';
import { hasBinary, listen } from './helpers.js';

/** Recorded examples from the HashKey Merchant docs (see test/fixtures/hsp-merchant/README.md). */
const fixture = (name: string) => JSON.parse(readFileSync(join('test/fixtures/hsp-merchant', name), 'utf8'));
const keys = () => generateKeyPairSync('ec', { namedCurve: 'secp256k1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const creds = { appKey: 'ak_test', appSecret: 'secret_test' };
const testnet = getNetwork('hashkey-testnet');

describe('canonical JSON (cart_hash and HMAC body hash)', () => {
  it('matches the two documented examples', () => {
    expect(canonicalJson({ merchant_name: 'My Store', id: 'cart-123', cart_expiry: '2024-03-01T12:00:00Z' })).toBe(
      '{"cart_expiry":"2024-03-01T12:00:00Z","id":"cart-123","merchant_name":"My Store"}',
    );
    expect(canonicalJson({ b: 2, a: 1, nested: { z: 'last', m: 'middle' } })).toBe('{"a":1,"b":2,"nested":{"m":"middle","z":"last"}}');
  });
  it('keeps array order and sorts keys inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: [3, 1] }, 2])).toBe('[{"a":[3,1],"b":1},2]');
  });
});

describe('HMAC-SHA256 request signing', () => {
  it('signs the documented POST message: METHOD, PATH, empty QUERY, bodyHash, timestamp, nonce', () => {
    const body = fixture('create-order-request.json');
    const s = signMerchantRequest(creds, { method: 'post', path: '/api/v1/merchant/orders', body }, { timestamp: 1709123456, nonce: 'a3f1b2c4d5e6' });
    expect(s.message).toBe(`POST\n/api/v1/merchant/orders\n\n${sha256Hex(canonicalJson(body))}\n1709123456\na3f1b2c4d5e6`);
    expect(s.body).toBe(canonicalJson(body)); // what is sent is exactly what was hashed
    expect(s.headers).toMatchObject({ 'X-App-Key': 'ak_test', 'X-Timestamp': '1709123456', 'X-Nonce': 'a3f1b2c4d5e6', 'Content-Type': 'application/json' });
    expect(s.headers['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
  it('signs the documented GET message with the query and an empty body hash', () => {
    const s = signMerchantRequest(creds, { method: 'GET', path: '/api/v1/merchant/payments', query: 'cart_mandate_id=ORDER-123' }, { timestamp: 1709123456, nonce: 'a3f1b2c4d5e6' });
    expect(s.message).toBe('GET\n/api/v1/merchant/payments\ncart_mandate_id=ORDER-123\n\n1709123456\na3f1b2c4d5e6');
    expect(s.body).toBeUndefined();
    expect(s.headers['Content-Type']).toBeUndefined();
  });
  it.skipIf(!hasBinary('openssl'))('equals the docs\' openssl recipe (printf %b | openssl dgst -sha256 -hmac)', () => {
    const body = fixture('create-order-request.json');
    const s = signMerchantRequest(creds, { method: 'POST', path: '/api/v1/merchant/orders', body }, { timestamp: 1709123456, nonce: 'a3f1b2c4d5e6' });
    const bodyHash = spawnSync('openssl', ['dgst', '-sha256', '-hex'], { input: s.body, encoding: 'utf8' }).stdout.trim().split(' ').pop();
    const sig = spawnSync('openssl', ['dgst', '-sha256', '-hmac', creds.appSecret, '-hex'], { input: `POST\n/api/v1/merchant/orders\n\n${bodyHash}\n1709123456\na3f1b2c4d5e6`, encoding: 'utf8' })
      .stdout.trim()
      .split(' ')
      .pop();
    expect(s.headers['X-Signature']).toBe(sig);
  });
  it('a fresh nonce per request (12-32 hex) and the current time by default', () => {
    const a = signMerchantRequest(creds, { method: 'GET', path: '/p' });
    const b = signMerchantRequest(creds, { method: 'GET', path: '/p' });
    expect(a.headers['X-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(a.headers['X-Nonce']).not.toBe(b.headers['X-Nonce']);
    expect(Math.abs(Number(a.headers['X-Timestamp']) - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe('ES256K merchant_authorization', () => {
  const contents = fixture('create-order-request.json').cart_mandate.contents;

  it('header, claims and a signature that verifies with the registered public key', () => {
    const k = keys();
    const jwt = signMerchantAuthorization(k.privateKey, { merchantName: 'My Store', cartHash: cartHash(contents), now: 1_800_000_000, jti: 'JWT-1-x' });
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256K', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      iss: 'My Store',
      sub: 'My Store',
      aud: 'HashkeyMerchant',
      iat: 1_800_000_000,
      exp: 1_800_003_600,
      jti: 'JWT-1-x',
      cart_hash: cartHash(contents),
    });
    const sig = Buffer.from(s!, 'base64url');
    expect(sig.length).toBe(64); // JWS r||s, not DER
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey(k.publicKey), dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
    expect(verifyMerchantAuthorization(jwt, k.publicKey, 1_800_000_001).cart_hash).toBe(cartHash(contents));
  });

  it('always low-s, a unique jti by default, and expiry enforced by the verifier', () => {
    const k = keys();
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const jtis = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const jwt = signMerchantAuthorization(k.privateKey, { merchantName: 'm', cartHash: 'a'.repeat(64) });
      const sig = Buffer.from(jwt.split('.')[2]!, 'base64url');
      expect(BigInt(`0x${sig.subarray(32).toString('hex')}`) <= n / 2n).toBe(true);
      jtis.add(JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).jti);
    }
    expect(jtis.size).toBe(40);
    const old = signMerchantAuthorization(k.privateKey, { merchantName: 'm', cartHash: 'a'.repeat(64), now: 1000, ttlSeconds: 60 });
    expect(() => verifyMerchantAuthorization(old, k.publicKey)).toThrow(/expired/);
    expect(() => verifyMerchantAuthorization(old, keys().publicKey, 1001)).toThrow(/signature/);
  });

  it.skipIf(!hasBinary('openssl'))('accepts the SEC1 key the docs\' openssl command produces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hsp-key-'));
    spawnSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', join(dir, 'k.pem')]);
    const pem = readFileSync(join(dir, 'k.pem'), 'utf8');
    expect(pem).toMatch(/BEGIN EC PRIVATE KEY/);
    const pub = spawnSync('openssl', ['ec', '-in', join(dir, 'k.pem'), '-pubout'], { encoding: 'utf8' }).stdout;
    const jwt = signMerchantAuthorization(pem, { merchantName: 'm', cartHash: 'b'.repeat(64) });
    expect(verifyMerchantAuthorization(jwt, pub).sub).toBe('m');
  });

  it('the verifier refuses a token whose header is not ES256K, even with a valid signature over it', () => {
    const k = keys();
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ aud: 'HashkeyMerchant', exp: 9_999_999_999, cart_hash: 'a'.repeat(64) })).toString('base64url');
    const sig = sign('sha256', Buffer.from(`${h}.${p}`), { key: createPrivateKey(k.privateKey), dsaEncoding: 'ieee-p1363' }).toString('base64url');
    expect(() => verifyMerchantAuthorization(`${h}.${p}.${sig}`, k.publicKey)).toThrow(/not ES256K/);
  });

  it('refuses a non-secp256k1 key and a malformed cart_hash', () => {
    const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(() => signMerchantAuthorization(p256.privateKey, { merchantName: 'm', cartHash: 'a'.repeat(64) })).toThrow(/secp256k1/);
    expect(() => signMerchantAuthorization(keys().privateKey, { merchantName: 'm', cartHash: 'ABC' })).toThrow(/cart_hash/);
  });
});

describe('Cart Mandate contents', () => {
  const build = () =>
    buildCartContents({
      cartMandateId: 'AS-1',
      paymentRequestId: 'AS-PR-1',
      merchantName: 'AgentSettle',
      label: 'task',
      amount: 100_000n,
      token: { address: testnet.usdc.address, symbol: 'USDC', decimals: 6 },
      network: { name: testnet.name, chainId: testnet.chainId },
      payTo: '0xfc104F3666Aeaf5BE5361E149B2B1015D0F9A38D',
      expiresAt: new Date('2026-10-31T05:00:00.123Z'),
    });

  it('has the documented shape: x402 v2 method on hashkey-testnet 133, USD amounts that add up, RFC 3339 expiry', () => {
    const c = build();
    expect(c.payment_request.method_data).toEqual([
      {
        supported_methods: 'https://www.x402.org/',
        data: { x402Version: 2, network: 'hashkey-testnet', chain_id: 133, contract_address: testnet.usdc.address, pay_to: '0xfc104F3666Aeaf5BE5361E149B2B1015D0F9A38D', coin: 'USDC' },
      },
    ]);
    expect(c.payment_request.details.total.amount).toEqual({ currency: 'USD', value: '0.10' });
    expect(c.payment_request.details.display_items!.map((i) => i.amount.value)).toEqual(['0.10']);
    expect(c.cart_expiry).toBe('2026-10-31T05:00:00Z');
    expect(c.id).toBe('AS-1');
    expect(c.payment_request.details.id).toBe('AS-PR-1');
    // same keys as the documented request (no extra or missing required fields)
    const doc = fixture('create-order-request.json').cart_mandate.contents;
    expect(Object.keys(c).sort()).toEqual(Object.keys(doc).sort());
    expect(Object.keys(c.payment_request.method_data[0]!.data).sort()).toEqual(Object.keys(doc.payment_request.method_data[0].data).sort());
  });

  it('decimal strings round-trip exactly and refuse anything inexact', () => {
    expect(formatDecimal(100_000n, 6)).toBe('0.10');
    expect(formatDecimal(1_234_567n, 6)).toBe('1.234567');
    expect(formatDecimal(5_000_000n, 6)).toBe('5.00');
    expect(parseDecimal('0.10', 6)).toBe(100_000n);
    expect(parseDecimal('100.30', 6)).toBe(100_300_000n);
    expect(parseDecimal('7', 6)).toBe(7_000_000n);
    expect(parseDecimal('0.1000000', 6)).toBe(100_000n);
    for (const bad of ['0.1234567', '-1', '1e3', '', '0x10', '1.2.3', ' ']) expect(() => parseDecimal(bad, 6), bad).toThrow();
  });
});

describe('payment records (recorded doc samples)', () => {
  it('the published sample parses, but its placeholder payer and tx are never accepted', () => {
    const s = toPaymentState(fixture('payment-record.json').data, getNetwork('hashkey-testnet'));
    expect(s.status).toBe('payment-finalized');
    expect(s.paid).toBe(true);
    expect(s.terminal).toBe(true);
    expect(s.amount).toBe(100_300_000n);
    expect(s.payer).toBeUndefined(); // "0x1234567890abcdef" is not an address
    expect(s.txHash).toBeUndefined(); // "0xabcd1234..." is not a tx hash
    expect(paymentMismatch(s, { net: testnet, payTo: '0xabcdef1234567890abcdef1234567890abcdef12', amount: 100_300_000n })).toBe('no tx_signature');
  });
  it('each row of the reusable page parses the same way', () => {
    const page = fixture('payments-reusable-page.json').data;
    expect(page.list).toHaveLength(1);
    expect(toPaymentState(page.list[0], testnet).status).toBe('payment-finalized');
  });
  it('in-flight and failed states are not paid; only failed and finalized are terminal', () => {
    for (const [status, paid, terminal] of [
      ['payment-required', false, false],
      ['payment-processing', false, false],
      ['payment-included', true, false],
      ['payment-safe', true, false],
      ['payment-finalized', true, true],
      ['payment-failed', false, true],
    ] as const) {
      const s = toPaymentState({ payment_request_id: 'x', status }, testnet);
      expect([s.paid, s.terminal], status).toEqual([paid, terminal]);
    }
  });
  it('paymentMismatch names every field that differs from the order', () => {
    const good = {
      status: 'payment-included',
      paid: true,
      terminal: false,
      simulated: false,
      txHash: `0x${'1'.repeat(64)}` as const,
      payer: '0xc9eAB77D415EcDf7FAA93130ff74F402FF99E289' as const,
      payTo: '0xfc104F3666Aeaf5BE5361E149B2B1015D0F9A38D' as const,
      token: testnet.usdc.address,
      chain: 'eip155:133',
      amount: 100_000n,
    };
    const expect0 = { net: testnet, payTo: '0xfc104f3666aeaf5be5361e149b2b1015d0f9a38d' as const, amount: 100_000n };
    expect(paymentMismatch(good, expect0)).toBeUndefined();
    expect(paymentMismatch({ ...good, payTo: '0x000000000000000000000000000000000000dEaD' }, expect0)).toMatch(/to_pay_address/);
    expect(paymentMismatch({ ...good, token: '0x372325443233fEbaC1F6998aC750276468c83CC6' }, expect0)).toMatch(/token_address/); // testnet USDT
    expect(paymentMismatch({ ...good, chain: 'eip155:177' }, expect0)).toMatch(/chain/);
    expect(paymentMismatch({ ...good, amount: 100_001n }, expect0)).toMatch(/pay_amount/);
    expect(paymentMismatch({ ...good, amount: undefined }, expect0)).toMatch(/pay_amount is unreadable/);
    expect(paymentMismatch({ ...good, payer: undefined }, expect0)).toMatch(/payer_address/);
  });
});

describe('webhooks (recorded doc samples)', () => {
  const now = 1_793_400_000;
  it('verifies the finalized and failed samples over the raw body', () => {
    for (const name of ['webhook-finalized.json', 'webhook-failed.json']) {
      const raw = JSON.stringify(fixture(name));
      const event = verifyWebhook(raw, signWebhook(raw, creds.appSecret, now - 10), creds.appSecret, now);
      expect(event.event_type).toBe('payment');
      expect(event.status).toBe(name.includes('failed') ? 'payment-failed' : 'payment-finalized');
    }
  });
  it('refuses a tampered body, a wrong secret, a stale or future timestamp, a missing or malformed header', () => {
    const raw = JSON.stringify(fixture('webhook-finalized.json'));
    const sig = signWebhook(raw, creds.appSecret, now);
    expect(() => verifyWebhook(raw.replace('100.30', '999.30'), sig, creds.appSecret, now)).toThrow(/mismatch/);
    expect(() => verifyWebhook(raw, sig, 'other', now)).toThrow(/mismatch/);
    expect(() => verifyWebhook(raw, sig, creds.appSecret, now + 301)).toThrow(/tolerance/);
    expect(() => verifyWebhook(raw, sig, creds.appSecret, now - 301)).toThrow(/tolerance/);
    expect(verifyWebhook(raw, sig, creds.appSecret, now + 300).status).toBe('payment-finalized');
    expect(() => verifyWebhook(raw, undefined, creds.appSecret, now)).toThrow(/missing/);
    expect(() => verifyWebhook(raw, `t=${now}`, creds.appSecret, now)).toThrow(/malformed/);
    expect(() => verifyWebhook(raw, `t=abc,v1=${'0'.repeat(64)}`, creds.appSecret, now)).toThrow(/malformed/);
    expect(() => verifyWebhook(raw, `t=${now},v1=short`, creds.appSecret, now)).toThrow(/mismatch/);
  });
  it('refuses an authentic body that is not a payment event', () => {
    const raw = JSON.stringify({ event_type: 'refund', payment_request_id: 'x', status: 'y' });
    expect(() => verifyWebhook(raw, signWebhook(raw, creds.appSecret, now), creds.appSecret, now)).toThrow(/not a payment/);
  });
});

describe('MerchantClient against the fake gateway (recorded responses)', () => {
  const k = keys();
  let srv: { url: string; close: () => Promise<void> };
  let gwSrv: { url: string; close: () => Promise<void> };
  const gw = fakeMerchantGateway({ ...creds, merchantPublicKeyPem: k.publicKey });
  const recorded = new Hono();
  recorded.post('/api/v1/merchant/orders', (c) => c.json(fixture('create-order-response.json')));
  recorded.get('/api/v1/merchant/payments', (c) => c.json(fixture('payment-record.json')));
  recorded.get('/broken/api/v1/merchant/payments', (c) => c.text('<html>403 blocked</html>', 403));
  recorded.get('/limited/api/v1/merchant/payments', (c) => c.json({ code: 10007, msg: 'Rate limited', data: null }));
  const both = new Hono();
  both.route('/recorded', recorded);
  both.route('/', recorded);
  beforeAll(async () => {
    srv = await listen(both);
    gwSrv = await listen(gw.app); // at the root: the HMAC signs the full path
  });
  afterAll(async () => {
    await srv.close();
    await gwSrv.close();
  });

  const contents = (id: string) =>
    buildCartContents({
      cartMandateId: id,
      paymentRequestId: `PR-${id}`,
      merchantName: 'AgentSettle',
      label: 'task',
      amount: 100_000n,
      token: { address: testnet.usdc.address, symbol: 'USDC', decimals: 6 },
      network: { name: testnet.name, chainId: testnet.chainId },
      payTo: '0xfc104F3666Aeaf5BE5361E149B2B1015D0F9A38D',
      expiresAt: new Date(Date.now() + 3600_000),
    });
  const mandate = (id: string, key = k.privateKey) => {
    const c = contents(id);
    return { contents: c, merchant_authorization: signMerchantAuthorization(key, { merchantName: 'AgentSettle', cartHash: cartHash(c) }) };
  };

  it('parses the recorded create-order and payment responses', async () => {
    const client = new MerchantClient({ baseUrl: `${srv.url}/recorded`, creds });
    expect(await client.createOrder(mandate('R1'))).toEqual({ paymentRequestId: 'PAY-REQ-20240301-001', paymentUrl: 'https://pay.hashkey.com/flow/xxx', multiPay: false });
    expect((await client.paymentByRequestId('PAY-REQ-20240301-001')).status).toBe('payment-finalized');
  });

  it('the fake gateway accepts our HMAC, body hash, JWT and cart_hash; a duplicate cart is 40001', async () => {
    const client = new MerchantClient({ baseUrl: gwSrv.url, creds });
    const order = await client.createOrder(mandate('G1'));
    expect(order.paymentRequestId).toBe('PR-G1');
    expect((await client.paymentByRequestId('PR-G1')).status).toBe('payment-required');
    expect(gw.rejected).toEqual([]);
    await expect(client.createOrder(mandate('G1'))).rejects.toMatchObject({ code: 40001, httpStatus: 400 });
    await expect(client.paymentByRequestId('nope')).rejects.toMatchObject({ code: 10003 });
  });

  it('a wrong app_secret or another merchant key is refused by the gateway checks', async () => {
    await expect(new MerchantClient({ baseUrl: gwSrv.url, creds: { ...creds, appSecret: 'wrong' } }).createOrder(mandate('G2'))).rejects.toMatchObject({ code: 10002 });
    await expect(new MerchantClient({ baseUrl: gwSrv.url, creds }).createOrder(mandate('G3', keys().privateKey))).rejects.toThrow(/JWT signature/);
    // contents changed after signing: cart_hash no longer matches
    const m = mandate('G4');
    m.contents.payment_request.details.total.amount.value = '0.01';
    await expect(new MerchantClient({ baseUrl: gwSrv.url, creds }).createOrder(m)).rejects.toThrow(/cart_hash/);
  });

  it('the rail refuses an order answer for another payment_request_id', async () => {
    // the recorded response always names PAY-REQ-20240301-001
    const rail = new MerchantHspRail(testnet, new MerchantClient({ baseUrl: `${srv.url}/recorded`, creds }), { name: 'AgentSettle', privateKeyPem: k.privateKey }, creds.appSecret);
    await expect(rail.createOrder({ taskRef: 'x1', amount: 100_000n, payTo: '0xfc104F3666Aeaf5BE5361E149B2B1015D0F9A38D', label: 't' })).rejects.toThrow(/expected AS-PR-x1/);
  });

  it('an error envelope on HTTP 200 (code != 0) is still an error', async () => {
    const err = await new MerchantClient({ baseUrl: `${srv.url}/limited`, creds }).paymentByRequestId('x').catch((e) => e);
    expect(err).toBeInstanceOf(MerchantApiError);
    expect([err.code, err.httpStatus]).toEqual([10007, 200]);
  });

  it('a non-JSON answer (the QA block page) is a MerchantApiError, not a crash', async () => {
    const err = await new MerchantClient({ baseUrl: `${srv.url}/broken`, creds }).paymentByRequestId('x').catch((e) => e);
    expect(err).toBeInstanceOf(MerchantApiError);
    expect(err.httpStatus).toBe(403);
  });

  it('sends exactly the canonical body it hashed', async () => {
    let seen = '';
    const spy = new Hono();
    spy.post('/api/v1/merchant/orders', async (c) => {
      seen = await c.req.text();
      return c.json(fixture('create-order-response.json'));
    });
    const s = await listen(spy);
    const m = mandate('S1');
    await new MerchantClient({ baseUrl: s.url, creds }).createOrder(m);
    await s.close();
    expect(seen).toBe(canonicalJson({ cart_mandate: m }));
  });
});

describe('no secrets in the repo', () => {
  it('fixtures and docs carry no private key', () => {
    for (const dir of ['test/fixtures/hsp-merchant', 'docs/hsp']) {
      let files: string[] = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), `${dir}/${f}`).not.toMatch(/PRIVATE KEY/);
    }
  });
});

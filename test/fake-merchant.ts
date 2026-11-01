import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';
import { Hono, type Context } from 'hono';

/**
 * A stand-in for the HashKey Merchant gateway, written from the docs and NOT from src/rails/hsp-merchant.ts:
 * it re-derives the HMAC message, the canonical JSON body hash and the ES256K cart_hash on its own, so a client
 * bug cannot be hidden by sharing code with the checker.
 */

const sortKeys = (v: any): any =>
  v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(sortKeys) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface FakeGateway {
  app: Hono;
  orders: Map<string, { contents: any; jwtClaims: any }>;
  /** Every rejected call with its reason (tests assert it stays empty). */
  rejected: string[];
  /** Sets (or replaces) the payment record served for a payment_request_id. */
  setPayment(paymentRequestId: string, record: Record<string, unknown>): void;
}

export function fakeMerchantGateway(opts: { appKey: string; appSecret: string; merchantPublicKeyPem: string; now?: () => number }): FakeGateway {
  const app = new Hono();
  const orders = new Map<string, { contents: any; jwtClaims: any }>();
  const payments = new Map<string, Record<string, unknown>>();
  const nonces = new Set<string>();
  const rejected: string[] = [];
  const now = () => opts.now?.() ?? Math.floor(Date.now() / 1000);

  const deny = (c: Context, reason: string, status: 400 | 401 | 404 = 401, code = 10002) => {
    rejected.push(reason);
    return c.json({ code, msg: reason, data: null }, status);
  };

  const hmacProblem = (c: Context, raw: string): string | undefined => {
    const ts = c.req.header('x-timestamp') ?? '';
    const nonce = c.req.header('x-nonce') ?? '';
    if (c.req.header('x-app-key') !== opts.appKey) return 'unknown X-App-Key';
    if (!/^\d+$/.test(ts) || Math.abs(now() - Number(ts)) > 300) return 'timestamp skew';
    if (!/^([0-9a-f]{12,32}|[0-9a-f-]{36})$/i.test(nonce)) return 'bad nonce';
    if (nonces.has(nonce)) return 'replayed nonce';
    nonces.add(nonce);
    const url = new URL(c.req.url);
    const bodyHash = raw ? sha(JSON.stringify(sortKeys(JSON.parse(raw)))) : '';
    const message = `${c.req.method}\n${url.pathname}\n${url.search.replace(/^\?/, '')}\n${bodyHash}\n${ts}\n${nonce}`;
    const expected = createHmac('sha256', opts.appSecret).update(message).digest('hex');
    return expected === c.req.header('x-signature') ? undefined : 'HMAC mismatch';
  };

  app.post('/api/v1/merchant/orders', async (c) => {
    const raw = await c.req.text();
    const problem = hmacProblem(c, raw);
    if (problem) return deny(c, problem);
    const body = JSON.parse(raw);
    const cm = body.cart_mandate;
    const [h, p, s] = String(cm?.merchant_authorization ?? '').split('.');
    if (!h || !p || !s) return deny(c, 'no merchant_authorization');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header.alg !== 'ES256K') return deny(c, 'JWT is not ES256K');
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey(opts.merchantPublicKeyPem), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    if (!ok) return deny(c, 'JWT signature');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (claims.aud !== 'HashkeyMerchant' || !(claims.exp > now())) return deny(c, 'JWT claims');
    if (claims.cart_hash !== sha(JSON.stringify(sortKeys(cm.contents)))) return deny(c, 'cart_hash does not match contents');
    const details = cm.contents?.payment_request?.details;
    if (!details?.id || details.total?.amount?.currency !== 'USD') return deny(c, 'invalid parameters', 400, 10001);
    const sum = (details.display_items ?? []).reduce((a: number, i: any) => a + Number(i.amount.value), 0);
    if (details.display_items?.length && Math.abs(sum - Number(details.total.amount.value)) > 1e-9) return deny(c, 'display_items do not add up', 400, 10001);
    if (orders.has(cm.contents.id)) return deny(c, 'Invalid mandate state', 400, 40001);
    orders.set(cm.contents.id, { contents: cm.contents, jwtClaims: claims });
    payments.set(details.id, { payment_request_id: details.id, content_id: cm.contents.id, status: 'payment-required' });
    return c.json({ code: 0, msg: 'success', data: { payment_request_id: details.id, payment_url: `https://pay.test/flow/${details.id}`, multi_pay: false } });
  });

  app.get('/api/v1/merchant/payments', async (c) => {
    const problem = hmacProblem(c, '');
    if (problem) return deny(c, problem);
    const rec = payments.get(c.req.query('payment_request_id') ?? '');
    return rec ? c.json({ code: 0, msg: 'success', data: rec }) : deny(c, 'Not found', 404, 10003);
  });

  return { app, orders, rejected, setPayment: (id, record) => payments.set(id, { payment_request_id: id, ...record }) };
}

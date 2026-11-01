import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from '../src/app.js';
import { getNetwork } from '../src/config.js';
import { AwsSsmStore, ensureMerchantKey, loadHspSecrets, publicPemOf, type SecretStore } from '../src/hsp-secrets.js';
import { MerchantClient, signWebhook } from '../src/rails/hsp-merchant.js';
import { MerchantHspRail, StubHspRail, createHspRail, type HspRail } from '../src/rails/hsp.js';
import type { Runtime } from '../src/runtime.js';
import { SpendGuard } from '../src/spend-guard.js';

const testnet = getNetwork('hashkey-testnet');
const pem = () => generateKeyPairSync('ec', { namedCurve: 'secp256k1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  writes = 0;
  getMany(names: string[]) {
    return Object.fromEntries(names.map((n) => [n, this.values.get(n)]));
  }
  createSecure(name: string, value: string) {
    if (this.values.has(name)) throw new Error('ParameterAlreadyExists');
    this.writes++;
    this.values.set(name, value);
  }
}

describe('HSP rail selection', () => {
  it('without all three secrets it is a stub that says which are missing', () => {
    expect(createHspRail(testnet, {}).reason).toMatch(/app_key, app_secret, merchant key/);
    expect(createHspRail(testnet, { appKey: 'a', appSecret: 's' }).reason).toMatch(/\(merchant key\)/);
    const rail = createHspRail(testnet, { appKey: 'a', merchantPrivateKeyPem: pem() });
    expect(rail).toBeInstanceOf(StubHspRail);
    expect(rail.reason).toMatch(/app_secret/);
  });
  it('merchant mode on hashkey-testnet only', () => {
    const cfg = { appKey: 'a', appSecret: 's', merchantPrivateKeyPem: pem() };
    expect(createHspRail(testnet, cfg).mode).toBe('merchant');
    expect(createHspRail(getNetwork('hashkey'), cfg).mode).toBe('stub');
    expect(createHspRail(getNetwork('local'), cfg).mode).toBe('stub');
  });
  it('the stub never reports a payment', async () => {
    const rail = new StubHspRail('why');
    const order = await rail.createOrder({ taskRef: 't', amount: 1n, payTo: '0x2222222222222222222222222222222222222222', label: 'x' });
    expect(order.simulated).toBe(true);
    expect(await rail.payment(order.paymentRequestId)).toMatchObject({ paid: false, simulated: true, status: 'SIMULATED' });
  });
});

describe('HSP secrets in SSM', () => {
  it('loadHspSecrets maps the three parameters and never throws', () => {
    const store = new MemoryStore();
    store.values.set('/p/app-key', 'ak');
    store.values.set('/p/app-secret', 'as');
    store.values.set('/p/merchant-private-key', 'pem');
    expect(loadHspSecrets(store, '/p')).toEqual({ appKey: 'ak', appSecret: 'as', merchantPrivateKeyPem: 'pem' });
    const broken: SecretStore = { getMany: () => { throw new Error('aws CLI unavailable'); }, createSecure: () => {} };
    expect(loadHspSecrets(broken, '/p')).toEqual({ error: 'aws CLI unavailable' });
  });

  it('AwsSsmStore passes secret values on stdin only, never in argv', () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const run: any = (_cmd: string, args: string[], o: { input?: string }) => {
      calls.push({ args, input: o.input });
      return { status: 0, stdout: JSON.stringify({ Parameters: [{ Name: '/p/app-key', Value: 'ak' }] }), stderr: '' };
    };
    const store = new AwsSsmStore({ region: 'us-east-1', run });
    store.createSecure('/p/merchant-private-key', 'SECRET-PEM', 'desc');
    expect(calls[0]!.input).toBe('SECRET-PEM');
    expect(calls[0]!.args.join(' ')).not.toContain('SECRET-PEM');
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['put-parameter', '--type', 'SecureString', '--value', 'file:///dev/stdin', '--region', 'us-east-1']));
    expect(calls[0]!.args).not.toContain('--overwrite');
    expect(store.getMany(['/p/app-key'])).toEqual({ '/p/app-key': 'ak' });
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['get-parameters', '--with-decryption']));
  });

  it('AwsSsmStore reports the CLI error without echoing values', () => {
    const run: any = () => ({ status: 254, stdout: '', stderr: 'An error occurred (ParameterAlreadyExists) when calling the PutParameter operation' });
    expect(() => new AwsSsmStore({ run }).createSecure('/p/x', 'SECRET', 'd')).toThrow(/ParameterAlreadyExists/);
    const missing: any = () => ({ error: new Error('spawnSync aws ENOENT') });
    expect(() => new AwsSsmStore({ run: missing }).getMany(['/p/x'])).toThrow(/aws CLI unavailable/);
  });

  it('ensureMerchantKey: private key only in the store, public PEM on disk, never overwritten', () => {
    const store = new MemoryStore();
    const dir = mkdtempSync(join(tmpdir(), 'hsp-pub-'));
    const path = join(dir, 'merchant-public-key.pem');
    const first = ensureMerchantKey(store, { name: '/p/merchant-private-key', publicKeyPath: path });
    expect(first.created).toBe(true);
    const priv = store.values.get('/p/merchant-private-key')!;
    expect(priv).toMatch(/BEGIN PRIVATE KEY/);
    expect(createPrivateKey(priv).asymmetricKeyDetails?.namedCurve).toBe('secp256k1');
    expect(readFileSync(path, 'utf8')).toBe(first.publicKeyPem);
    expect(first.publicKeyPem).toBe(publicPemOf(priv));
    expect(readdirSync(dir)).toEqual(['merchant-public-key.pem']);
    expect(readFileSync(path, 'utf8')).not.toMatch(/PRIVATE/);
    const again = ensureMerchantKey(store, { name: '/p/merchant-private-key', publicKeyPath: path });
    expect(again).toEqual({ publicKeyPem: first.publicKeyPem, created: false });
    expect(store.writes).toBe(1);
  });

  it('ensureMerchantKey fails loudly when the store does not read back what was written', () => {
    const lossy: SecretStore = { values: new Map<string, string>(), getMany(names: string[]) { return Object.fromEntries(names.map((n) => [n, (this as any).values.get(n)])); }, createSecure(name: string, value: string) { (this as any).values.set(name, `${value}x`); } } as any;
    expect(() => ensureMerchantKey(lossy, { name: '/p/k', publicKeyPath: join(mkdtempSync(join(tmpdir(), 'hsp-pub-')), 'k.pem') })).toThrow(/did not read back/);
  });

  it('ensureMerchantKey refuses a stored key on another curve', () => {
    const store = new MemoryStore();
    store.values.set('/p/k', generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey);
    expect(() => ensureMerchantKey(store, { name: '/p/k', publicKeyPath: join(mkdtempSync(join(tmpdir(), 'hsp-pub-')), 'k.pem') })).toThrow(/secp256k1/);
  });
});

describe('console routes for HSP', () => {
  const rtWith = (hsp: HspRail): Runtime => ({
    net: testnet,
    operator: privateKeyToAccount(generatePrivateKey()),
    buyer: privateKeyToAccount(generatePrivateKey()),
    guard: new SpendGuard(),
    hsp,
    facilitatorUrl: 'http://127.0.0.1:9',
    facilitatorLabel: 'x',
    close: () => {},
  });
  const merchant = () => new MerchantHspRail(testnet, new MerchantClient({ baseUrl: 'http://127.0.0.1:9', creds: { appKey: 'a', appSecret: 's' } }), { name: 'm', privateKeyPem: pem() }, 's');

  it('/hsp/webhook: 404 while the rail is a stub; 200 {code:0} for a valid signature; 401 otherwise', async () => {
    const raw = JSON.stringify({ event_type: 'payment', payment_request_id: 'PR-1', status: 'payment-included' });
    expect((await createApp(rtWith(new StubHspRail('x')), 'http://127.0.0.1:8402').request('/hsp/webhook', { method: 'POST', body: raw })).status).toBe(404);
    const rail = merchant();
    const app = createApp(rtWith(rail), 'http://127.0.0.1:8402');
    const ok = await app.request('/hsp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signWebhook(raw, 's') }, body: raw });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ code: 0 });
    expect(rail.lastWebhook('PR-1')?.status).toBe('payment-included');
    const bad = await app.request('/hsp/webhook', { method: 'POST', headers: { 'x-signature': signWebhook(raw, 'other') }, body: raw });
    expect(bad.status).toBe(401);
    const unsigned = await app.request('/hsp/webhook', { method: 'POST', body: raw });
    expect(unsigned.status).toBe(401);
  });

  it('/api/hsp with the stub answers a finished, SIMULATED job; the job can be read back', async () => {
    const app = createApp(rtWith(new StubHspRail('waiting for creds')), 'http://127.0.0.1:8402');
    const headers = { host: '127.0.0.1:8402', 'content-type': 'application/json' };
    const r = await app.request('http://127.0.0.1:8402/api/hsp', { method: 'POST', headers, body: JSON.stringify({ text: 'hello' }) });
    const job = await r.json();
    expect(job.done).toBe(true);
    expect(job.steps.map((s: { step: string }) => s.step)).toEqual(['hsp_order', 'hsp_payment']);
    expect(job.steps[0].title).toMatch(/SIMULATED: waiting for creds/);
    const again = await (await app.request(`http://127.0.0.1:8402/api/hsp/${job.id}`, { headers })).json();
    expect(again.done).toBe(true);
    expect((await app.request('http://127.0.0.1:8402/api/hsp/nope', { headers })).status).toBe(404);
  });
});

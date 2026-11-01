import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNetwork } from '../src/config.js';
import { createRuntime, facilitatorReadiness, pickFacilitator, type Readiness } from '../src/runtime.js';
import { listen } from './helpers.js';

/** The owner's condition for the mainnet runs: start only while /health/ready does not mark hashkey down. */

const report = (hashkey: Record<string, unknown>) => ({
  status: 'down',
  networks: [
    { network: 'base', caip2: 'eip155:8453', mainnet: true, status: 'ok' },
    { network: 'hashkey', caip2: 'eip155:177', mainnet: true, ...hashkey },
    { network: 'hashkey-testnet', caip2: 'eip155:133', mainnet: false, status: 'degraded' },
  ],
});

describe('facilitatorReadiness reads the per-network entry of /health/ready', () => {
  let current: unknown = {};
  let srv: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    const app = new Hono();
    // the real endpoint answers 503 as soon as any network is down
    app.get('/health/ready', (c) => c.json(current as object, 503));
    srv = await listen(app);
  });
  afterAll(() => srv.close());

  it('down (signer without gas) is not ready, with the reason', async () => {
    current = report({ status: 'down', reason: 'signer_gas_critical' });
    const r = await facilitatorReadiness(srv.url, getNetwork('hashkey'));
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('signer_gas_critical');
  });

  it('ok or degraded is ready, even when another network makes the whole report 503', async () => {
    current = report({ status: 'ok' });
    expect((await facilitatorReadiness(srv.url, getNetwork('hashkey'))).ready).toBe(true);
    expect((await facilitatorReadiness(srv.url, getNetwork('hashkey-testnet'))).ready).toBe(true);
  });

  it('a network missing from the report, a malformed body or a dead host are not ready', async () => {
    current = { networks: [{ network: 'base', caip2: 'eip155:8453', status: 'ok' }] };
    expect((await facilitatorReadiness(srv.url, getNetwork('hashkey'))).ready).toBe(false);
    current = { networks: 'nope' };
    expect((await facilitatorReadiness(srv.url, getNetwork('hashkey'))).ready).toBe(false);
    expect((await facilitatorReadiness('http://127.0.0.1:9', getNetwork('hashkey'))).ready).toBe(false);
  });
});

describe('pickFacilitator', () => {
  const up: Readiness = { ready: true, reason: 'ok' };
  const down: Readiness = { ready: false, reason: 'eip155:177 is down (signer_gas_critical)' };
  const url = 'https://facilitator.ultravioletadao.xyz';
  const mainnet = getNetwork('hashkey');
  const testnet = getNetwork('hashkey-testnet');

  it('mainnet settles only through a production facilitator that lists the network and is up', () => {
    expect(pickFacilitator(mainnet, 'auto', { url, supports: true, readiness: up })).toBe('remote');
    expect(pickFacilitator(mainnet, 'remote', { url, supports: true, readiness: up })).toBe('remote');
    expect(() => pickFacilitator(mainnet, 'auto', { url, supports: true, readiness: down })).toThrow(/not ready.*signer_gas_critical/);
    expect(() => pickFacilitator(mainnet, 'remote', { url, supports: true, readiness: down })).toThrow(/not ready/);
    expect(() => pickFacilitator(mainnet, 'auto', { url, supports: false, readiness: up })).toThrow(/only/);
    expect(() => pickFacilitator(mainnet, 'local', { url, supports: true, readiness: up })).toThrow(/only/);
  });

  it('testnet auto falls back to the local double while production is down; explicit modes are kept', () => {
    expect(pickFacilitator(testnet, 'auto', { url, supports: true, readiness: up })).toBe('remote');
    expect(pickFacilitator(testnet, 'auto', { url, supports: true, readiness: down })).toBe('local');
    expect(pickFacilitator(testnet, 'auto', { url, supports: false, readiness: up })).toBe('local');
    expect(pickFacilitator(testnet, 'remote', { url, supports: true, readiness: down })).toBe('remote');
    expect(pickFacilitator(testnet, 'local', { url, supports: true, readiness: up })).toBe('local');
  });
});

describe('mainnet needs the receipts contract before anything is paid', () => {
  const names = ['MAINNET_OWNER_OK', 'RECEIPTS_ADDRESS_MAINNET', 'OPERATOR_PRIVATE_KEY', 'BUYER_PRIVATE_KEY'] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterAll(() => {
    for (const n of names) saved[n] === undefined ? delete process.env[n] : (process.env[n] = saved[n]);
  });

  it('refuses without RECEIPTS_ADDRESS_MAINNET, before reading keys or calling the facilitator', async () => {
    process.env.MAINNET_OWNER_OK = 'yes';
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.BUYER_PRIVATE_KEY;
    process.env.RECEIPTS_ADDRESS_MAINNET = '';
    await expect(createRuntime('hashkey')).rejects.toThrow(/RECEIPTS_ADDRESS_MAINNET/);
    // with the address set it gets past that check (and stops at the missing keys, still offline)
    process.env.RECEIPTS_ADDRESS_MAINNET = '0x00000000000000000000000000000000000000aa';
    await expect(createRuntime('hashkey')).rejects.toThrow(/OPERATOR_PRIVATE_KEY/);
  });
});

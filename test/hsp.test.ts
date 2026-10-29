import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { StubHspRail, createHspRail } from '../src/rails/hsp.js';

describe('HSP rail', () => {
  it('without credentials it is a stub that never says ACCEPT', async () => {
    const rail = await createHspRail(undefined, {});
    expect(rail.mode).toBe('stub');
    expect(rail.reason).toMatch(/credentials/);
    const p = await rail.pay({ to: '0x2222222222222222222222222222222222222222', amount: 100_000n });
    expect(p.simulated).toBe(true);
    const v = await rail.verify(p.paymentId);
    expect(v.outcomeClass).toBe('SIMULATED');
    expect(v.ok).toBe(false);
  });
  it('with credentials but no installed SDK it stays a stub and says why', async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const rail = await createHspRail(acct, { coordinatorUrl: 'https://coordinator.invalid', apiKey: 'k' });
    expect(rail).toBeInstanceOf(StubHspRail);
    expect(rail.reason).toMatch(/@hsp\/sdk is not installed/);
  });
  it('with credentials but no buyer key it stays a stub', async () => {
    const rail = await createHspRail(undefined, { coordinatorUrl: 'https://coordinator.invalid', apiKey: 'k' });
    expect(rail.reason).toMatch(/no testnet buyer key/);
  });
});

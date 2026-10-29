import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FileLedger, MemoryLedger, SpendDeniedError, SpendGuard, fmtUsdc, utcDay } from '../src/spend-guard.js';

const at = (iso: string) => () => new Date(iso);

describe('SpendGuard', () => {
  it('uses the brief caps: 0.50 USDC per tx, 5 USDC per day', () => {
    expect(DEFAULT_POLICY).toEqual({ perTxCap: 500_000n, dailyCap: 5_000_000n });
  });

  it('allows exactly the per-tx cap and denies one atomic unit more', () => {
    const g = new SpendGuard();
    expect(g.check(500_000n).allowed).toBe(true);
    const d = g.check(500_001n);
    expect(d.allowed).toBe(false);
    expect(d.code).toBe('PER_TX_CAP');
  });

  it('denies the 2 USDC premium task before anything is booked', () => {
    const ledger = new MemoryLedger();
    const g = new SpendGuard(DEFAULT_POLICY, ledger);
    expect(() => g.authorize(2_000_000n, 'premium')).toThrow(SpendDeniedError);
    expect(g.spentToday()).toBe(0n);
  });

  it('rejects zero and negative amounts', () => {
    const g = new SpendGuard();
    expect(g.check(0n).code).toBe('INVALID_AMOUNT');
    expect(g.check(-1n).code).toBe('INVALID_AMOUNT');
  });

  it('books on authorize and enforces the daily cap at the boundary', () => {
    const g = new SpendGuard(DEFAULT_POLICY, new MemoryLedger(), at('2026-10-30T12:00:00Z'));
    for (let i = 0; i < 10; i++) g.authorize(500_000n, `t${i}`); // exactly 5.00
    expect(g.spentToday()).toBe(5_000_000n);
    let err: unknown;
    try {
      g.authorize(1n, 'one-more');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SpendDeniedError);
    expect((err as SpendDeniedError).code).toBe('DAILY_CAP');
    expect(g.spentToday()).toBe(5_000_000n);
  });

  it('starts a new day at UTC midnight', () => {
    const ledger = new MemoryLedger();
    new SpendGuard(DEFAULT_POLICY, ledger, at('2026-10-30T23:59:59Z')).authorize(500_000n, 'late');
    const nextDay = new SpendGuard(DEFAULT_POLICY, ledger, at('2026-10-31T00:00:00Z'));
    expect(nextDay.spentToday()).toBe(0n);
    expect(utcDay(new Date('2026-10-30T23:59:59-04:00'))).toBe('2026-10-31');
  });

  it('persists across restarts with the file ledger', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentsettle-')), 'nested', 'spend.json');
    const now = at('2026-10-30T10:00:00Z');
    new SpendGuard(DEFAULT_POLICY, new FileLedger(path), now).authorize(400_000n, 'a');
    const again = new SpendGuard(DEFAULT_POLICY, new FileLedger(path), now);
    expect(again.spentToday()).toBe(400_000n);
    expect(JSON.parse(readFileSync(path, 'utf8'))['2026-10-30']).toHaveLength(1);
  });

  it('refuses non-positive policies', () => {
    expect(() => new SpendGuard({ perTxCap: 0n, dailyCap: 1n })).toThrow();
  });

  it('formats atomic USDC', () => {
    expect(fmtUsdc(100_000n)).toBe('0.10');
    expect(fmtUsdc(2_000_000n)).toBe('2.00');
    expect(fmtUsdc(500_001n)).toBe('0.500001');
    expect(fmtUsdc(0n)).toBe('0.00');
  });
});

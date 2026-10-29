import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { USDC } from './config.js';

/**
 * Buyer-side spend caps, the same policy shape as HSP's SpendGuard and PayBox: a per-transaction cap and a
 * daily cap (UTC day), both in atomic USDC units. A spend is booked when the buyer SIGNS, not when the
 * seller settles: a signed EIP-3009 authorization can be settled by whoever holds it, so the exposure
 * starts at signature time.
 */
export interface SpendPolicy {
  perTxCap: bigint;
  dailyCap: bigint;
}

export const DEFAULT_POLICY: SpendPolicy = { perTxCap: USDC(0.5), dailyCap: USDC(5) };

export type DenialCode = 'INVALID_AMOUNT' | 'PER_TX_CAP' | 'DAILY_CAP';

export class SpendDeniedError extends Error {
  constructor(
    readonly code: DenialCode,
    message: string,
    readonly amount: bigint,
    readonly spentToday: bigint,
  ) {
    super(message);
    this.name = 'SpendDeniedError';
  }
}

export interface SpendEntry {
  at: string;
  amount: string;
  ref: string;
}

/** Where booked spends live. Sync on purpose: check + book must not interleave with another await. */
export interface SpendLedger {
  entries(day: string): SpendEntry[];
  append(day: string, entry: SpendEntry): void;
  /** Runs check + book as one unit (FileLedger: under a lock file, across processes). */
  atomically<T>(fn: () => T): T;
}

export class MemoryLedger implements SpendLedger {
  private readonly days = new Map<string, SpendEntry[]>();
  entries(day: string): SpendEntry[] {
    return [...(this.days.get(day) ?? [])];
  }
  append(day: string, entry: SpendEntry): void {
    this.days.set(day, [...(this.days.get(day) ?? []), entry]);
  }
  atomically<T>(fn: () => T): T {
    return fn();
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** JSON file ledger (data/spend-ledger.json by default; scripts/reset.sh clears it). */
export class FileLedger implements SpendLedger {
  constructor(private readonly path: string) {}

  private read(): Record<string, SpendEntry[]> {
    if (!existsSync(this.path)) return {};
    const raw = readFileSync(this.path, 'utf8').trim();
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`spend ledger ${this.path} is not a JSON object`);
    }
    return parsed as Record<string, SpendEntry[]>;
  }

  entries(day: string): SpendEntry[] {
    return this.read()[day] ?? [];
  }

  append(day: string, entry: SpendEntry): void {
    const all = this.read();
    all[day] = [...(all[day] ?? []), entry];
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  /** `pnpm demo` and `pnpm start` may share this file: an O_EXCL lock file makes check + book one unit across them. */
  atomically<T>(fn: () => T, opts: { waitMs?: number; staleMs?: number } = {}): T {
    const lock = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true });
    const deadline = Date.now() + (opts.waitMs ?? 5_000);
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          // a crashed holder leaves the file behind; a check + book takes milliseconds
          if (Date.now() - statSync(lock).mtimeMs > (opts.staleMs ?? 10_000)) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue; // the holder released it between our two calls
        }
        if (Date.now() > deadline) throw new Error(`spend ledger is locked by another process: ${lock}`);
        sleepSync(20);
      }
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }
}

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export interface SpendDecision {
  allowed: boolean;
  code?: DenialCode;
  reason?: string;
  amount: bigint;
  spentToday: bigint;
  remainingToday: bigint;
  policy: SpendPolicy;
}

export class SpendGuard {
  constructor(
    readonly policy: SpendPolicy = DEFAULT_POLICY,
    private readonly ledger: SpendLedger = new MemoryLedger(),
    private readonly now: () => Date = () => new Date(),
  ) {
    if (policy.perTxCap <= 0n || policy.dailyCap <= 0n) throw new Error('spend caps must be positive');
  }

  spentToday(): bigint {
    return this.ledger.entries(utcDay(this.now())).reduce((sum, e) => sum + BigInt(e.amount), 0n);
  }

  /** Pure check: would `amount` be allowed right now? */
  check(amount: bigint): SpendDecision {
    const spentToday = this.spentToday();
    const remainingToday = this.policy.dailyCap > spentToday ? this.policy.dailyCap - spentToday : 0n;
    const base = { amount, spentToday, remainingToday, policy: this.policy };
    if (amount <= 0n) {
      return { ...base, allowed: false, code: 'INVALID_AMOUNT', reason: `amount must be positive, got ${amount}` };
    }
    if (amount > this.policy.perTxCap) {
      return {
        ...base,
        allowed: false,
        code: 'PER_TX_CAP',
        reason: `${fmtUsdc(amount)} USDC is over the per-transaction cap of ${fmtUsdc(this.policy.perTxCap)} USDC`,
      };
    }
    if (spentToday + amount > this.policy.dailyCap) {
      return {
        ...base,
        allowed: false,
        code: 'DAILY_CAP',
        reason: `${fmtUsdc(amount)} USDC would exceed the daily cap of ${fmtUsdc(this.policy.dailyCap)} USDC (spent today: ${fmtUsdc(spentToday)})`,
      };
    }
    return { ...base, allowed: true };
  }

  /** Check and book in one synchronous step. Throws SpendDeniedError when the policy says no. */
  authorize(amount: bigint, ref: string): SpendDecision {
    return this.ledger.atomically(() => {
      const decision = this.check(amount);
      if (!decision.allowed) {
        throw new SpendDeniedError(decision.code!, decision.reason!, amount, decision.spentToday);
      }
      const now = this.now();
      this.ledger.append(utcDay(now), { at: now.toISOString(), amount: amount.toString(), ref });
      return { ...decision, spentToday: decision.spentToday + amount, remainingToday: decision.remainingToday - amount };
    });
  }
}

/** 100000n -> "0.10" (at least two decimals, trailing zeros beyond that trimmed). */
export function fmtUsdc(atomic: bigint): string {
  const neg = atomic < 0n;
  const abs = neg ? -atomic : atomic;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** scripts/set-env-var.py, used by deploy.sh: .env holds the only copy of the agent keys, so it is replaced atomically. */
const setVar = (path: string, name: string, value: string) => spawnSync('python3', ['scripts/set-env-var.py', path, name, value], { encoding: 'utf8' });

describe('deploy.sh writes .env atomically', () => {
  it('replaces the variable, keeps every other line, leaves mode 600 and no temp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsettle-env-'));
    const env = join(dir, '.env');
    writeFileSync(env, 'OPERATOR_PRIVATE_KEY=keep-me\nRECEIPTS_ADDRESS_MAINNET=\nBUYER_PRIVATE_KEY=keep-me-too\n', { mode: 0o644 });
    expect(setVar(env, 'RECEIPTS_ADDRESS_MAINNET', '0x1111111111111111111111111111111111111111').status).toBe(0);
    expect(readFileSync(env, 'utf8')).toBe('OPERATOR_PRIVATE_KEY=keep-me\nRECEIPTS_ADDRESS_MAINNET=0x1111111111111111111111111111111111111111\nBUYER_PRIVATE_KEY=keep-me-too\n');
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['.env']);
    expect(setVar(env, 'RECEIPTS_ADDRESS_TESTNET', '0x2222222222222222222222222222222222222222').status).toBe(0);
    expect(readFileSync(env, 'utf8')).toMatch(/BUYER_PRIVATE_KEY=keep-me-too\nRECEIPTS_ADDRESS_TESTNET=0x2222222222222222222222222222222222222222\n$/);
  });

  it('refuses a malformed name or a value with a newline, and leaves the file as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsettle-env-'));
    const env = join(dir, '.env');
    writeFileSync(env, 'A=1\n');
    expect(setVar(env, 'bad name', 'x').status).not.toBe(0);
    expect(setVar(env, 'A', 'x\nB=2').status).not.toBe(0);
    expect(readFileSync(env, 'utf8')).toBe('A=1\n');
  });
});

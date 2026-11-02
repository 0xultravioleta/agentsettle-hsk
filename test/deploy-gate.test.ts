import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DEPLOYED = '0xb8956dFe5819b9828b6D55315bFB871c443f08a1';
const noKeys = (rest: string) => `OPERATOR_PRIVATE_KEY=\nBUYER_PRIVATE_KEY=\nTESTNET_OPERATOR_PRIVATE_KEY=\n${rest}`;

/**
 * Runs a copy of scripts/deploy.sh with an .env that holds no key. node, cast, forge and curl are stubs that only write
 * down that they were called, so every case here ends before any network call: no deploy and no transaction.
 */
function deploy(dotEnv: string, args: string[], callerOk?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsettle-deploy-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync('scripts/deploy.sh', join(dir, 'scripts', 'deploy.sh'));
  writeFileSync(join(dir, '.env'), dotEnv);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const tool of ['node', 'cast', 'forge', 'curl']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${join(dir, 'called')}"\nexit 97\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir };
  if (callerOk !== undefined) env.MAINNET_OWNER_OK = callerOk;
  const r = spawnSync('bash', [join(dir, 'scripts', 'deploy.sh'), ...args], { env, encoding: 'utf8' });
  const called = join(dir, 'called');
  return { status: r.status, stderr: r.stderr, called: existsSync(called) ? readFileSync(called, 'utf8') : '', dotEnvAfter: readFileSync(join(dir, '.env'), 'utf8') };
}

describe('deploy.sh on mainnet: the OK comes from the caller, and the deployed contract is not replaced by accident', () => {
  it('a MAINNET_OWNER_OK=yes line in .env does not open the gate, and only an exact "yes" from the caller does', () => {
    for (const caller of [undefined, '', 'YES', ' yes', 'true']) {
      const r = deploy(noKeys('MAINNET_OWNER_OK=yes\nRECEIPTS_ADDRESS_MAINNET=\n'), ['hashkey'], caller);
      expect(r.status, `caller ${JSON.stringify(caller)}`).toBe(1);
      expect(r.stderr).toMatch(/refusing to deploy on HashKey mainnet: set MAINNET_OWNER_OK=yes/);
      expect(r.called).toBe('');
    }
  });

  it('refuses while .env already holds RECEIPTS_ADDRESS_MAINNET, and leaves .env as it was', () => {
    const dotEnv = noKeys(`RECEIPTS_ADDRESS_MAINNET=${DEPLOYED}\n`);
    const r = deploy(dotEnv, ['hashkey'], 'yes');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`RECEIPTS_ADDRESS_MAINNET is already ${DEPLOYED} in .env`);
    expect(r.called).toBe('');
    expect(r.dotEnvAfter).toBe(dotEnv);
  });

  it('--redeploy, or a first deploy, gets past both gates (and stops at the empty key, still offline)', () => {
    const cases: Array<[string, string[]]> = [
      [noKeys(`RECEIPTS_ADDRESS_MAINNET=${DEPLOYED}\n`), ['hashkey', '--redeploy']],
      [noKeys('RECEIPTS_ADDRESS_MAINNET=\n'), ['hashkey']],
    ];
    for (const [dotEnv, args] of cases) {
      const r = deploy(dotEnv, args, 'yes');
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^OPERATOR_PRIVATE_KEY is empty in \.env$/m);
      expect(r.called).toBe('');
    }
  });

  it('testnet is not gated by its recorded address, and an unknown flag is refused', () => {
    const t = deploy(noKeys('RECEIPTS_ADDRESS_TESTNET=0xaE84CA772f0ECA0Af6A79bEd82270Bb41F1A6Df1\n'), ['hashkey-testnet']);
    expect(t.stderr).toMatch(/^TESTNET_OPERATOR_PRIVATE_KEY is empty in \.env$/m);
    for (const flag of ['--force', '--re', '--redeploy=1', '--REDEPLOY']) {
      const u = deploy(noKeys(`RECEIPTS_ADDRESS_MAINNET=${DEPLOYED}\n`), ['hashkey', flag], 'yes');
      expect(u.status, flag).toBe(1);
      expect(u.stderr).toMatch(/^usage: scripts\/deploy\.sh hashkey-testnet\|ethereum-sepolia\|hashkey \[--redeploy\]$/m);
      expect(u.called).toBe('');
    }
    expect(t.called).toBe('');
  });

  it('ethereum-sepolia is a testnet: no mainnet OK needed, its own address var, and it stops at the empty testnet key', () => {
    for (const caller of [undefined, '']) {
      const r = deploy(noKeys('RECEIPTS_ADDRESS_ETH_SEPOLIA=0x00000000000000000000000000000000000000aa\n'), ['ethereum-sepolia'], caller);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^TESTNET_OPERATOR_PRIVATE_KEY is empty in \.env$/m);
      expect(r.stderr).not.toMatch(/refusing/);
      expect(r.called).toBe('');
    }
  });

  it('a line in .env cannot set the script\'s own CALLER_OWNER_OK, REDEPLOY or NET: it stops there', () => {
    const cases: Array<[string, string | undefined]> = [
      ['RECEIPTS_ADDRESS_MAINNET=\nCALLER_OWNER_OK=yes\n', undefined],
      [`RECEIPTS_ADDRESS_MAINNET=${DEPLOYED}\nREDEPLOY=1\n`, 'yes'],
      [`RECEIPTS_ADDRESS_MAINNET=${DEPLOYED}\nNET=hashkey-testnet\n`, 'yes'],
    ];
    for (const [rest, caller] of cases) {
      const r = deploy(noKeys(rest), ['hashkey'], caller);
      expect(r.status, rest).toBe(1);
      expect(r.stderr).toMatch(/: (CALLER_OWNER_OK|REDEPLOY|NET): readonly variable$/m);
      expect(r.stderr).not.toMatch(/PRIVATE_KEY is empty/);
      expect(r.called).toBe('');
    }
  });
});

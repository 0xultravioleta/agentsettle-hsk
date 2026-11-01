import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { accountFromEnv } from '../src/accounts.js';
import { assertMainnetAllowed, explorerTx, getNetwork, loadDotEnv, parseNetworkName } from '../src/config.js';

const env0 = { ...process.env };
afterEach(() => {
  process.env = { ...env0 };
});

describe('config', () => {
  it('parses network names with case and spaces, defaults to local', () => {
    expect(parseNetworkName(' HashKey-Testnet ')).toBe('hashkey-testnet');
    expect(parseNetworkName(undefined)).toBe('local');
    expect(() => parseNetworkName('base')).toThrow();
  });

  it('chain ids and explorer links match the brief', () => {
    expect(getNetwork('hashkey').chainId).toBe(177);
    expect(getNetwork('hashkey-testnet').chainId).toBe(133);
    expect(explorerTx(getNetwork('hashkey'), '0xabc')).toBe('https://explorer.hsk.xyz/tx/0xabc');
    expect(explorerTx(getNetwork('local'), '0xabc')).toBeUndefined();
  });

  it('refuses mainnet unless MAINNET_OWNER_OK is exactly "yes"', () => {
    delete process.env.MAINNET_OWNER_OK;
    expect(() => assertMainnetAllowed(getNetwork('hashkey'))).toThrow(/refusing/);
    process.env.MAINNET_OWNER_OK = 'YES please';
    expect(() => assertMainnetAllowed(getNetwork('hashkey'))).toThrow(/refusing/);
    process.env.MAINNET_OWNER_OK = 'yes';
    expect(() => assertMainnetAllowed(getNetwork('hashkey'))).not.toThrow();
    delete process.env.MAINNET_OWNER_OK;
    expect(() => assertMainnetAllowed(getNetwork('hashkey-testnet'))).not.toThrow();
  });

  it('.env never grants the mainnet OK: MAINNET_OWNER_OK comes only from the caller', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentsettle-dotenv-')), '.env');
    writeFileSync(path, 'MAINNET_OWNER_OK=yes\nAGENTSETTLE_DOTENV_PROBE=from-file\n');
    delete process.env.MAINNET_OWNER_OK;
    delete process.env.AGENTSETTLE_DOTENV_PROBE;
    loadDotEnv(path);
    expect(process.env.AGENTSETTLE_DOTENV_PROBE).toBe('from-file');
    expect(process.env.MAINNET_OWNER_OK).toBeUndefined();
    expect(() => assertMainnetAllowed(getNetwork('hashkey'))).toThrow(/refusing/);
    // what the caller set wins, as with process.loadEnvFile
    process.env.AGENTSETTLE_DOTENV_PROBE = 'from-caller';
    process.env.MAINNET_OWNER_OK = 'yes';
    loadDotEnv(path);
    expect(process.env.AGENTSETTLE_DOTENV_PROBE).toBe('from-caller');
    expect(() => assertMainnetAllowed(getNetwork('hashkey'))).not.toThrow();
    // an empty value from the caller is still the caller's: .env fills neither the OK nor any other key
    process.env.AGENTSETTLE_DOTENV_PROBE = '';
    process.env.MAINNET_OWNER_OK = '';
    loadDotEnv(path);
    expect(process.env.AGENTSETTLE_DOTENV_PROBE).toBe('');
    expect(process.env.MAINNET_OWNER_OK).toBe('');
    expect(() => assertMainnetAllowed(getNetwork('hashkey'))).toThrow(/refusing/);
  });

  it('.env cannot slip the OK in with another case of the name (process.env ignores case on Windows)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentsettle-dotenv-')), '.env');
    writeFileSync(path, 'mainnet_owner_ok=yes\nMainnet_Owner_Ok=yes\nAGENTSETTLE_DOTENV_PROBE=from-file\n');
    delete process.env.MAINNET_OWNER_OK;
    delete process.env.AGENTSETTLE_DOTENV_PROBE;
    loadDotEnv(path);
    expect(process.env.AGENTSETTLE_DOTENV_PROBE).toBe('from-file');
    expect(process.env.mainnet_owner_ok).toBeUndefined();
    expect(process.env.Mainnet_Owner_Ok).toBeUndefined();
    expect(() => assertMainnetAllowed(getNetwork('hashkey'))).toThrow(/refusing/);
  });

  it('rejects a malformed receipts address from env', () => {
    process.env.RECEIPTS_ADDRESS_TESTNET = '0x123';
    expect(() => getNetwork('hashkey-testnet')).toThrow(/RECEIPTS_ADDRESS_TESTNET/);
  });
});

describe('accounts', () => {
  it('accepts 0x, 0X and bare hex keys and never echoes the key in errors', () => {
    const key = generatePrivateKey();
    const addr = privateKeyToAccount(key).address;
    for (const v of [key, `0X${key.slice(2)}`, key.slice(2), ` ${key} `]) {
      process.env.K = v;
      expect(accountFromEnv('K')?.address).toBe(addr);
    }
    process.env.K = key.slice(0, 40); // valid hex, wrong length: our message, not viem's (which may echo the input)
    expect(() => accountFromEnv('K')).toThrow(/^K is not a 32-byte hex private key$/);
    process.env.K = `${key.slice(0, 40)}zz`;
    expect(() => accountFromEnv('K')).toThrow(/^K is not/);
    try {
      accountFromEnv('K');
    } catch (e) {
      expect(String(e)).not.toContain(key.slice(2, 40));
    }
    process.env.K = '';
    expect(accountFromEnv('K')).toBeUndefined();
  });
});

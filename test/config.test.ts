import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { accountFromEnv } from '../src/accounts.js';
import { assertMainnetAllowed, explorerTx, getNetwork, parseNetworkName } from '../src/config.js';

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

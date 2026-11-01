import { privateKeyToAccount } from 'viem/accounts';
import { isHex, type LocalAccount } from 'viem';
import { keyEnvNames, type NetworkName } from './config.js';

/** Reads an agent key from the environment. The key is never logged; errors name the variable, not the value. */
export function accountFromEnv(varName: string): LocalAccount | undefined {
  const raw = process.env[varName]?.trim();
  if (!raw) return undefined;
  const key = raw.startsWith('0x') || raw.startsWith('0X') ? `0x${raw.slice(2)}` : `0x${raw}`;
  if (!isHex(key) || key.length !== 66) throw new Error(`${varName} is not a 32-byte hex private key`);
  return privateKeyToAccount(key as `0x${string}`);
}

export function agentAccounts(name: NetworkName): { operator?: LocalAccount; buyer?: LocalAccount } {
  const names = keyEnvNames(name);
  return { operator: accountFromEnv(names.operator), buyer: accountFromEnv(names.buyer) };
}

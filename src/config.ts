import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { getAddress, isAddress, type Address } from 'viem';

/**
 * Networks the demo runs on. `local` is anvil with the EIP-3009 mock (offline, CI and rehearsal). `base-sepolia` is
 * only the fallback chain for HSP Agentic Payment (HSP_MCP_NETWORK), never a `--network` of the demo.
 */
export type NetworkName = 'hashkey' | 'hashkey-testnet' | 'local' | 'base-sepolia';

export interface UsdcToken {
  address: Address;
  decimals: 6;
  /** EIP-712 domain of the token, checked against DOMAIN_SEPARATOR on-chain (brief §2). */
  eip712: { name: string; version: string };
}

export interface NetworkConfig {
  name: NetworkName;
  chainId: number;
  caip2: `eip155:${number}`;
  rpcUrl: string;
  /** Blockscout base URL; undefined for the local chain. */
  explorer?: string;
  usdc: UsdcToken;
  receiptsAddress?: Address;
  mainnet: boolean;
}

/** Atomic USDC units (6 decimals). */
export const USDC = (whole: number): bigint => BigInt(Math.round(whole * 1_000_000));

/** Price of one translate task: 0.10 USDC (brief §6.B flow 1). */
export const TASK_PRICE = USDC(0.1);
/** Price of the "premium" task the spend guard must refuse in the demo (video script 1:45). */
export const PREMIUM_TASK_PRICE = USDC(2);

const env = (key: string): string | undefined => {
  const v = process.env[key]?.trim();
  return v ? v : undefined;
};

const optionalAddress = (key: string): Address | undefined => {
  const v = env(key);
  if (!v) return undefined;
  if (!isAddress(v, { strict: false })) throw new Error(`${key} is not an address: ${v}`);
  return getAddress(v);
};

/**
 * Loads .env from the repo root when present, like process.loadEnvFile: what the caller already set wins. The one
 * exception is MAINNET_OWNER_OK, which comes only from the caller's environment: a line in .env never grants it.
 */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (k !== 'MAINNET_OWNER_OK' && process.env[k] === undefined) process.env[k] = v;
  }
}

export function getNetwork(name: NetworkName, overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  switch (name) {
    case 'hashkey':
      return {
        name,
        chainId: 177,
        caip2: 'eip155:177',
        rpcUrl: env('HASHKEY_RPC_URL') ?? 'https://mainnet.hsk.xyz',
        explorer: 'https://explorer.hsk.xyz',
        usdc: {
          address: '0x054ed45810DbBAb8B27668922D110669c9D88D0a',
          decimals: 6,
          // DOMAIN_SEPARATOR 0x78101f50…259d recomputed and matched on-chain (brief §2).
          eip712: { name: 'Bridged USDC', version: '2' },
        },
        receiptsAddress: optionalAddress('RECEIPTS_ADDRESS_MAINNET'),
        mainnet: true,
        ...overrides,
      };
    case 'hashkey-testnet':
      return {
        name,
        chainId: 133,
        caip2: 'eip155:133',
        rpcUrl: env('HASHKEY_TESTNET_RPC_URL') ?? 'https://testnet.hsk.xyz',
        // testnet-explorer.hsk.xyz (brief §2) did not resolve on 2026-10-29; this host answers.
        explorer: 'https://testnet-explorer.hskchain.net',
        usdc: {
          // The HSP sandbox pinned token. DOMAIN_SEPARATOR 0x4b73b8fe…1d09 re-checked on 2026-10-29.
          address: '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6',
          decimals: 6,
          eip712: { name: 'USD Coin', version: '2' },
        },
        receiptsAddress: optionalAddress('RECEIPTS_ADDRESS_TESTNET'),
        mainnet: false,
        ...overrides,
      };
    case 'base-sepolia':
      return {
        name,
        chainId: 84532,
        caip2: 'eip155:84532',
        rpcUrl: env('BASE_SEPOLIA_RPC_URL') ?? 'https://sepolia.base.org',
        explorer: 'https://sepolia.basescan.org',
        usdc: {
          // Circle's testnet USDC, the eip3009 token HSP's get_chain_config lists on 84532.
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          decimals: 6,
          eip712: { name: 'USDC', version: '2' },
        },
        receiptsAddress: optionalAddress('RECEIPTS_ADDRESS_BASE_SEPOLIA'),
        mainnet: false,
        ...overrides,
      };
    case 'local':
      return {
        name,
        chainId: 31337,
        caip2: 'eip155:31337',
        rpcUrl: env('LOCAL_RPC_URL') ?? 'http://127.0.0.1:8545',
        usdc: {
          // Filled in by the local setup (src/local-chain.ts) after it deploys MockEIP3009.
          address: '0x0000000000000000000000000000000000000000',
          decimals: 6,
          eip712: { name: 'USD Coin', version: '2' },
        },
        mainnet: false,
        ...overrides,
      };
  }
}

export function parseNetworkName(value: string | undefined): NetworkName {
  const v = (value ?? 'local').trim().toLowerCase();
  if (v === 'hashkey' || v === 'hashkey-testnet' || v === 'local') return v;
  throw new Error(`unknown network "${value}" (use local, hashkey-testnet or hashkey)`);
}

export function explorerTx(net: NetworkConfig, hash: string): string | undefined {
  return net.explorer ? `${net.explorer}/tx/${hash}` : undefined;
}

export function explorerAddress(net: NetworkConfig, address: string): string | undefined {
  return net.explorer ? `${net.explorer}/address/${address}` : undefined;
}

/** Env var names of the two agent keys per network (values live only in .env). */
export function keyEnvNames(name: NetworkName): { operator: string; buyer: string } {
  if (name === 'hashkey') return { operator: 'OPERATOR_PRIVATE_KEY', buyer: 'BUYER_PRIVATE_KEY' };
  // the testnet wallets (W5, W6) are the same keys on Base Sepolia, the HSP fallback chain
  if (name === 'hashkey-testnet' || name === 'base-sepolia') return { operator: 'TESTNET_OPERATOR_PRIVATE_KEY', buyer: 'TESTNET_BUYER_PRIVATE_KEY' };
  return { operator: 'LOCAL_OPERATOR_PRIVATE_KEY', buyer: 'LOCAL_BUYER_PRIVATE_KEY' };
}

/**
 * Mainnet guard: nothing touches chain 177 unless the owner approved it with the exact amount and
 * MAINNET_OWNER_OK=yes is set for that run.
 */
export function assertMainnetAllowed(net: NetworkConfig): void {
  if (net.mainnet && env('MAINNET_OWNER_OK') !== 'yes') {
    throw new Error(
      'refusing to run on HashKey mainnet: set MAINNET_OWNER_OK=yes only after the owner approved the exact amount',
    );
  }
}

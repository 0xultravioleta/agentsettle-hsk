import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HspSecrets } from './rails/hsp.js';

/**
 * HSP secrets live in AWS SSM Parameter Store (SecureString), never in the repo, .env or on screen:
 *   <prefix>/merchant-private-key   secp256k1 PKCS8 PEM (signs merchant_authorization)
 *   <prefix>/app-key, <prefix>/app-secret   from the HashKey Merchant console (HMAC)
 */
export const DEFAULT_HSP_SSM_PREFIX = '/agentsettle-hsk/hsp';
export const HSP_SSM_KEYS = { merchantPrivateKey: 'merchant-private-key', appKey: 'app-key', appSecret: 'app-secret' } as const;

export interface SecretStore {
  getMany(names: string[]): Record<string, string | undefined>;
  /** Creates a SecureString; fails if the name already exists (never overwrites a key). */
  createSecure(name: string, value: string, description: string): void;
}

/** SSM through the aws CLI: secret values go in on stdin (`--value file:///dev/stdin`) and come back on a captured stdout. */
export class AwsSsmStore implements SecretStore {
  constructor(private readonly opts: { region?: string; run?: typeof spawnSync } = {}) {}

  private aws(args: string[], input?: string): string {
    const full = [...args, ...(this.opts.region ? ['--region', this.opts.region] : []), '--output', 'json'];
    const r = (this.opts.run ?? spawnSync)('aws', full, { input, encoding: 'utf8', timeout: 30_000 });
    if (r.error) throw new Error(`aws CLI unavailable: ${r.error.message}`);
    // stderr of a failed call names the error (e.g. ParameterAlreadyExists), never a value
    if (r.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr ?? '').trim().split('\n').pop()}`);
    return String(r.stdout ?? '');
  }

  getMany(names: string[]): Record<string, string | undefined> {
    const out = JSON.parse(this.aws(['ssm', 'get-parameters', '--names', ...names, '--with-decryption']) || '{}');
    const values: Record<string, string | undefined> = {};
    for (const p of out.Parameters ?? []) values[p.Name] = p.Value;
    return values;
  }

  createSecure(name: string, value: string, description: string): void {
    this.aws(['ssm', 'put-parameter', '--name', name, '--type', 'SecureString', '--description', description, '--value', 'file:///dev/stdin'], value);
  }
}

export function hspSsmPrefix(): string | undefined {
  const p = process.env.HSP_SSM_PREFIX?.trim() || DEFAULT_HSP_SSM_PREFIX;
  return p === 'off' ? undefined : p.replace(/\/+$/, '');
}

/** Reads the three HSP secrets. Never throws: a missing CLI, account or parameter just leaves fields undefined. */
export function loadHspSecrets(store: SecretStore, prefix: string): HspSecrets & { error?: string } {
  const names = Object.values(HSP_SSM_KEYS).map((k) => `${prefix}/${k}`);
  try {
    const v = store.getMany(names);
    return {
      merchantPrivateKeyPem: v[`${prefix}/${HSP_SSM_KEYS.merchantPrivateKey}`],
      appKey: v[`${prefix}/${HSP_SSM_KEYS.appKey}`],
      appSecret: v[`${prefix}/${HSP_SSM_KEYS.appSecret}`],
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export const publicPemOf = (privatePem: string) => createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();

/**
 * The merchant key pair for the HashKey Merchant registration. The private key goes straight into SSM and is read
 * back once to check it; only the public key (SPKI PEM) is written to `publicKeyPath` and returned. If the parameter
 * already exists it is reused, never overwritten, and its public key is written again.
 */
export function ensureMerchantKey(store: SecretStore, opts: { name: string; publicKeyPath: string }): { publicKeyPem: string; created: boolean } {
  let stored = store.getMany([opts.name])[opts.name];
  let created = false;
  if (!stored) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    store.createSecure(opts.name, privateKey, 'AgentSettle HSP (HashKey Merchant) merchant key: secp256k1 PKCS8 PEM, signs merchant_authorization');
    stored = store.getMany([opts.name])[opts.name];
    if (stored !== privateKey) throw new Error(`${opts.name} did not read back as written`);
    created = true;
  }
  if (createPrivateKey(stored).asymmetricKeyDetails?.namedCurve !== 'secp256k1') throw new Error(`${opts.name} is not a secp256k1 key`);
  const publicKeyPem = publicPemOf(stored);
  mkdirSync(dirname(opts.publicKeyPath), { recursive: true });
  writeFileSync(opts.publicKeyPath, publicKeyPem);
  return { publicKeyPem, created };
}

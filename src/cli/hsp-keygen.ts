import { loadDotEnv } from '../config.js';
import { AwsSsmStore, DEFAULT_HSP_SSM_PREFIX, HSP_SSM_KEYS, ensureMerchantKey, hspSsmPrefix } from '../hsp-secrets.js';

/**
 * pnpm hsp:keygen -- the HashKey Merchant key pair. Private key -> SSM SecureString (never printed, never on disk);
 * public key -> docs/hsp/merchant-public-key.pem for the registration (docs/hsp/REGISTRATION.md).
 */
loadDotEnv();
const prefix = hspSsmPrefix() ?? DEFAULT_HSP_SSM_PREFIX;
const name = `${prefix}/${HSP_SSM_KEYS.merchantPrivateKey}`;
const publicKeyPath = 'docs/hsp/merchant-public-key.pem';
const store = new AwsSsmStore({ region: process.env.AWS_REGION?.trim() || undefined });
const { publicKeyPem, created } = ensureMerchantKey(store, { name, publicKeyPath });
console.log(created ? `created SSM SecureString ${name}` : `${name} already exists: reused, not overwritten`);
console.log(`public key written to ${publicKeyPath}:\n\n${publicKeyPem}`);

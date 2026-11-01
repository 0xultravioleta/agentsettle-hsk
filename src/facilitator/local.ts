import { Hono } from 'hono';
import { getAddress, isAddress, isHex, parseSignature, verifyTypedData, type Address, type Hex, type LocalAccount } from 'viem';
import type { NetworkConfig } from '../config.js';
import { ERC20_EIP3009_ABI, publicClientFor, walletClientFor } from '../chain.js';
import { TRANSFER_WITH_AUTHORIZATION_TYPES, networkMatches, type Authorization, type PaymentRequirement } from '../rails/x402.js';

/**
 * Local dev facilitator: a stand-in for facilitator.ultravioletadao.xyz while production does not list HashKey.
 * Same wire shape as x402-rs (/verify and /settle take the v2 envelope uvd-x402-sdk sends; /settle answers
 * {success, transaction, network, payer}). It really settles: it broadcasts transferWithAuthorization from its
 * own gas wallet, so on hashkey-testnet the tx is real and lands on the explorer. One network per instance.
 */

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: Hex;
  network: string;
}

interface Parsed {
  requirement: PaymentRequirement;
  authorization: Authorization;
  signature: Hex;
}

const UINT = /^[0-9]+$/;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Accepts the SDK v2 envelope ({paymentPayload:{payload}, accepted}) and the spec shape ({paymentPayload, paymentRequirements}). */
export function parseFacilitatorRequest(body: unknown): Parsed | string {
  const b = body as Record<string, any>;
  if (!b || typeof b !== 'object') return 'invalid_payload: body is not an object';
  const pp = b.paymentPayload;
  const inner = pp?.payload;
  const requirement = (b.accepted ?? b.paymentRequirements ?? pp?.accepted) as PaymentRequirement | undefined;
  if (!inner || !requirement) return 'invalid_payload: missing paymentPayload.payload or requirements';
  const auth = inner.authorization as Authorization | undefined;
  const signature = inner.signature as Hex | undefined;
  if (!auth || typeof signature !== 'string' || !isHex(signature)) return 'invalid_payload: missing authorization or signature';
  for (const k of ['from', 'to'] as const) {
    if (!isAddress(String(auth[k]), { strict: false })) return `invalid_payload: authorization.${k}`;
  }
  for (const k of ['value', 'validAfter', 'validBefore'] as const) {
    if (!UINT.test(String(auth[k]))) return `invalid_payload: authorization.${k}`;
  }
  if (!isHex(auth.nonce) || auth.nonce.length !== 66) return 'invalid_payload: authorization.nonce';
  const amount = (requirement as any).amount ?? (requirement as any).maxAmountRequired;
  if (!UINT.test(String(amount))) return 'invalid_payload: requirement amount';
  if (BigInt(amount) <= 0n || BigInt(auth.value) <= 0n) return 'invalid_payload: amount must be positive';
  // 65-byte r||s||v only (what x402-rs and the token's v,r,s entry point take)
  if (signature.length !== 132) return 'invalid_payload: signature must be 65 bytes';
  return { requirement: { ...requirement, amount: String(amount) }, authorization: auth, signature };
}

export interface LocalFacilitatorOptions {
  net: NetworkConfig;
  /** Pays the gas of every settle. */
  signer: LocalAccount;
  /** Only settle payments to these addresses (our seller). Undefined = any payee. */
  allowedPayTo?: Address[];
  /** Seconds a validBefore must still have left when we broadcast (x402-rs uses a few seconds). */
  expiryMarginSeconds?: number;
  now?: () => number;
}

export function createLocalFacilitator(opts: LocalFacilitatorOptions) {
  const { net, signer } = opts;
  const margin = BigInt(opts.expiryMarginSeconds ?? 6);
  const nowSec = () => BigInt(opts.now ? opts.now() : Math.floor(Date.now() / 1000));
  const pub = publicClientFor(net);
  const wallet = walletClientFor(net, signer);
  const inFlight = new Set<string>();
  const allowed = opts.allowedPayTo ? new Set(opts.allowedPayTo.map((a) => getAddress(a))) : undefined;

  async function verify(body: unknown): Promise<VerifyResult & { parsed?: Parsed }> {
    const parsed = parseFacilitatorRequest(body);
    if (typeof parsed === 'string') return { isValid: false, invalidReason: parsed };
    const { requirement: req, authorization: auth, signature } = parsed;
    const payer = getAddress(auth.from);
    const fail = (invalidReason: string) => ({ isValid: false, invalidReason, payer });
    if (req.scheme !== 'exact') return fail('unsupported_scheme');
    if (typeof req.network !== 'string' || !networkMatches(req.network, net)) return fail('invalid_network');
    if (!isAddress(String(req.asset), { strict: false }) || getAddress(req.asset) !== getAddress(net.usdc.address)) {
      return fail('invalid_exact_evm_payload_asset');
    }
    if (!isAddress(String(req.payTo), { strict: false }) || getAddress(auth.to) !== getAddress(req.payTo)) {
      return fail('invalid_exact_evm_payload_recipient_mismatch');
    }
    if (allowed && !allowed.has(getAddress(req.payTo))) return fail('payee_not_allowed_on_this_facilitator');
    if (BigInt(auth.value) !== BigInt(req.amount)) return fail('invalid_exact_evm_payload_authorization_value');
    const now = nowSec();
    // the token wants block.timestamp > validAfter
    if (BigInt(auth.validAfter) >= now) return fail('invalid_exact_evm_payload_authorization_valid_after');
    // low-s only, like x402-rs and FiatToken: a high-s signature verifies off-chain and then reverts on-chain
    if (BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return fail('invalid_exact_evm_payload_signature_high_s');
    if (BigInt(auth.validBefore) < now + margin) return fail('invalid_exact_evm_payload_authorization_valid_before');
    const name = req.extra?.name ?? net.usdc.eip712.name;
    const version = req.extra?.version ?? net.usdc.eip712.version;
    let signatureOk = false;
    try {
      signatureOk = await verifyTypedData({
        address: payer,
        domain: { name, version, chainId: net.chainId, verifyingContract: net.usdc.address },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: payer,
          to: getAddress(auth.to),
          value: BigInt(auth.value),
          validAfter: BigInt(auth.validAfter),
          validBefore: BigInt(auth.validBefore),
          nonce: auth.nonce,
        },
        signature,
      });
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return fail('invalid_exact_evm_payload_signature');
    const [balance, used] = await Promise.all([
      pub.readContract({ address: net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'balanceOf', args: [payer] }),
      pub.readContract({
        address: net.usdc.address,
        abi: ERC20_EIP3009_ABI,
        functionName: 'authorizationState',
        args: [payer, auth.nonce],
      }),
    ]);
    if (used) return fail('invalid_exact_evm_payload_authorization_used');
    if (balance < BigInt(auth.value)) return fail('insufficient_funds');
    return { isValid: true, payer, parsed };
  }

  async function settle(body: unknown): Promise<SettleResult> {
    const v = await verify(body);
    if (!v.isValid || !v.parsed) return { success: false, errorReason: v.invalidReason, payer: v.payer, network: net.caip2 };
    const { authorization: auth, signature } = v.parsed;
    const key = `${getAddress(auth.from)}:${auth.nonce.toLowerCase()}`;
    if (inFlight.has(key)) return { success: false, errorReason: 'authorization_in_flight', payer: v.payer, network: net.caip2 };
    inFlight.add(key);
    try {
      const { r, s, v: vv, yParity } = parseSignature(signature);
      const vByte = Number(vv ?? BigInt(yParity + 27));
      const hash = await wallet.writeContract({
        address: net.usdc.address,
        abi: ERC20_EIP3009_ABI,
        functionName: 'transferWithAuthorization',
        args: [
          getAddress(auth.from),
          getAddress(auth.to),
          BigInt(auth.value),
          BigInt(auth.validAfter),
          BigInt(auth.validBefore),
          auth.nonce,
          vByte,
          r,
          s,
        ],
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        return { success: false, errorReason: 'transaction_reverted', payer: v.payer, transaction: hash, network: net.caip2 };
      }
      return { success: true, payer: v.payer, transaction: hash, network: net.caip2 };
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return { success: false, errorReason: `unexpected_settle_error: ${msg}`, payer: v.payer, network: net.caip2 };
    } finally {
      inFlight.delete(key);
    }
  }

  const app = new Hono();
  // Server-to-server only: a browser request (it always carries Origin on POST and Sec-Fetch-Site; Node's fetch
  // sends neither, though it does send sec-fetch-mode) or a non-JSON body is refused, so a web page cannot make
  // this wallet broadcast transfers (CSRF with a text/plain "simple request").
  app.use('*', async (c, next) => {
    if (c.req.header('origin') || c.req.header('sec-fetch-site')) return c.json({ error: 'browser requests are not accepted' }, 403);
    if (c.req.method === 'POST' && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'content-type must be application/json' }, 415);
    }
    await next();
  });
  app.get('/health', (c) => c.json({ status: 'ok', kind: 'agentsettle-local-facilitator', network: net.caip2 }));
  app.get('/supported', (c) =>
    c.json({ kinds: [{ x402Version: 2, scheme: 'exact', network: net.caip2, extra: { tokens: [{ token: 'usdc', address: net.usdc.address, decimals: 6 }] } }] }),
  );
  app.post('/verify', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const { parsed: _p, ...result } = await verify(body);
    return c.json(result);
  });
  // Like x402-rs: the same Idempotency-Key gets the original successful answer back (a lost response is not a new payment).
  const answered = new Map<string, SettleResult>();
  app.post('/settle', async (c) => {
    const key = c.req.header('idempotency-key');
    const prior = key ? answered.get(key) : undefined;
    if (prior) {
      c.header('Idempotent-Replayed', 'true');
      return c.json(prior);
    }
    const body = await c.req.json().catch(() => undefined);
    const result = await settle(body);
    if (key && result.success) answered.set(key, result);
    return c.json(result);
  });
  return { app, verify, settle, signer: signer.address };
}

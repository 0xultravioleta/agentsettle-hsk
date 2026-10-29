import { keccak256, toHex, type Address, type Hex, type LocalAccount } from 'viem';

/**
 * HSP (HashKey Settlement Protocol) rail behind one interface.
 *
 *  - `sdk`:  the organizer's @hsp/sdk (HSPClient.pay(), payX402(), HSPVerifier.verify()) against the team's
 *            sandbox Coordinator. Used when HSP_COORDINATOR_URL + HSP_API_KEY are set AND the SDK is installed
 *            (it is not on npm: the organizer shares the repo with the credentials).
 *  - `stub`: until then. It never claims a payment happened: every result is marked `simulated: true`, the
 *            verifier outcome is `SIMULATED` (never ACCEPT), and the demo writes no on-chain receipt for it.
 *
 * Call shapes follow the HSP developer guide (docs.hskchain.net /docs/HSP, sections 4 and 6).
 */

export type Compliance = 'kyc' | 'sanctions';
export type OutcomeClass = 'ACCEPT' | 'RETRYABLE' | 'POLICY' | 'PERMANENT';

export interface HspPayment {
  /** = mandateHash (bytes32) on the real rail. */
  paymentId: string;
  txHash?: Hex;
  status: string;
  simulated: boolean;
  via: 'pay' | 'payX402';
  explorerUrl?: string;
}

export interface HspVerdict {
  ok: boolean;
  outcomeClass: OutcomeClass | 'SIMULATED';
  simulated: boolean;
  requiredCapabilities?: string[];
  satisfiedCapabilities?: string[];
  detail?: unknown;
}

export interface HspRail {
  readonly mode: 'sdk' | 'stub';
  /** Why the rail is in stub mode (shown in the UI). */
  readonly reason?: string;
  pay(req: { to: Address; amount: bigint; compliance?: Compliance[] }): Promise<HspPayment>;
  payX402(req: { merchant: Address; amount: bigint; compliance?: Compliance[] }): Promise<HspPayment>;
  /** Independent verification with HSPVerifier against the pinned adapter address. ACCEPT means ship. */
  verify(paymentId: string): Promise<HspVerdict>;
}

export interface HspEnv {
  coordinatorUrl?: string;
  apiKey?: string;
  facilitatorUrl?: string;
  issuerUrl?: string;
  adapterAddress?: string;
  chain?: string;
}

export function hspEnvFromProcess(): HspEnv {
  const v = (k: string) => process.env[k]?.trim() || undefined;
  return {
    coordinatorUrl: v('HSP_COORDINATOR_URL'),
    apiKey: v('HSP_API_KEY'),
    facilitatorUrl: v('HSP_FACILITATOR_URL'),
    issuerUrl: v('HSP_ISSUER_URL'),
    adapterAddress: v('HSP_ADAPTER_ADDRESS'),
    chain: v('HSP_CHAIN') ?? 'hashkey-testnet',
  };
}

/** Stub rail: deterministic shape, loudly simulated. */
export class StubHspRail implements HspRail {
  readonly mode = 'stub' as const;
  constructor(readonly reason: string) {}

  private fake(via: HspPayment['via'], to: Address, amount: bigint): HspPayment {
    const paymentId = keccak256(toHex(`stub:${via}:${to}:${amount}:${Date.now()}:${Math.random()}`));
    return { paymentId, status: 'SIMULATED', simulated: true, via };
  }

  async pay(req: { to: Address; amount: bigint }): Promise<HspPayment> {
    return this.fake('pay', req.to, req.amount);
  }

  async payX402(req: { merchant: Address; amount: bigint }): Promise<HspPayment> {
    return this.fake('payX402', req.merchant, req.amount);
  }

  async verify(): Promise<HspVerdict> {
    return { ok: false, outcomeClass: 'SIMULATED', simulated: true, detail: this.reason };
  }
}

/** Loads a module by a name TypeScript does not try to resolve (the HSP SDK is not installed until credentials arrive). */
async function importOptional(name: string): Promise<any | undefined> {
  try {
    return await import(/* @vite-ignore */ name);
  } catch {
    return undefined;
  }
}

/** Real rail over @hsp/sdk. Only constructed by createHspRail once the SDK and the credentials are both present. */
export class SdkHspRail implements HspRail {
  readonly mode = 'sdk' as const;
  readonly reason = undefined;
  private readonly handles = new Map<string, any>();

  constructor(
    private readonly env: Required<Pick<HspEnv, 'coordinatorUrl' | 'apiKey'>> & HspEnv,
    private readonly client: any,
    private readonly verifier: any | undefined,
  ) {}

  private explorer(): string {
    return `${this.env.coordinatorUrl.replace(/\/+$/, '')}/explorer`;
  }

  private profile(compliance?: Compliance[]) {
    return compliance?.length ? { profile: { compliance } } : {};
  }

  async pay(req: { to: Address; amount: bigint; compliance?: Compliance[] }): Promise<HspPayment> {
    const handle = await this.client.pay({ to: req.to, amount: req.amount, ...this.profile(req.compliance) });
    const final = typeof handle.awaitSettled === 'function' ? await handle.awaitSettled() : handle;
    this.handles.set(handle.paymentId, final);
    return { paymentId: handle.paymentId, txHash: final.txHash ?? handle.txHash, status: final.status, simulated: false, via: 'pay', explorerUrl: this.explorer() };
  }

  async payX402(req: { merchant: Address; amount: bigint; compliance?: Compliance[] }): Promise<HspPayment> {
    if (!this.env.facilitatorUrl) throw new Error('HSP_FACILITATOR_URL is not set (the organizer shares it with the sandbox)');
    const res = await this.client.payX402({ merchant: req.merchant, facilitatorUrl: this.env.facilitatorUrl, amount: req.amount, ...this.profile(req.compliance) });
    const final = typeof res?.awaitSettled === 'function' ? await res.awaitSettled() : res;
    return { paymentId: res.paymentId, txHash: final?.txHash ?? res.txHash, status: final?.status ?? res.status, simulated: false, via: 'payX402', explorerUrl: this.explorer() };
  }

  async verify(paymentId: string): Promise<HspVerdict> {
    // Fetch the stored triple, then decide locally: never trust the Coordinator's own verdict.
    const r = await fetch(`${this.env.coordinatorUrl.replace(/\/+$/, '')}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { authorization: `Bearer ${this.env.apiKey}` },
    });
    if (!r.ok) return { ok: false, outcomeClass: 'RETRYABLE', simulated: false, detail: `coordinator ${r.status}` };
    const stored: any = await r.json();
    if (!this.verifier) return { ok: false, outcomeClass: 'PERMANENT', simulated: false, detail: 'HSPVerifier unavailable (HSP_ADAPTER_ADDRESS not pinned)' };
    const decision = await this.verifier.verify(stored.mandate, stored.receipt, stored.attestations ?? []);
    return {
      ok: decision.ok === true && decision.outcomeClass === 'ACCEPT',
      outcomeClass: decision.outcomeClass,
      simulated: false,
      requiredCapabilities: decision.requiredCapabilities,
      satisfiedCapabilities: decision.satisfiedCapabilities,
      detail: decision,
    };
  }
}

/**
 * Picks the rail. `account` is the HSP payer (W6 on testnet): HSP is wallet-settling, so it signs the mandate
 * AND broadcasts the transfer, and needs test HSK + test USDC.
 */
export async function createHspRail(account: LocalAccount | undefined, env: HspEnv = hspEnvFromProcess()): Promise<HspRail> {
  if (!env.coordinatorUrl || !env.apiKey) {
    return new StubHspRail('waiting for the HSP sandbox credentials (HSP_COORDINATOR_URL, HSP_API_KEY) from the organizer');
  }
  if (!account) return new StubHspRail('HSP credentials are set but there is no testnet buyer key (TESTNET_BUYER_PRIVATE_KEY)');
  const sdk = await importOptional('@hsp/sdk');
  const chains = await importOptional('@hsp/core/chains/index');
  if (!sdk?.HSPClient || !chains?.resolveChain) {
    return new StubHspRail('HSP credentials are set but @hsp/sdk is not installed (clone the organizer repo, then pnpm add it)');
  }
  const chain = chains.resolveChain(env.chain ?? 'hashkey-testnet');
  const client = new sdk.HSPClient({
    coordinatorUrl: env.coordinatorUrl,
    apiKey: env.apiKey,
    signer: { kind: 'viemAccount', account },
    chain,
    ...(env.issuerUrl ? { issuerUrl: env.issuerUrl } : {}),
  });
  const verifier = env.adapterAddress && sdk.HSPVerifier ? new sdk.HSPVerifier({ chain, adapterAddress: env.adapterAddress }) : undefined;
  return new SdkHspRail({ ...env, coordinatorUrl: env.coordinatorUrl, apiKey: env.apiKey }, client, verifier);
}

import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { accountFromEnv, agentAccounts } from './accounts.js';
import { assertMainnetAllowed, getNetwork, keyEnvNames, type NetworkConfig, type NetworkName } from './config.js';
import { createLocalFacilitator } from './facilitator/local.js';
import { createHspRail, type HspRail } from './rails/hsp.js';
import { ensureLocalChain } from './local-chain.js';
import { DEFAULT_POLICY, FileLedger, SpendGuard } from './spend-guard.js';

export type FacilitatorMode = 'auto' | 'local' | 'remote';

/** The only facilitator allowed to settle on mainnet (W1 pays the gas there). */
export const PRODUCTION_FACILITATOR = 'https://facilitator.ultravioletadao.xyz';

export interface Runtime {
  net: NetworkConfig;
  operator: LocalAccount;
  buyer: LocalAccount;
  guard: SpendGuard;
  hsp: HspRail;
  /** Base URL the seller sends /verify and /settle to (production, or the local one on its own loopback port). */
  facilitatorUrl: string;
  facilitatorLabel: string;
  close(): void;
}

/**
 * The local facilitator gets its own 127.0.0.1 port, never a route on the public demo server, and it only
 * settles payments to our seller.
 */
async function serveLocalFacilitator(net: NetworkConfig, signer: LocalAccount, payTo: LocalAccount['address']) {
  const fac = createLocalFacilitator({ net, signer, allowedPayTo: [payTo] });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = serve({ fetch: fac.app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve({ url: `http://127.0.0.1:${info.port}`, close: () => srv.close() }),
    );
  });
}

/** Does the facilitator at `url` list this network? (production lists hashkey and hashkey-testnet since 2.52.0) */
export async function facilitatorSupports(url: string, net: NetworkConfig): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/supported`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return false;
    const body: any = await r.json();
    const kinds: any[] = Array.isArray(body) ? body : (body.kinds ?? []);
    return kinds.some((k) => {
      const names = [k.network, ...(k.networkAliases ?? [])].map((x: unknown) => String(x).toLowerCase());
      return names.includes(net.caip2) || names.includes(net.name);
    });
  } catch {
    return false;
  }
}

export interface Readiness {
  ready: boolean;
  reason: string;
}

/** Can the facilitator settle on this network right now? `/health/ready` marks a network `down` when, e.g., its signer has no gas. */
export async function facilitatorReadiness(url: string, net: NetworkConfig): Promise<Readiness> {
  try {
    // a 503 still carries the per-network report: one network down makes the whole facilitator "down"
    const r = await fetch(`${url.replace(/\/+$/, '')}/health/ready`, { signal: AbortSignal.timeout(10_000) });
    const body: any = await r.json();
    const entry = (Array.isArray(body?.networks) ? body.networks : []).find((n: any) =>
      [n?.network, n?.caip2].map((x: unknown) => String(x).toLowerCase()).some((x) => x === net.caip2 || x === net.name),
    );
    if (!entry) return { ready: false, reason: `${net.caip2} is not in /health/ready` };
    if (entry.status === 'down') return { ready: false, reason: `${net.caip2} is down (${entry.reason ?? 'no reason given'})` };
    return { ready: true, reason: `${net.caip2} is ${entry.status}` };
  } catch (err) {
    return { ready: false, reason: `/health/ready unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Who settles. Mainnet: production only, and only while /health/ready does not mark the network down (owner's
 * condition for the mainnet runs). Testnet `auto`: production when it lists the network and is up, else the local double.
 */
export function pickFacilitator(net: NetworkConfig, mode: FacilitatorMode, remote: { url: string; supports: boolean; readiness: Readiness }): 'remote' | 'local' {
  if (net.mainnet) {
    if (mode === 'local' || !remote.supports) {
      throw new Error(`on mainnet only ${PRODUCTION_FACILITATOR} settles (W1 pays gas), and ${remote.url} must list ${net.caip2}`);
    }
    if (!remote.readiness.ready) throw new Error(`production facilitator not ready: ${remote.readiness.reason}; wait until /health/ready stops marking it down`);
    return 'remote';
  }
  if (mode === 'auto') return remote.supports && remote.readiness.ready ? 'remote' : 'local';
  return mode;
}

export async function createRuntime(name: NetworkName, opts: { facilitator?: FacilitatorMode; root?: string } = {}): Promise<Runtime> {
  const root = opts.root ?? process.cwd();
  const mode = opts.facilitator ?? 'auto';
  const guard = new SpendGuard(DEFAULT_POLICY, new FileLedger(join(root, 'data', `spend-ledger.${name}.json`)));

  if (name === 'local') {
    const chain = await ensureLocalChain({ root });
    const operator = privateKeyToAccount(chain.keys.operator);
    const buyer = privateKeyToAccount(chain.keys.buyer);
    const fac = await serveLocalFacilitator(chain.net, privateKeyToAccount(chain.keys.facilitator), operator.address);
    const hsp = await createHspRail(undefined, {}); // HSP only exists on the testnet sandbox
    return { net: chain.net, operator, buyer, guard, hsp, facilitatorUrl: fac.url, facilitatorLabel: 'local dev facilitator (anvil)', close: fac.close };
  }

  const net = getNetwork(name);
  assertMainnetAllowed(net);
  const { operator, buyer } = agentAccounts(name);
  const names = keyEnvNames(name);
  if (!operator || !buyer) throw new Error(`set ${names.operator} and ${names.buyer} in .env for ${name}`);
  const hsp = await createHspRail(name === 'hashkey-testnet' ? buyer : undefined);
  const remote = (process.env.FACILITATOR_URL?.trim() || PRODUCTION_FACILITATOR).replace(/\/+$/, '');
  if (net.mainnet && remote !== PRODUCTION_FACILITATOR) {
    throw new Error(`on mainnet only ${PRODUCTION_FACILITATOR} settles; FACILITATOR_URL is ${remote}`);
  }

  const supports = mode !== 'local' && (await facilitatorSupports(remote, net));
  const readiness = supports ? await facilitatorReadiness(remote, net) : { ready: false, reason: `${remote} does not list ${net.caip2}` };
  if (pickFacilitator(net, mode, { url: remote, supports, readiness }) === 'local') {
    const signer = accountFromEnv('LOCAL_FACILITATOR_PRIVATE_KEY') ?? operator;
    const fac = await serveLocalFacilitator(net, signer, operator.address);
    const why = mode === 'auto' ? `; production: ${readiness.reason}` : '';
    return { net, operator, buyer, guard, hsp, facilitatorUrl: fac.url, facilitatorLabel: `local dev facilitator (gas: ${signer.address}${why})`, close: fac.close };
  }
  return { net, operator, buyer, guard, hsp, facilitatorUrl: remote, facilitatorLabel: remote, close: () => {} };
}

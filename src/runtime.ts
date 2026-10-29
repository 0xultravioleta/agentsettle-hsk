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

/** Does the facilitator at `url` list this network? (production did not list HashKey on 2026-10-29) */
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

  const useLocal = mode === 'local' || (mode === 'auto' && !(await facilitatorSupports(remote, net)));
  if (useLocal) {
    if (net.mainnet) {
      throw new Error(`the facilitator at ${remote} does not list ${net.caip2}; on mainnet only the production facilitator settles (W1 pays gas)`);
    }
    const signer = accountFromEnv('LOCAL_FACILITATOR_PRIVATE_KEY') ?? operator;
    const fac = await serveLocalFacilitator(net, signer, operator.address);
    return { net, operator, buyer, guard, hsp, facilitatorUrl: fac.url, facilitatorLabel: `local dev facilitator (gas: ${signer.address})`, close: fac.close };
  }
  return { net, operator, buyer, guard, hsp, facilitatorUrl: remote, facilitatorLabel: remote, close: () => {} };
}

import { join } from 'node:path';
import type { LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { accountFromEnv, agentAccounts } from './accounts.js';
import { assertMainnetAllowed, getNetwork, keyEnvNames, type NetworkConfig, type NetworkName } from './config.js';
import { createLocalFacilitator } from './facilitator/local.js';
import { createHspRail, type HspRail } from './rails/hsp.js';
import { ensureLocalChain } from './local-chain.js';
import { DEFAULT_POLICY, FileLedger, SpendGuard } from './spend-guard.js';

export type FacilitatorMode = 'auto' | 'local' | 'remote';

export interface Runtime {
  net: NetworkConfig;
  operator: LocalAccount;
  buyer: LocalAccount;
  guard: SpendGuard;
  hsp: HspRail;
  /** Remote facilitator base URL, or undefined when the in-process local facilitator is used. */
  facilitatorUrl?: string;
  localFacilitator?: ReturnType<typeof createLocalFacilitator>;
  facilitatorLabel: string;
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
    const localFacilitator = createLocalFacilitator({ net: chain.net, signer: privateKeyToAccount(chain.keys.facilitator) });
    const hsp = await createHspRail(undefined, {}); // HSP only exists on the testnet sandbox
    return { net: chain.net, operator, buyer, guard, hsp, localFacilitator, facilitatorLabel: 'local dev facilitator (anvil)' };
  }

  const net = getNetwork(name);
  assertMainnetAllowed(net);
  const { operator, buyer } = agentAccounts(name);
  const names = keyEnvNames(name);
  if (!operator || !buyer) throw new Error(`set ${names.operator} and ${names.buyer} in .env for ${name}`);
  const hsp = await createHspRail(name === 'hashkey-testnet' ? buyer : undefined);
  const remote = process.env.FACILITATOR_URL?.trim() || 'https://facilitator.ultravioletadao.xyz';

  const useLocal = mode === 'local' || (mode === 'auto' && !(await facilitatorSupports(remote, net)));
  if (useLocal) {
    if (net.mainnet) {
      throw new Error(`the facilitator at ${remote} does not list ${net.caip2}; on mainnet only the production facilitator settles (W1 pays gas)`);
    }
    const signer = accountFromEnv('LOCAL_FACILITATOR_PRIVATE_KEY') ?? operator;
    const localFacilitator = createLocalFacilitator({ net, signer });
    return { net, operator, buyer, guard, hsp, localFacilitator, facilitatorLabel: `local dev facilitator (gas: ${signer.address})` };
  }
  return { net, operator, buyer, guard, hsp, facilitatorUrl: remote, facilitatorLabel: remote };
}

import { serve } from '@hono/node-server';
import { loadDotEnv, parseNetworkName, getNetwork } from '../config.js';
import { accountFromEnv } from '../accounts.js';
import { createLocalFacilitator } from '../facilitator/local.js';

/** Standalone local facilitator for hashkey-testnet (port 8403). Mainnet is refused: production settles there. */
loadDotEnv();
const name = parseNetworkName(process.argv[process.argv.indexOf('--network') + 1] ?? 'hashkey-testnet');
if (name !== 'hashkey-testnet') throw new Error('the standalone local facilitator only serves hashkey-testnet');
const net = getNetwork(name);
const signer = accountFromEnv('LOCAL_FACILITATOR_PRIVATE_KEY') ?? accountFromEnv('TESTNET_OPERATOR_PRIVATE_KEY');
if (!signer) throw new Error('set LOCAL_FACILITATOR_PRIVATE_KEY or TESTNET_OPERATOR_PRIVATE_KEY in .env');
const fac = createLocalFacilitator({ net, signer });
const port = Number(process.env.FACILITATOR_PORT ?? '8403');
serve({ fetch: fac.app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`local facilitator for ${net.caip2} on http://127.0.0.1:${port} (gas: ${signer.address})`));

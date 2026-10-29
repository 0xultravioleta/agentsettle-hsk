import { parseNetworkName, type NetworkName } from '../config.js';
import type { FacilitatorMode } from '../runtime.js';

export interface CliArgs {
  network: NetworkName;
  facilitator: FacilitatorMode;
  port: number;
  runs: number;
  text: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const facilitator = (get('--facilitator') ?? 'auto').toLowerCase();
  if (!['auto', 'local', 'remote'].includes(facilitator)) throw new Error(`--facilitator must be auto, local or remote`);
  const runs = Number(get('--runs') ?? '1');
  if (!Number.isInteger(runs) || runs < 0 || runs > 20) throw new Error('--runs must be an integer between 0 and 20');
  const port = Number(get('--port') ?? process.env.PORT ?? '8402');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a TCP port');
  return {
    network: parseNetworkName(get('--network') ?? process.env.NETWORK),
    facilitator: facilitator as FacilitatorMode,
    port,
    runs,
    text: get('--text') ?? 'Hello world, agents pay agents',
  };
}

import { createInterface } from 'node:readline/promises';
import type { HumanConfirm } from '../agents/hsp-mcp-flow.js';

/**
 * The person at this terminal answers every HSP question. There is no default and no "yes to all": without a TTY
 * the payment does not start, and anything but "s"/"y" is a no.
 */
export function terminalHuman(): HumanConfirm & { close(): void } {
  if (!process.stdin.isTTY) throw new Error('HSP Agentic Payment needs a person at the terminal (stdin is not a TTY): not paying');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: async (q) => rl.question(`  ? ${q} `),
    approve: async (q) => /^(s|si|sí|y|yes)$/i.test((await rl.question(`  ? ${q} [s/N] `)).trim()),
    close: () => rl.close(),
  };
}

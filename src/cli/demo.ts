import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
import { explorerAddress, loadDotEnv } from '../config.js';
import { createApp } from '../app.js';
import { hire, type Step } from '../agents/buyer.js';
import { hireViaHsp } from '../agents/hsp-flow.js';
import { createRuntime } from '../runtime.js';
import { parseArgs } from './args.js';

/** One command: start Agent B, have Agent A buy `--runs` tasks, show the spend-cap denial and the HSP rail. */
loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const rt = await createRuntime(args.network, { facilitator: args.facilitator });

const print = (steps: Step[]) => {
  for (const s of steps) {
    const ref = s.link ?? (typeof s.detail?.tx === 'string' ? `tx ${s.detail.tx}` : undefined);
    console.log(`  ${s.step.padEnd(16)} ${s.title}${ref ? `\n  ${''.padEnd(16)} ${ref}` : ''}`);
  }
};

// Agent B listens first (its own URL goes into resource.url), then the app is mounted on that server.
const shell = new Hono();
const server = await new Promise<{ url: string; close: () => void }>((resolve) => {
  const srv = serve({ fetch: shell.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
    resolve({ url: `http://127.0.0.1:${info.port}`, close: () => srv.close() }),
  );
});
shell.route('/', createApp(rt, server.url));

let failures = 0;
try {
  console.log(`\nAgentSettle demo on ${rt.net.name} (${rt.net.caip2}), facilitator: ${rt.facilitatorLabel}`);
  console.log(`  Agent A (buyer)  ${rt.buyer.address}`);
  console.log(`  Agent B (seller) ${rt.operator.address}`);
  if (rt.net.receiptsAddress) console.log(`  receipts         ${explorerAddress(rt.net, rt.net.receiptsAddress) ?? rt.net.receiptsAddress}`);

  for (let i = 1; i <= args.runs; i++) {
    console.log(`\n[${i}/${args.runs}] x402: Agent A hires Agent B for 0.10 USDC`);
    const r = await hire({ net: rt.net, account: rt.buyer, guard: rt.guard, expectedPayTo: rt.operator.address }, `${server.url}/task/translate?text=${encodeURIComponent(args.text)}`);
    print(r.steps);
    if (!r.ok) failures++;
  }

  console.log('\n[guardrail] Agent A is asked to pay 2.00 USDC for a premium task (per-tx cap 0.50)');
  const denied = await hire({ net: rt.net, account: rt.buyer, guard: rt.guard, expectedPayTo: rt.operator.address }, `${server.url}/task/translate?text=hello&tier=premium`);
  print(denied.steps);
  if (denied.denied?.code !== 'PER_TX_CAP') failures++;

  console.log(`\n[HSP] same task over HSP (${rt.hsp.mode === 'merchant' ? 'HashKey Merchant QA gateway' : rt.hsp.mode})`);
  const h = await hireViaHsp(rt, args.text, {
    waitMs: args.hspWait * 1000,
    onOrder: (o) => {
      if (o.paymentUrl) console.log(`  checkout: ${o.paymentUrl}\n  pay it with Agent A's wallet; waiting up to ${args.hspWait} s`);
    },
  });
  print(h.steps);
  if (rt.hsp.mode === 'merchant' && !h.ok) failures++;
} finally {
  server.close();
  rt.close();
}
console.log(failures ? `\n${failures} step(s) failed` : '\ndone');
process.exit(failures ? 1 : 0);

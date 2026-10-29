import { serve } from '@hono/node-server';
import { loadDotEnv } from '../config.js';
import { createApp } from '../app.js';
import { createRuntime } from '../runtime.js';
import { parseArgs } from './args.js';

loadDotEnv();
const args = parseArgs(process.argv.slice(2));
const rt = await createRuntime(args.network, { facilitator: args.facilitator });
const publicUrl = process.env.PUBLIC_URL?.trim() || `http://127.0.0.1:${args.port}`;
const app = createApp(rt, publicUrl);
serve({ fetch: app.fetch, port: args.port, hostname: '127.0.0.1' }, () => {
  console.log(`AgentSettle on ${rt.net.name} (${rt.net.caip2})`);
  console.log(`  UI + API      ${publicUrl}`);
  console.log(`  Agent B       ${publicUrl}/task/translate?text=hello   (402 until paid)`);
  console.log(`  facilitator   ${rt.facilitatorLabel}`);
  console.log(`  receipts      ${rt.net.receiptsAddress ?? '(not deployed on this network yet)'}`);
  console.log(`  HSP rail      ${rt.hsp.mode}${rt.hsp.reason ? ` (${rt.hsp.reason})` : ''}`);
});

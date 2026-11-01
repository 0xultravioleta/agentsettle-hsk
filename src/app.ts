import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context, type Next } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { explorerAddress, PREMIUM_TASK_PRICE, TASK_PRICE } from './config.js';
import { hire, type Step } from './agents/buyer.js';
import { hireViaHsp } from './agents/hsp-flow.js';
import { createSeller, facilitatorClient } from './agents/seller.js';
import { MAX_TEXT_LENGTH } from './agents/translate.js';
import { listReceipts } from './receipts.js';
import { fmtUsdc } from './spend-guard.js';
import type { Runtime } from './runtime.js';

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

/**
 * One process for the demo: Agent B's paid routes (/task/*), the local facilitator when used (/facilitator/*),
 * the judge console API (/api/*) and the built UI (web/dist). Agent A still reaches Agent B over real HTTP.
 */
/**
 * /api/* spends the buyer's money, so only the console itself may call it: JSON bodies only (a cross-site
 * text/plain "simple request" is refused), Origin / Sec-Fetch-Site must be this server or the Vite dev server,
 * and the Host must be the one we serve (DNS rebinding).
 */
export function consoleGuard(publicUrl: string) {
  const base = new URL(publicUrl);
  const port = base.port || (base.protocol === 'https:' ? '443' : '80');
  const origins = new Set([base.origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);
  const hosts = new Set([base.host, `127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173']);
  return async (c: Context, next: Next) => {
    const host = c.req.header('host') ?? '';
    if (!hosts.has(host)) return c.json({ error: 'unexpected Host' }, 403);
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.has(origin)) return c.json({ error: 'cross-origin request refused' }, 403);
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return c.json({ error: 'cross-site request refused' }, 403);
    if (c.req.method !== 'GET' && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'content-type must be application/json' }, 415);
    }
    await next();
  };
}

export function createApp(rt: Runtime, publicUrl: string): Hono {
  const app = new Hono();
  // the console must not be framed (clickjacking its buttons spends the buyer's money)
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
  });
  app.route(
    '/',
    createSeller({
      net: rt.net,
      operator: rt.operator,
      facilitator: facilitatorClient(rt.facilitatorUrl),
      publicUrl,
      bindingPath: join('data', `seller-tasks.${rt.net.name}.json`),
      log: (m) => console.log(`[agent B] ${m}`),
    }),
  );
  app.use('/api/*', consoleGuard(publicUrl));

  // HashKey Merchant webhook: server to server, authenticated by its own HMAC (not by the console guard)
  app.post('/hsp/webhook', async (c) => {
    if (!rt.hsp.handleWebhook) return c.json({ code: 10003, msg: 'HSP rail is not live' }, 404);
    const raw = await c.req.text();
    if (raw.length > 64 * 1024) return c.json({ code: 10001, msg: 'body too large' }, 413);
    try {
      rt.hsp.handleWebhook(raw, c.req.header('x-signature'));
    } catch {
      return c.json({ code: 10002, msg: 'invalid signature' }, 401);
    }
    return c.json({ code: 0 });
  });

  app.get('/api/config', (c) =>
    c.json({
      network: rt.net.name,
      chainId: rt.net.chainId,
      caip2: rt.net.caip2,
      mainnet: rt.net.mainnet,
      explorer: rt.net.explorer ?? null,
      usdc: rt.net.usdc,
      receipts: rt.net.receiptsAddress ?? null,
      receiptsLink: rt.net.receiptsAddress ? (explorerAddress(rt.net, rt.net.receiptsAddress) ?? null) : null,
      agents: {
        buyer: { address: rt.buyer.address, link: explorerAddress(rt.net, rt.buyer.address) ?? null },
        seller: { address: rt.operator.address, link: explorerAddress(rt.net, rt.operator.address) ?? null },
      },
      facilitator: rt.facilitatorLabel,
      prices: { standard: fmtUsdc(TASK_PRICE), premium: fmtUsdc(PREMIUM_TASK_PRICE) },
      caps: { perTx: fmtUsdc(rt.guard.policy.perTxCap), daily: fmtUsdc(rt.guard.policy.dailyCap), spentToday: fmtUsdc(rt.guard.spentToday()) },
      hsp: { mode: rt.hsp.mode, reason: rt.hsp.reason ?? null },
      maxTextLength: MAX_TEXT_LENGTH,
    }),
  );

  app.post('/api/hire', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string; tier?: string };
    const text = String(body.text ?? '').trim().slice(0, MAX_TEXT_LENGTH) || 'Hello world';
    const tier = body.tier === 'premium' ? '&tier=premium' : '';
    const result = await hire({ net: rt.net, account: rt.buyer, guard: rt.guard, expectedPayTo: rt.operator.address }, `${publicUrl}/task/translate?text=${encodeURIComponent(text)}${tier}`);
    return c.json(json(result));
  });

  // An HSP purchase waits for someone to pay at the gateway's checkout: answer as soon as the order (and its
  // payment_url) exists, and let the console follow the job.
  const hspJobs = new Map<string, { steps: Step[]; done: boolean; ok?: boolean }>();
  app.post('/api/hsp', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = String(body.text ?? '').trim().slice(0, MAX_TEXT_LENGTH) || 'Hello world';
    const id = randomUUID();
    const job: { steps: Step[]; done: boolean; ok?: boolean } = { steps: [], done: false };
    hspJobs.set(id, job);
    if (hspJobs.size > 50) hspJobs.delete(hspJobs.keys().next().value!);
    let orderReady!: () => void;
    const ready = new Promise<void>((r) => (orderReady = r));
    hireViaHsp(rt, text, { steps: job.steps, onOrder: () => orderReady() })
      .then((r) => Object.assign(job, { ok: r.ok }))
      .catch((err) => job.steps.push({ step: 'error', at: new Date().toISOString(), title: err instanceof Error ? err.message.split('\n')[0]! : String(err) }))
      .finally(() => {
        job.done = true;
        orderReady();
      });
    await ready;
    return c.json(json({ id, ...job }));
  });
  app.get('/api/hsp/:id', (c) => {
    const job = hspJobs.get(c.req.param('id'));
    return job ? c.json(json({ id: c.req.param('id'), ...job })) : c.json({ error: 'unknown HSP job' }, 404);
  });

  app.get('/api/receipts', async (c) => {
    try {
      return c.json(json({ receipts: await listReceipts(rt.net, { limit: 20 }) }));
    } catch (err) {
      return c.json({ receipts: [], error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    }
  });

  if (existsSync('web/dist/index.html')) {
    app.use('/*', serveStatic({ root: './web/dist' }));
  } else {
    app.get('/', (c) => c.text('UI not built: run "pnpm web:build" (or "pnpm web:dev" for the Vite dev server).'));
  }
  return app;
}

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { getAddress, isAddress, verifyTypedData, type Hex } from 'viem';

/**
 * A stand-in for HSP Agentic Payment's MCP server over Streamable HTTP (SSE answers, mcp-session-id), written from the
 * guide and the recorded tool schemas, not from src/. `tools/list` is the recorded answer, byte for byte, so the SDK
 * client checks every fake result against the live output schemas. The gateway part verifies the payer's EIP-712
 * signature itself and "broadcasts" through a hook (anvil in the e2e tests).
 */

const FIX = join(import.meta.dirname, 'fixtures', 'hsp-mcp');
export const recorded = (file: string) => {
  const raw = readFileSync(join(FIX, file), 'utf8');
  return JSON.parse(raw.split('\n').filter((l) => l.startsWith('data:')).pop()!.slice(5));
};
export const RECORDED_CHAIN_CONFIG = recorded('mcp-get-chain-config.sse').result.structuredContent;

const sortKeys = (v: any): any =>
  v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(sortKeys) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
const sha = (o: unknown) => createHash('sha256').update(JSON.stringify(sortKeys(o))).digest('hex');

export interface FakePrep {
  flowId: string;
  paymentRequestId: string;
  eip712: any;
  raw: bigint;
  signature?: Hex;
  tx?: Hex;
}

export interface FakeHspMcpOptions {
  chainConfig: any;
  /** The gateway network name for gas_fee_configs. */
  networkName: string;
  gasFeeAdvanced?: boolean;
  /** Extra raw units the payer carries when gas is not advanced. */
  gasRaw?: bigint;
  /** Drop tools from tools/list (the "missing finalize_payment" case). */
  dropTools?: string[];
  /** Mutates prepare_payment's answer before it is sent (a lying server). */
  tamper?: (prep: any) => void;
  /** Broadcasts the signed authorization; returns the tx hash. */
  broadcast?: (p: FakePrep) => Promise<Hex>;
  /** Rewrites any tool's answer just before it is sent (create_order / get_order lies). */
  rewrite?: (tool: string, out: any) => void;
  /** Overrides the query_payment answer (status, payment fields, attribution). */
  query?: (p: FakePrep, base: any) => any;
  now?: () => number;
}

export interface FakeHspMcp {
  app: Hono;
  orders: Map<string, any>;
  preps: Map<string, FakePrep>;
  calls: string[];
  rejected: string[];
}

export function fakeHspMcp(opts: FakeHspMcpOptions): FakeHspMcp {
  const app = new Hono();
  const orders = new Map<string, any>();
  const preps = new Map<string, FakePrep>();
  const calls: string[] = [];
  const rejected: string[] = [];
  const now = () => opts.now?.() ?? Math.floor(Date.now() / 1000);
  const toolsList = recorded('mcp-tools-list.sse').result;
  const initialize = recorded('mcp-initialize.sse').result;
  let flows = 0;

  const fail = (why: string): never => {
    rejected.push(why);
    throw new Error(why);
  };
  const tokenFor = (chainId: number, address: string) =>
    opts.chainConfig.tokens.find((t: any) => t.chain_id === chainId && isAddress(address, { strict: false }) && getAddress(t.address) === getAddress(address));

  const tools: Record<string, (a: any) => Promise<any> | any> = {
    get_chain_config: () => opts.chainConfig,
    create_order: (a) => {
      if (!a.merchant_name) fail('create_order: no merchant_name');
      if (!isAddress(a.pay_to ?? '', { strict: false })) fail('create_order: pay_to is not an address');
      if (a.cart_mandate?.merchant_authorization) fail('create_order: merchant_authorization must not be sent');
      const c = a.cart_mandate?.contents;
      const m = c?.payment_request?.method_data?.[0];
      if (!c?.id || !c?.cart_expiry || !m || m.supported_methods !== 'https://www.x402.org/' || m.data?.x402Version !== 2) fail('create_order: cart_mandate shape');
      if (!tokenFor(m.data.chain_id, m.data.contract_address)) fail('create_order: token not in get_chain_config');
      if (c.payment_request.details.total.amount.currency !== 'USD') fail('create_order: currency must be USD');
      const prId = c.payment_request.details.id;
      if ([...orders.values()].some((o) => o.paymentRequestId === prId)) fail('create_order: duplicate details.id');
      const flowId = `flow-${++flows}`;
      const contents = { ...c, merchant_name: a.merchant_name };
      contents.payment_request.method_data = c.payment_request.method_data.map((md: any) => ({ ...md, data: { ...md.data, pay_to: a.pay_to } }));
      orders.set(flowId, { flowId, paymentRequestId: prId, merchantName: a.merchant_name, payTo: getAddress(a.pay_to), contents });
      return { merchant_name: a.merchant_name, payment_request_id: prId, flow_id: flowId, payment_url: `https://pay-qa.example/flow/${flowId}` };
    },
    get_order: (a) => {
      const o = orders.get(a.flow_id) ?? fail('get_order: unknown flow_id');
      return {
        payment_request_id: o.paymentRequestId,
        cart_mandate_id: o.contents.id,
        merchant_name: o.merchantName,
        method_data: o.contents.payment_request.method_data.map((m: any) => m.data),
        payment_amount: o.contents.payment_request.details.total.amount,
        status: 'payment-required',
        base_fee: '0',
        gas_fee_configs: [{ network: opts.networkName, gas_fee_advanced: opts.gasFeeAdvanced ?? true }],
        cartmandate: { contents: o.contents, merchant_authorization: 'fake.jwt.sig' },
      };
    },
    prepare_payment: (a) => {
      const o = orders.get(a.flow_id) ?? fail('prepare_payment: unknown flow_id');
      if (a.protocol !== 'eip3009') fail('prepare_payment: protocol');
      const md = o.contents.payment_request.method_data[0].data;
      const token = tokenFor(md.chain_id, md.contract_address);
      const price = BigInt(Math.round(Number(o.contents.payment_request.details.total.amount.value) * 1e6));
      const raw = price + (opts.gasFeeAdvanced === false ? (opts.gasRaw ?? 0n) : 0n);
      const message = { from: getAddress(a.payer), to: o.payTo, value: raw.toString(), validAfter: '0', validBefore: String(now() + 600), nonce: `0x${randomBytes(32).toString('hex')}` };
      const eip712 = {
        domain: { name: token.name, version: token.version, chainId: md.chain_id, verifyingContract: token.address },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message,
      };
      const detailsId = `pd-${randomBytes(6).toString('hex')}`;
      const answer = {
        eip712,
        cart_hash: sha(o.contents),
        token_total_raw: raw.toString(),
        quote_expires_at: new Date((now() + 300) * 1000).toISOString(),
        pay_to: o.payTo,
        payer: getAddress(a.payer),
        payment_request_id: o.paymentRequestId,
        payment_details_id: detailsId,
        payment_details_total: (Number(raw) / 1e6).toFixed(2),
        payment_payload: { x402Version: 2, accepted: { scheme: 'exact', network: `eip155:${md.chain_id}`, asset: token.address, payTo: o.payTo, amount: raw.toString(), maxTimeoutSeconds: 600, extra: { protocol: 'eip3009' } }, payload: { signature: '', authorization: message } },
        payment_mandate_contents: { payment_mandate_id: o.paymentRequestId, payment_details_id: detailsId, merchant_agent: 'agentsettle' },
      };
      opts.tamper?.(answer);
      preps.set(message.nonce, { flowId: o.flowId, paymentRequestId: o.paymentRequestId, eip712: answer.eip712, raw });
      return answer;
    },
    finalize_payment: async (a) => {
      const p = preps.get(a.payment_payload?.payload?.authorization?.nonce) ?? fail('finalize_payment: unknown payment_payload');
      const { EIP712Domain: _, ...types } = p.eip712.types;
      const ok = await verifyTypedData({ address: p.eip712.message.from, domain: p.eip712.domain, types, primaryType: p.eip712.primaryType, message: p.eip712.message, signature: a.signature });
      if (!ok) fail('finalize_payment: the signature does not verify for the payer');
      p.signature = a.signature;
      const contents = { ...a.payment_mandate_contents, payment_response: { request_id: p.paymentRequestId, method_name: 'https://www.x402.org', details: { payment_payload: Buffer.from(JSON.stringify({ ...a.payment_payload, payload: { ...a.payment_payload.payload, signature: a.signature } })).toString('base64') } } };
      return { payment_mandate_json: JSON.stringify({ payment_mandate: { payment_mandate_contents: contents, user_authorization: 'fake.hs256.jwt' } }), payment_hash: sha(contents), cart_hash: a.cart_hash };
    },
    submit_payment: async (a) => {
      const pm = JSON.parse(a.payment_mandate_json).payment_mandate;
      const payload = JSON.parse(Buffer.from(pm.payment_mandate_contents.payment_response.details.payment_payload, 'base64').toString());
      const p = preps.get(payload.payload.authorization.nonce) ?? fail('submit_payment: unknown payment');
      if (!p.signature || payload.payload.signature !== p.signature) fail('submit_payment: not the finalized signature');
      p.tx = opts.broadcast ? await opts.broadcast(p) : undefined;
      return { data: { status: 'payment-submitted', payment_request_id: p.paymentRequestId } };
    },
    query_payment: (a) => {
      const o = orders.get(a.flow_id) ?? fail('query_payment: unknown flow_id');
      const p = [...preps.values()].find((x) => x.flowId === o.flowId && x.tx);
      const base = {
        merchant_name: o.merchantName,
        expected_merchant_name: a.expected_merchant_name,
        payment_request_id: o.paymentRequestId,
        flow_id: o.flowId,
        status: p ? 'payment-safe' : 'payment-required',
        attribution_verified: a.expected_merchant_name === o.merchantName,
        payment: {
          gas_fee_advanced: opts.gasFeeAdvanced ?? true,
          network: opts.networkName,
          chain: `eip155:${o.contents.payment_request.method_data[0].data.chain_id}`,
          payer_address: p?.eip712.message.from ?? '',
          to_pay_address: o.payTo,
          token_address: o.contents.payment_request.method_data[0].data.contract_address,
          tx_signature: p?.tx ?? '',
          amount: p ? (Number(p.raw) / 1e6).toString() : '',
          status: p ? 'payment-safe' : 'payment-required',
        },
      };
      return opts.query && p ? opts.query(p, base) : base;
    },
  };

  const sse = (c: any, body: unknown) =>
    c.body(`event: message\ndata: ${JSON.stringify(body)}\n\n`, 200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'fake-session' });

  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/', (c) => c.body(null, 405));
  app.delete('/', (c) => c.body(null, 200));
  app.post('/', async (c) => {
    const msg = await c.req.json();
    if (msg.id === undefined) return c.body(null, 202);
    if (msg.method === 'initialize') return sse(c, { jsonrpc: '2.0', id: msg.id, result: initialize });
    if (msg.method === 'tools/list') {
      return sse(c, { jsonrpc: '2.0', id: msg.id, result: { ...toolsList, tools: toolsList.tools.filter((t: any) => !(opts.dropTools ?? []).includes(t.name)) } });
    }
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      calls.push(name);
      try {
        const out = await tools[name]!(args ?? {});
        opts.rewrite?.(name, out);
        return sse(c, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out } });
      } catch (err) {
        return sse(c, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: (err as Error).message }], isError: true } });
      }
    }
    return sse(c, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
  });
  return { app, orders, preps, calls, rejected };
}

import { join } from 'node:path';
import { agentAccounts } from '../accounts.js';
import { payViaHspMcp } from '../agents/hsp-mcp-flow.js';
import type { Step } from '../agents/buyer.js';
import { getNetwork, keyEnvNames, loadDotEnv, type NetworkName } from '../config.js';
import { HSP_MCP_QA_URL, connectHspMcp, HspMcpClient } from '../rails/hsp-mcp.js';
import { DEFAULT_POLICY, FileLedger, SpendGuard } from '../spend-guard.js';
import { terminalHuman } from './prompt.js';

/**
 * ONE HSP Agentic Payment run: Agent A (W6) pays Agent B's (W5) cart mandate through HSP's MCP server, with the person
 * at the terminal confirming each value. Never in a loop, and it stops at the first blocked answer (the guide: do not
 * keep calling a blocked endpoint).
 *
 *   pnpm hsp:pay                       pay one 0.10 USD task (HSP_MCP_NETWORK=base-sepolia for the fallback chain)
 *   pnpm hsp:pay --query <flow_id>     one query_payment for a payment reported as "Pending confirmation"
 */
loadDotEnv();
const argv = process.argv.slice(2);
const queryFlow = argv.includes('--query') ? argv[argv.indexOf('--query') + 1] : undefined;
const netName = (process.env.HSP_MCP_NETWORK?.trim() || 'hashkey-testnet') as NetworkName;
if (netName !== 'hashkey-testnet' && netName !== 'base-sepolia') throw new Error(`HSP_MCP_NETWORK must be hashkey-testnet or base-sepolia, not ${netName}`);
const url = process.env.HSP_MCP_URL?.trim() || HSP_MCP_QA_URL;
const payNet = getNetwork(netName);
const { operator, buyer } = agentAccounts(netName);
const names = keyEnvNames(netName);
if (!operator || !buyer) throw new Error(`set ${names.operator} and ${names.buyer} in .env`);

const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(15_000) }).catch((err: Error) => err);
if (health instanceof Error || !health.ok) {
  console.error(`HSP MCP ${url} health: ${health instanceof Error ? health.message : `HTTP ${health.status}`}. Not retrying (a 403 means this IP is not allowlisted).`);
  process.exit(1);
}

const human = terminalHuman();
const session = await connectHspMcp(url);
let code = 1;
try {
  if (queryFlow) {
    const merchant = await human.ask('merchant_name used for this payment:');
    console.log(JSON.stringify(await new HspMcpClient(session.call).queryPayment(queryFlow, merchant), null, 2));
    code = 0;
  } else {
    console.log(`\nHSP Agentic Payment on ${payNet.name} (${payNet.caip2}) via ${url}`);
    console.log(`  Agent A (payer)  ${buyer.address}\n  Agent B (seller) ${operator.address}`);
    const show = (s: Step) => console.log(`  ${s.step.padEnd(16)} ${s.title}${s.link ? `\n  ${''.padEnd(16)} ${s.link}` : ''}`);
    const r = await payViaHspMcp({
      payNet,
      operator,
      payer: buyer,
      guard: new SpendGuard(DEFAULT_POLICY, new FileLedger(join(process.cwd(), 'data', `spend-ledger.${netName}.json`))),
      call: session.call,
      human,
      text: argv.includes('--text') ? argv[argv.indexOf('--text') + 1]! : 'Hello world, agents pay agents',
      onStep: show,
    });
    if (r.report) console.log(`\n${r.report}`);
    if (r.pending) console.log(`\nPending confirmation: flow_id ${r.pending.flowId} · payment_request_id ${r.pending.paymentRequestId}\nresume with: pnpm hsp:pay --query ${r.pending.flowId}`);
    code = r.ok ? 0 : 1;
  }
} finally {
  human.close();
  await session.close();
}
process.exit(code);

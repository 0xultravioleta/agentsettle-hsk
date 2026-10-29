import './style.css';

interface Step {
  step: string;
  title: string;
  at: string;
  detail?: Record<string, unknown>;
  link?: string;
}

interface Config {
  network: string;
  caip2: string;
  mainnet: boolean;
  explorer: string | null;
  receipts: string | null;
  receiptsLink: string | null;
  agents: { buyer: { address: string; link: string | null }; seller: { address: string; link: string | null } };
  facilitator: string;
  prices: { standard: string; premium: string };
  caps: { perTx: string; daily: string; spentToday: string };
  hsp: { mode: string; reason: string | null };
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (v: string, n = 6) => (v.length > 2 * n + 2 ? `${v.slice(0, n + 2)}…${v.slice(-n)}` : v);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let cfg: Config;

const ICON: Record<string, string> = {
  request: '→', payment_required: '402', spend_check: '✓', spend_denied: '✕', signed: '✍', paid_request: '↻',
  settled: '⛓', delivered: '📦', receipt: '🧾', hsp_pay: 'HSP', hsp_verify: '⚖', error: '!',
};

function link(href: string | null | undefined, text: string): string {
  return href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(text)}</a>` : `<span>${esc(text)}</span>`;
}

function txLink(hash: string | undefined): string {
  if (!hash || /^0x0+$/.test(hash)) return '<span class="muted">–</span>';
  return link(cfg.explorer ? `${cfg.explorer}/tx/${hash}` : null, short(hash));
}

function detailHtml(s: Step): string {
  const d = s.detail ?? {};
  if (s.step === 'payment_required' && Array.isArray(d.accepts)) {
    const a = d.accepts[0] as Record<string, unknown>;
    return `<pre>${esc(JSON.stringify({ scheme: a.scheme, network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo, extra: a.extra }, null, 2))}</pre>`;
  }
  if (s.step === 'signed') return `<div class="kv">from ${esc(short(String(d.from)))} → to ${esc(short(String(d.to)))} · value ${esc(String(d.value))} · nonce ${esc(short(String(d.nonce)))} · <b>gas paid by buyer: 0</b></div>`;
  if (s.step === 'spend_denied') return `<div class="kv deny">per-tx cap ${esc(String(d.perTxCap ?? ''))} · daily cap ${esc(String(d.dailyCap ?? ''))} · nothing was signed</div>`;
  if (s.step === 'spend_check') return `<div class="kv">spent today ${esc(String(d.spentToday))} / ${esc(String(d.dailyCap))} USDC</div>`;
  const tx = typeof d.tx === 'string' ? d.tx : undefined;
  if (tx) return `<div class="kv mono">${s.link ? link(s.link, tx) : esc(tx)}</div>`;
  if (s.link) return `<div class="kv">${link(s.link, s.link)}</div>`;
  return '';
}

async function animate(steps: Step[], title: string) {
  $('flow-title').textContent = title;
  const ol = $('timeline');
  ol.innerHTML = '';
  for (const s of steps) {
    const li = document.createElement('li');
    const cls = s.step === 'spend_denied' || s.step === 'error' ? 'bad' : s.step.startsWith('hsp') && /SIMULATED/.test(s.title) ? 'sim' : 'ok';
    li.className = `st ${cls}`;
    li.innerHTML = `<span class="ic">${ICON[s.step] ?? '•'}</span><div><div class="tt">${esc(s.title)}</div>${detailHtml(s)}</div>`;
    ol.appendChild(li);
    await new Promise((r) => setTimeout(r, 450));
  }
}

async function loadConfig() {
  cfg = await (await fetch('/api/config')).json();
  const netLabel = cfg.network === 'hashkey' ? 'HashKey Chain mainnet' : cfg.network === 'hashkey-testnet' ? 'HashKey Chain testnet' : 'local anvil';
  $('net-badge').textContent = `${netLabel} · ${cfg.caip2}`;
  $('net-badge').className = `badge ${cfg.mainnet ? 'main' : cfg.network === 'local' ? 'local' : 'test'}`;
  const c = $<HTMLAnchorElement>('contract-link');
  c.textContent = cfg.receipts ? `AgentSettleReceipts ${short(cfg.receipts)}` : 'receipts contract not deployed here';
  if (cfg.receiptsLink) c.href = cfg.receiptsLink;
  for (const [id, a] of [['buyer-addr', cfg.agents.buyer], ['seller-addr', cfg.agents.seller]] as const) {
    const el = $<HTMLAnchorElement>(id);
    el.textContent = a.address;
    if (a.link) el.href = a.link;
  }
  $('price-std').textContent = cfg.prices.standard;
  $('price-prem').textContent = cfg.prices.premium;
  $('cap-tx').textContent = cfg.caps.perTx;
  $('cap-day').textContent = cfg.caps.daily;
  $('facilitator').textContent = cfg.facilitator;
  $('hsp-mode').innerHTML = cfg.hsp.mode === 'sdk' ? '<b>live sandbox</b>' : `<span class="sim-tag">SIMULATED</span> ${esc(cfg.hsp.reason ?? '')}`;
  updateCaps(cfg.caps.spentToday);
}

function updateCaps(spent: string) {
  $('cap-spent').textContent = `${spent} / ${cfg.caps.daily} USDC`;
  $('cap-bar').style.width = `${Math.min(100, (Number(spent) / Number(cfg.caps.daily)) * 100)}%`;
}

async function loadReceipts() {
  const { receipts, error } = await (await fetch('/api/receipts')).json();
  const body = $('receipts-body');
  if (!receipts.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">${error ? esc(error) : 'no receipts yet: hire Agent B'}</td></tr>`;
    return;
  }
  body.innerHTML = receipts
    .map(
      (r: any) => `<tr>
        <td class="mono">${esc(short(r.taskId, 4))}</td>
        <td class="mono">${esc(short(r.payer, 4))} → ${esc(short(r.payee, 4))}</td>
        <td>${(Number(r.amount) / 1e6).toFixed(2)}</td>
        <td class="mono">${txLink(r.settleTx)}</td>
        <td class="mono">${txLink(r.tx)}</td>
        <td class="mono">${/^0x0+$/.test(r.hspPaymentId) ? '<span class="muted">x402</span>' : esc(short(r.hspPaymentId, 4))}</td>
      </tr>`,
    )
    .join('');
}

async function run(path: string, payload: Record<string, unknown>, title: string) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  $('timeline').innerHTML = '<li class="st wait"><span class="ic">…</span><div class="tt">Agent A is talking to Agent B…</div></li>';
  try {
    const r = await (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).json();
    await animate(r.steps ?? [], title);
  } catch (e) {
    await animate([{ step: 'error', title: String(e), at: '' }], title);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    const c = await (await fetch('/api/config')).json();
    updateCaps(c.caps.spentToday);
    await loadReceipts();
  }
}

const text = () => $<HTMLInputElement>('task-text').value;
$('btn-hire').addEventListener('click', () => run('/api/hire', { text: text() }, 'x402 on ' + cfg.caip2));
$('btn-premium').addEventListener('click', () => run('/api/hire', { text: text(), tier: 'premium' }, 'spend guardrail'));
$('btn-hsp').addEventListener('click', () => run('/api/hsp', { text: text() }, 'HSP rail'));

await loadConfig();
await loadReceipts();


import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hireViaHsp } from '../src/agents/hsp-flow.js';
import { ERC20_EIP3009_ABI, publicClientFor, walletClientFor } from '../src/chain.js';
import { ensureLocalChain, type LocalChain } from '../src/local-chain.js';
import { MerchantClient, formatDecimal } from '../src/rails/hsp-merchant.js';
import { MerchantHspRail, type HspOrder } from '../src/rails/hsp.js';
import { listReceipts } from '../src/receipts.js';
import type { Runtime } from '../src/runtime.js';
import { MemoryLedger, SpendGuard } from '../src/spend-guard.js';
import { fakeMerchantGateway, type FakeGateway } from './fake-merchant.js';
import { ensureForgeArtifacts, hasBinary, listen, startAnvil } from './helpers.js';

/**
 * The HSP flow end to end on anvil, against a fake HashKey Merchant gateway that checks our HMAC, canonical body,
 * ES256K JWT and cart_hash on its own. The payer is Agent A sending real (mock) USDC; the gateway then reports
 * whatever record the test chooses, including lies. Replaces round-1 P2-4 and round-2 P3-2 for the new rail.
 */

const canRun = hasBinary('anvil') && hasBinary('forge');
const creds = { appKey: 'ak_e2e', appSecret: 'as_e2e' };

describe.skipIf(!canRun)('HSP (HashKey Merchant) on anvil', () => {
  let stopAnvil = () => {};
  let chain: LocalChain;
  let gw: FakeGateway;
  let gwSrv: { url: string; close: () => Promise<void> };
  const merchantKey = generateKeyPairSync('ec', { namedCurve: 'secp256k1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

  beforeAll(async () => {
    ensureForgeArtifacts();
    const anvil = await startAnvil(23545 + Math.floor(Math.random() * 1000));
    stopAnvil = anvil.stop;
    chain = await ensureLocalChain({ rpcUrl: anvil.url, statePath: join(mkdtempSync(join(tmpdir(), 'agentsettle-hsp-')), 'c.json') });
    gw = fakeMerchantGateway({ ...creds, merchantPublicKeyPem: merchantKey.publicKey });
    gwSrv = await listen(gw.app);
  });
  afterAll(async () => {
    await gwSrv.close();
    stopAnvil();
  });

  const operator = () => privateKeyToAccount(chain.keys.operator);
  const buyer = () => privateKeyToAccount(chain.keys.buyer);
  const rt = (baseUrl = gwSrv.url): Runtime => ({
    net: chain.net,
    operator: operator(),
    buyer: buyer(),
    guard: new SpendGuard(undefined, new MemoryLedger()),
    hsp: new MerchantHspRail(chain.net, new MerchantClient({ baseUrl, creds }), { name: 'AgentSettle', privateKeyPem: merchantKey.privateKey }, creds.appSecret),
    facilitatorUrl: '',
    facilitatorLabel: '',
    close: () => {},
  });
  const transfer = async (to: Address, value: bigint): Promise<Hex> => {
    const hash = await walletClientFor(chain.net, buyer()).writeContract({ address: chain.net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'transfer', args: [to, value] });
    await publicClientFor(chain.net).waitForTransactionReceipt({ hash });
    return hash;
  };
  /** Agent A pays `value` to the order's payee, then the gateway reports a record (overridable to model a lying gateway). */
  const payer =
    (value: bigint, override: (tx: Hex) => Record<string, unknown> = () => ({})) =>
    async (order: HspOrder) => {
      const tx = await transfer(order.payTo, value);
      gw.setPayment(order.paymentRequestId, {
        status: 'payment-included',
        tx_signature: tx,
        payer_address: buyer().address,
        to_pay_address: order.payTo,
        token: 'USDC',
        token_address: chain.net.usdc.address,
        chain: chain.net.caip2,
        pay_amount: formatDecimal(order.amount, 6),
        extra_protocol: 'eip3009',
        ...override(tx),
      });
    };
  const fast = { waitMs: 5_000, pollMs: 50 };

  it('exact payment: cart mandate accepted by the gateway checks -> paid -> delivered -> receipt with the payment_request_id', async () => {
    const before = (await listReceipts(chain.net)).length;
    const r = await hireViaHsp(rt(), 'hello', { ...fast, taskRef: 'ok1', pay: payer(100_000n) });
    expect(r.ok, JSON.stringify(r.steps, null, 1)).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(['hsp_order', 'hsp_payment', 'delivered', 'receipt']);
    expect(gw.rejected).toEqual([]);
    const order = gw.orders.get('AS-ok1')!;
    expect(order.contents.payment_request.method_data[0].data).toMatchObject({ x402Version: 2, chain_id: 31337, pay_to: operator().address, coin: 'USDC' });
    expect(order.contents.payment_request.details.total.amount).toEqual({ currency: 'USD', value: '0.10' });
    const receipts = await listReceipts(chain.net);
    expect(receipts.length).toBe(before + 1);
    expect(receipts[0]!.hspPaymentId).toBe(keccak256(toHex('AS-PR-ok1')));
    expect(receipts[0]!.amount).toBe(100_000n);
  });

  it('P2-4: the gateway says 0.10 but the mined transfer is short: not delivered, no receipt', async () => {
    const before = (await listReceipts(chain.net)).length;
    const r = await hireViaHsp(rt(), 'hello', { ...fast, taskRef: 'short', pay: payer(99_999n) });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)!.title).toMatch(/does not show 0.10 USDC/);
    expect((await listReceipts(chain.net)).length).toBe(before);
  });

  it('P3-2: a record that points at an OLDER transfer of the same amount is not delivered', async () => {
    const old = await transfer(operator().address, 100_000n);
    const r = await hireViaHsp(rt(), 'hello', { ...fast, taskRef: 'old', pay: async (o) => gw.setPayment(o.paymentRequestId, { status: 'payment-finalized', tx_signature: old, payer_address: buyer().address, to_pay_address: o.payTo, token_address: chain.net.usdc.address, chain: chain.net.caip2, pay_amount: '0.10' }) });
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)!.title).toMatch(/not delivering/);
  });

  it('backup B: a person pays the checkout from their own wallet (not Agent A); the record must name the wallet that really paid', async () => {
    const person = privateKeyToAccount(generatePrivateKey());
    const gas = await walletClientFor(chain.net, buyer()).sendTransaction({ to: person.address, value: 10n ** 16n });
    await publicClientFor(chain.net).waitForTransactionReceipt({ hash: gas });
    await transfer(person.address, 200_000n);
    const payFrom = (claimed: Address) => async (o: HspOrder) => {
      const hash = await walletClientFor(chain.net, person).writeContract({ address: chain.net.usdc.address, abi: ERC20_EIP3009_ABI, functionName: 'transfer', args: [o.payTo, o.amount] });
      await publicClientFor(chain.net).waitForTransactionReceipt({ hash });
      gw.setPayment(o.paymentRequestId, { status: 'payment-included', tx_signature: hash, payer_address: claimed, to_pay_address: o.payTo, token_address: chain.net.usdc.address, chain: chain.net.caip2, pay_amount: formatDecimal(o.amount, 6) });
    };
    const r = await hireViaHsp(rt(), 'hello', { ...fast, taskRef: 'person', pay: payFrom(person.address) });
    expect(r.ok, JSON.stringify(r.steps, null, 1)).toBe(true);
    expect(r.steps.find((s) => s.step === 'delivered')!.detail).toMatchObject({ payer: person.address, payerIsAgentA: false });
    const receipt = (await listReceipts(chain.net)).find((x) => x.hspPaymentId === keccak256(toHex('AS-PR-person')));
    expect(receipt?.payer).toBe(person.address);
    // the same payment, but the record says Agent A paid it: the on-chain sender does not match, so no delivery
    const lie = await hireViaHsp(rt(), 'hello', { ...fast, taskRef: 'person-lie', pay: payFrom(buyer().address) });
    expect(lie.ok).toBe(false);
    expect(lie.steps.at(-1)!.title).toMatch(/does not show 0.10 USDC/);
  });

  it('a record for another payee, token, chain or amount is refused before the chain is even asked', async () => {
    for (const [ref, override, why] of [
      ['payee', { to_pay_address: '0x000000000000000000000000000000000000dEaD' }, /to_pay_address/],
      ['token', { token_address: '0x372325443233fEbaC1F6998aC750276468c83CC6' }, /token_address/],
      ['chain', { chain: 'eip155:133' }, /chain/],
      ['amount', { pay_amount: '0.11' }, /pay_amount/],
    ] as const) {
      const r = await hireViaHsp(rt(), 'hello', { ...fast, taskRef: `mm-${ref}`, pay: payer(100_000n, () => override) });
      expect(r.ok, ref).toBe(false);
      expect(r.steps.at(-1)!.title, ref).toMatch(why);
    }
  });

  it('payment-failed and an unpaid order (timeout) are not delivered', async () => {
    const failed = await hireViaHsp(rt(), 'hello', { ...fast, taskRef: 'failed', pay: async (o) => gw.setPayment(o.paymentRequestId, { status: 'payment-failed', status_reason: 'timeout reconciliation' }) });
    expect(failed.ok).toBe(false);
    expect(failed.steps.at(-1)!.title).toMatch(/payment-failed: timeout reconciliation: not delivering/);
    const unpaid = await hireViaHsp(rt(), 'hello', { waitMs: 300, pollMs: 50, taskRef: 'unpaid' });
    expect(unpaid.ok).toBe(false);
    expect(unpaid.steps.at(-1)!.title).toMatch(/no HSP payment on chain within/);
  });

  it('the spend cap applies before any order exists; a gateway error is a step, not an exception', async () => {
    const orders = gw.orders.size;
    const denied = await hireViaHsp(rt(), 'hello', { ...fast, taskRef: 'big', amount: 2_000_000n });
    expect(denied.ok).toBe(false);
    expect(denied.steps.map((s) => s.step)).toEqual(['spend_denied']);
    expect(gw.orders.size).toBe(orders);
    const down = await hireViaHsp(rt('http://127.0.0.1:9'), 'hello', { ...fast, taskRef: 'down' });
    expect(down.ok).toBe(false);
    expect(down.steps.at(-1)!.title).toMatch(/cart mandate not created/);
  });
});

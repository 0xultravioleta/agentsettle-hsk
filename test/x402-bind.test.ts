import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFunctionData, parseSignature, type Address, type Hex, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSeller, type Facilitator } from '../src/agents/seller.js';
import { ERC20_EIP3009_ABI, authorizationUsed, confirmTransfer, publicClientFor, walletClientFor } from '../src/chain.js';
import { ensureLocalChain, type LocalChain } from '../src/local-chain.js';
import { buildPaymentRequired, encodeHeader, signExactPayment } from '../src/rails/x402.js';
import { listReceipts } from '../src/receipts.js';
import { ensureForgeArtifacts, hasBinary, startAnvil } from './helpers.js';

/**
 * RHSK-1 P2-2: confirmTransfer must tie the Transfer to THE authorization it was asked about. Here one transaction
 * burns two bound nonces with 0-value self transfers and pays the seller once with a third nonce; neither burnt nonce
 * may count as paid, so re-sending their X-PAYMENTs gets no task and no receipt.
 */

const canRun = hasBinary('anvil') && hasBinary('forge');

describe.skipIf(!canRun)('x402: a payment is bound to its own authorization, not to any transfer in the same tx', () => {
  let stopAnvil = () => {};
  let chain: LocalChain;
  beforeAll(async () => {
    ensureForgeArtifacts();
    const anvil = await startAnvil(26545 + Math.floor(Math.random() * 1000));
    stopAnvil = anvil.stop;
    chain = await ensureLocalChain({ rpcUrl: anvil.url, statePath: join(mkdtempSync(join(tmpdir(), 'agentsettle-bind-')), 'c.json') });
  });
  afterAll(() => stopAnvil());

  const authCall = async (payer: LocalAccount, to: Address, value: bigint, nonce: Hex) => {
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
    const signature = await payer.signTypedData({
      domain: { name: chain.net.usdc.eip712.name, version: chain.net.usdc.eip712.version, chainId: chain.net.chainId, verifyingContract: chain.net.usdc.address },
      types: {
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
      message: { from: payer.address, to, value, validAfter: 0n, validBefore, nonce },
    });
    const { v, r, s } = parseSignature(signature);
    return encodeFunctionData({ abi: ERC20_EIP3009_ABI, functionName: 'transferWithAuthorization', args: [payer.address, to, value, 0n, validBefore, nonce, Number(v), r, s] });
  };

  /** One tx: burn `burnt` nonces with 0-value self transfers, then pay `to` 0.10 with `payNonce`. */
  const oneTx = async (payer: LocalAccount, to: Address, burnt: Hex[], payNonce: Hex): Promise<Hex> => {
    const artifact = JSON.parse(readFileSync('out/BatchCaller.sol/BatchCaller.json', 'utf8'));
    const relayer = walletClientFor(chain.net, privateKeyToAccount(chain.keys.facilitator));
    const pub = publicClientFor(chain.net);
    const batch = (await pub.waitForTransactionReceipt({ hash: await relayer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object }) })).contractAddress!;
    const data = [...(await Promise.all(burnt.map((n) => authCall(payer, payer.address, 0n, n)))), await authCall(payer, to, 100_000n, payNonce)];
    const hash = await relayer.writeContract({ address: batch, abi: artifact.abi, functionName: 'callAll', args: [chain.net.usdc.address, data] });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  };

  const nonce = (b: string) => `0x${b.repeat(32)}` as Hex;

  it('confirmTransfer accepts the nonce whose Transfer follows its AuthorizationUsed, and no other nonce of the tx', async () => {
    const payer = privateKeyToAccount(chain.keys.buyer);
    const seller = privateKeyToAccount(chain.keys.operator).address;
    const tx = await oneTx(payer, seller, [nonce('a1'), nonce('a2')], nonce('a0'));
    const expectPay = (n: Hex) => confirmTransfer(chain.net, tx, { from: payer.address, to: seller, value: 100_000n, nonce: n });
    expect(await expectPay(nonce('a0'))).toBe(true);
    expect(await expectPay(nonce('a1'))).toBe(false);
    expect(await expectPay(nonce('a2'))).toBe(false);
  });

  it('two tasks whose settle failed are not delivered or receipted when their nonces are burnt next to ONE payment', async () => {
    const net = chain.net;
    const operator = privateKeyToAccount(chain.keys.operator);
    const payer = privateKeyToAccount(chain.keys.buyer);
    // verify behaves like the real facilitator (a used nonce is refused); every first settle fails, so the nonce stays
    // bound to its text and a retry of the same X-PAYMENT goes through the reconcile path
    const facilitator: Facilitator = {
      verify: async (p: any) => ((await authorizationUsed(net, p.payload.authorization.from, p.payload.authorization.nonce)) ? { isValid: false, invalidReason: 'authorization_used' } : { isValid: true }) as any,
      settle: async () => ({ success: false, errorReason: 'transfer amount exceeds balance' }) as any,
    };
    const seller = createSeller({ net, operator, facilitator, publicUrl: 'http://seller.test', confirmTimeoutMs: 5_000 });
    const bound: Array<{ text: string; header: string; nonce: Hex }> = [];
    for (const text of ['task one', 'task two']) {
      const resource = { url: `http://seller.test/task/translate?text=${encodeURIComponent(text)}`, description: 'EN->ES translation by Agent B', mimeType: 'application/json' };
      const req = buildPaymentRequired(net, { payTo: operator.address, amount: 100_000n, resource }).accepts[0]!;
      const payment = await signExactPayment(payer, net, req, resource);
      const header = encodeHeader(payment);
      const first = await seller.request(`/task/translate?text=${encodeURIComponent(text)}`, { headers: { 'X-PAYMENT': header } });
      expect(first.status).toBe(502);
      bound.push({ text, header, nonce: payment.payload.authorization.nonce as Hex });
    }
    const tx = await oneTx(payer, operator.address, bound.map((b) => b.nonce), nonce('b0'));
    for (const b of bound) {
      const r = await seller.request(`/task/translate?text=${encodeURIComponent(b.text)}`, { headers: { 'X-PAYMENT': b.header } });
      expect([409, 502], `${b.text}: ${r.status} ${await r.clone().text()}`).toContain(r.status);
    }
    expect((await listReceipts(net)).filter((x) => x.settleTx === tx)).toHaveLength(0);
  });
});

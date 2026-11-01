import { describe, expect, it } from 'vitest';
import { zeroHash } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseFacilitatorRequest } from '../src/facilitator/local.js';
import { hspPaymentIdToBytes32, resultHashOf, taskIdFor } from '../src/receipts.js';
import { translateEnEs } from '../src/agents/translate.js';
import { priceFor } from '../src/agents/seller.js';

describe('receipts ids', () => {
  const payer = privateKeyToAccount(generatePrivateKey()).address;
  it('taskId is deterministic per payment and differs per nonce, payer and chain', () => {
    const n1 = `0x${'11'.repeat(32)}` as const;
    const n2 = `0x${'22'.repeat(32)}` as const;
    expect(taskIdFor(133, payer, n1)).toBe(taskIdFor(133, payer.toLowerCase() as any, n1));
    expect(taskIdFor(133, payer, n1)).not.toBe(taskIdFor(133, payer, n2));
    expect(taskIdFor(133, payer, n1)).not.toBe(taskIdFor(177, payer, n1));
  });
  it('hspPaymentId: bytes32 passes through, other strings are hashed, empty is zero', () => {
    const id = `0x${'ab'.repeat(32)}`;
    expect(hspPaymentIdToBytes32(id)).toBe(id);
    expect(hspPaymentIdToBytes32('pay_123')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hspPaymentIdToBytes32(undefined)).toBe(zeroHash);
  });
  it('resultHash is keccak of the utf-8 result', () => {
    expect(resultHashOf('hola')).not.toBe(resultHashOf('Hola'));
  });
});

const SIG = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;

describe('local facilitator request parsing', () => {
  const auth = {
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '100000',
    validAfter: '0',
    validBefore: '9999999999',
    nonce: `0x${'33'.repeat(32)}`,
  };
  const accepted = { scheme: 'exact', network: 'eip155:133', asset: '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6', amount: '100000', payTo: auth.to, maxTimeoutSeconds: 120 };
  it('reads the uvd-x402-sdk v2 envelope', () => {
    const r = parseFacilitatorRequest({ x402Version: 2, paymentPayload: { x402Version: 2, payload: { signature: SIG, authorization: auth } }, accepted, resource: {} });
    expect(typeof r).toBe('object');
  });
  it('reads the spec shape with paymentRequirements and maxAmountRequired', () => {
    const { amount, ...rest } = accepted;
    const r = parseFacilitatorRequest({ paymentPayload: { payload: { signature: SIG, authorization: auth } }, paymentRequirements: { ...rest, maxAmountRequired: amount } });
    expect(typeof r === 'object' && r.requirement.amount).toBe('100000');
  });
  it('refuses a zero amount and a signature that is not 65 bytes', () => {
    expect(parseFacilitatorRequest({ paymentPayload: { payload: { signature: SIG, authorization: { ...auth, value: '0' } } }, accepted: { ...accepted, amount: '0' } })).toMatch(/positive/);
    expect(parseFacilitatorRequest({ paymentPayload: { payload: { signature: SIG.slice(0, 130), authorization: auth } }, accepted })).toMatch(/65 bytes/);
  });

  it('names what is missing', () => {
    expect(parseFacilitatorRequest(undefined)).toMatch(/invalid_payload/);
    expect(parseFacilitatorRequest({ paymentPayload: { payload: { signature: SIG, authorization: { ...auth, value: '1.5' } } }, accepted })).toMatch(/value/);
    expect(parseFacilitatorRequest({ paymentPayload: { payload: { signature: SIG, authorization: { ...auth, nonce: '0x01' } } }, accepted })).toMatch(/nonce/);
  });
});

describe('task', () => {
  it('translates known words, keeps case, leaves the rest', () => {
    expect(translateEnEs('Hello world, agents pay agents!')).toBe('Hola mundo, agentes pagan agentes!');
  });
  it('prices standard 0.10 and premium 2.00', () => {
    expect(priceFor(undefined)).toEqual({ tier: 'standard', amount: 100_000n });
    expect(priceFor('premium')).toEqual({ tier: 'premium', amount: 2_000_000n });
    expect(priceFor('PREMIUM').tier).toBe('standard');
  });
});

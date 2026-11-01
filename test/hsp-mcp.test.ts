import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { resultReport } from '../src/agents/hsp-mcp-flow.js';
import { terminalHuman } from '../src/cli/prompt.js';
import { HSP_MCP_TOOLS, HspToolError, checkTypedData, connectHspMcp, hspPayNetwork, maxRawFor, selectToken, toSignable, type PreparedPayment } from '../src/rails/hsp-mcp.js';
import { RECORDED_CHAIN_CONFIG, fakeHspMcp, recorded } from './fake-hsp-mcp.js';
import { listen } from './helpers.js';

const USDC_133 = '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6' as Address;
const USDT_133 = '0x372325443233fEbaC1F6998aC750276468c83CC6' as Address;
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

describe('HSP MCP recorded answers', () => {
  it('the recorded tools/list has the eight tools of the guide', () => {
    expect(recorded('mcp-tools-list.sse').result.tools.map((t: { name: string }) => t.name).sort()).toEqual([...HSP_MCP_TOOLS].sort());
  });

  it('selectToken reads the token from get_chain_config as recorded: USDC on 133 (eip3009), Base Sepolia despite its duplicate row', () => {
    const hk = selectToken(RECORDED_CHAIN_CONFIG, { chainId: 133, address: USDC_133 });
    expect(hk.token).toMatchObject({ symbol: 'USDC', name: 'USD Coin', version: '2', decimals: 6, payment_protocol: 'eip3009' });
    expect(hk.network.name).toBe('hashkey-testnet');
    expect(selectToken(RECORDED_CHAIN_CONFIG, { chainId: 84532, address: USDC_BASE_SEPOLIA }).token).toMatchObject({ name: 'USDC', version: '2' });
    expect(() => selectToken(RECORDED_CHAIN_CONFIG, { chainId: 133, address: USDT_133 })).toThrow(/permit2, not eip3009/);
    expect(() => selectToken(RECORDED_CHAIN_CONFIG, { chainId: 177, address: USDC_133 })).toThrow(/no token/);
    const twisted = { ...RECORDED_CHAIN_CONFIG, tokens: [...RECORDED_CHAIN_CONFIG.tokens, { ...hk.token, version: '3' }] };
    expect(() => selectToken(twisted, { chainId: 133, address: USDC_133 })).toThrow(/different settings/);
  });
});

describe('checkTypedData: what we refuse to sign', () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const token = selectToken(RECORDED_CHAIN_CONFIG, { chainId: 133, address: USDC_133 }).token;
  const now = new Date('2026-11-01T18:00:00Z');
  const t = Math.floor(now.getTime() / 1000);
  const good = (): PreparedPayment => ({
    eip712: {
      domain: { name: 'USD Coin', version: '2', chainId: 133, verifyingContract: USDC_133 },
      types: {
        EIP712Domain: [],
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
      message: { from: payer.address, to: payTo, value: '100000', validAfter: '0', validBefore: String(t + 600), nonce: `0x${'ab'.repeat(32)}` },
    },
    cart_hash: 'c'.repeat(64),
    token_total_raw: '100000',
    quote_expires_at: new Date(now.getTime() + 300_000).toISOString(),
    pay_to: payTo,
    payer: payer.address,
    payment_request_id: 'AS-PR-1',
    payment_details_id: 'pd-1',
    payment_details_total: '0.10',
    payment_payload: {},
    payment_mandate_contents: {},
  });
  const expect0 = { chainId: 133, token, payer: payer.address, payTo, maxRaw: maxRawFor(100_000n), now };

  it('the exact transfer we agreed to passes, and what we sign recovers to the payer', async () => {
    expect(maxRawFor(100_000n)).toBe(110_000n);
    const prep = good();
    expect(checkTypedData(prep, expect0)).toBeUndefined();
    const typed = toSignable(prep.eip712);
    const sig = await payer.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature: sig })).toBe(payer.address);
    expect(typed.message.value).toBe(100_000n);
  });

  const cases: Array<[string, (p: PreparedPayment) => void, RegExp]> = [
    ['primaryType', (p) => (p.eip712.primaryType = 'PermitTransferFrom'), /primaryType is PermitTransferFrom/],
    ['types', (p) => (p.eip712.types.TransferWithAuthorization![2] = { name: 'value', type: 'uint128' }), /not the EIP-3009 struct/],
    ['domain extra field', (p) => (p.eip712.domain.salt = `0x${'00'.repeat(32)}`), /unexpected fields: salt/],
    ['domain.chainId', (p) => (p.eip712.domain.chainId = 84532), /domain.chainId is 84532, not 133/],
    ['domain.verifyingContract', (p) => (p.eip712.domain.verifyingContract = USDT_133), /verifyingContract is 0x3723/],
    ['domain name', (p) => (p.eip712.domain.name = 'USD Coin (fake)'), /domain is "USD Coin \(fake\)"/],
    ['domain version', (p) => (p.eip712.domain.version = '1'), /v1, not "USD Coin" v2/],
    ['message.from', (p) => (p.eip712.message.from = other), /message.from .* not the confirmed payer/],
    ['message.to', (p) => (p.eip712.message.to = other), /message.to .* not the confirmed pay_to/],
    ['token_total_raw not a number', (p) => (p.token_total_raw = '0.10'), /not a positive integer/],
    ['token_total_raw zero', (p) => ((p.token_total_raw = '0'), (p.eip712.message.value = '0')), /not a positive integer/],
    ['value above token_total_raw', (p) => (p.eip712.message.value = '100001'), /message.value 100001 is not token_total_raw 100000/],
    ['value below token_total_raw', (p) => (p.eip712.message.value = '99999'), /message.value 99999 is not token_total_raw 100000/],
    ['over the cap', (p) => ((p.token_total_raw = '110001'), (p.eip712.message.value = '110001')), /over the cap of 110000/],
    ['validAfter', (p) => (p.eip712.message.validAfter = 'soon'), /validAfter soon is not an integer/],
    ['validBefore passed', (p) => (p.eip712.message.validBefore = String(t)), /has already passed/],
    ['validBefore over 1 h', (p) => (p.eip712.message.validBefore = String(t + 3601)), /more than 60 min away/],
    ['nonce', (p) => (p.eip712.message.nonce = '0x1234'), /nonce is not a bytes32/],
  ];
  it.each(cases)('refuses: %s', (_name, mutate, why) => {
    const prep = good();
    mutate(prep);
    expect(checkTypedData(prep, expect0)).toMatch(why);
  });

  it('the struct is compared field by field, so a server writing {type, name} is not refused', () => {
    const prep = good();
    prep.eip712.types.TransferWithAuthorization = prep.eip712.types.TransferWithAuthorization!.map(({ name, type }) => ({ type, name }));
    expect(checkTypedData(prep, expect0)).toBeUndefined();
    const reordered = good();
    const f = reordered.eip712.types.TransferWithAuthorization!;
    [f[0], f[1]] = [f[1]!, f[0]!];
    expect(checkTypedData(reordered, expect0)).toMatch(/not the EIP-3009 struct/);
  });

  it('the cap edge: exactly price + 10% is signable (the payer may carry the gas fee)', () => {
    const prep = good();
    prep.token_total_raw = '110000';
    prep.eip712.message.value = '110000';
    expect(checkTypedData(prep, expect0)).toBeUndefined();
  });
});

describe('HSP MCP transport (Streamable HTTP, fake server replaying the recorded tools/list)', () => {
  const cfg = { chainConfig: RECORDED_CHAIN_CONFIG, networkName: 'hashkey-testnet' };

  it('connects, sees the eight tools and returns structured results checked against the live output schemas', async () => {
    const srv = await listen(fakeHspMcp(cfg).app);
    try {
      const s = await connectHspMcp(`${srv.url}/`);
      expect(s.tools.sort()).toEqual([...HSP_MCP_TOOLS].sort());
      expect(await s.call('get_chain_config', {})).toEqual(RECORDED_CHAIN_CONFIG);
      await expect(s.call('get_order', { flow_id: 'nope' })).rejects.toThrow(HspToolError);
      await s.close();
    } finally {
      await srv.close();
    }
  });

  it('refuses to go on when finalize_payment is missing (the guide: never pay without it)', async () => {
    const srv = await listen(fakeHspMcp({ ...cfg, dropTools: ['finalize_payment'] }).app);
    try {
      await expect(connectHspMcp(`${srv.url}/`)).rejects.toThrow(/missing finalize_payment/);
    } finally {
      await srv.close();
    }
  });
});

describe('which chain hsp:pay may pay on', () => {
  it('HashKey testnet by default, Base Sepolia as the fallback, and never mainnet or anything else', () => {
    expect(hspPayNetwork(undefined)).toBe('hashkey-testnet');
    expect(hspPayNetwork(' ')).toBe('hashkey-testnet');
    expect(hspPayNetwork('base-sepolia')).toBe('base-sepolia');
    expect(() => hspPayNetwork('hashkey')).toThrow(/must be hashkey-testnet or base-sepolia, not hashkey/);
    expect(() => hspPayNetwork('local')).toThrow(/not local/);
  });
});

describe('reporting and the terminal', () => {
  it('the result report says "unavailable" instead of inventing values', () => {
    const r = resultReport(undefined, 'AgentSettle', undefined);
    expect(r).toContain('Payment status: unavailable');
    expect(r).toContain('Hackathon team: AgentSettle');
    expect(r).toContain('Transaction hash: unavailable');
  });

  it('without a TTY nobody can confirm, so the payment does not start', () => {
    const was = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      expect(() => terminalHuman()).toThrow(/needs a person at the terminal/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: was, configurable: true });
    }
  });
});

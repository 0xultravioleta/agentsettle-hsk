import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTestClient, getAddress, http, parseEther, type Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { USDC, getNetwork, type NetworkConfig } from './config.js';
import { ERC20_EIP3009_ABI, publicClientFor, viemChain, walletClientFor } from './chain.js';

/**
 * Local chain for rehearsal, CI and judges without keys: anvil + MockEIP3009 ("USD Coin" v2, the same domain
 * as the HashKey testnet USDC) + AgentSettleReceipts. Fresh throwaway keys are generated here and kept in
 * data/local-chain.json (gitignored); nothing about them is secret beyond this machine.
 */

export interface LocalChain {
  net: NetworkConfig;
  keys: { operator: Hex; buyer: Hex; facilitator: Hex };
}

interface Saved {
  rpcUrl: string;
  chainId: number;
  usdc: Address;
  receipts: Address;
  keys: LocalChain['keys'];
}

function artifact(root: string, file: string, name: string): { abi: Abi; bytecode: Hex } {
  const p = join(root, 'out', file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`missing ${p}: run "forge build" first`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
}

function toNet(s: Saved): NetworkConfig {
  const base = getNetwork('local', { rpcUrl: s.rpcUrl, chainId: s.chainId, caip2: `eip155:${s.chainId}` });
  return { ...base, usdc: { ...base.usdc, address: s.usdc }, receiptsAddress: s.receipts };
}

/** Reuses data/local-chain.json while its contracts still exist on the node; otherwise deploys fresh. */
export async function ensureLocalChain(opts: { rpcUrl?: string; root?: string; statePath?: string; buyerUsdc?: bigint } = {}): Promise<LocalChain> {
  const root = opts.root ?? process.cwd();
  const statePath = opts.statePath ?? join(root, 'data', 'local-chain.json');
  const rpcUrl = opts.rpcUrl ?? getNetwork('local').rpcUrl;
  const probe = getNetwork('local', { rpcUrl });
  const pub = publicClientFor(probe);
  const chainId = await pub.getChainId();

  if (existsSync(statePath)) {
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as Saved;
    if (saved.rpcUrl === rpcUrl && saved.chainId === chainId) {
      const [a, b] = await Promise.all([pub.getCode({ address: saved.usdc }), pub.getCode({ address: saved.receipts })]);
      if (a && a !== '0x' && b && b !== '0x') return { net: toNet(saved), keys: saved.keys };
    }
  }

  const keys = { operator: generatePrivateKey(), buyer: generatePrivateKey(), facilitator: generatePrivateKey() };
  const operator = privateKeyToAccount(keys.operator);
  const buyer = privateKeyToAccount(keys.buyer);
  const facilitator = privateKeyToAccount(keys.facilitator);
  const test = createTestClient({ chain: viemChain({ ...probe, chainId }), mode: 'anvil', transport: http(rpcUrl) });
  // gas for the operator (deploy + receipts) and the facilitator (settles); the buyer never pays gas on x402
  await test.setBalance({ address: operator.address, value: parseEther('100') });
  await test.setBalance({ address: facilitator.address, value: parseEther('100') });
  await test.setBalance({ address: buyer.address, value: parseEther('1') });

  const net0 = { ...probe, chainId, caip2: `eip155:${chainId}` as const };
  const wallet = walletClientFor(net0, operator);
  const mock = artifact(root, 'MockEIP3009.sol', 'MockEIP3009');
  const rec = artifact(root, 'AgentSettleReceipts.sol', 'AgentSettleReceipts');
  const usdcTx = await wallet.deployContract({ abi: mock.abi, bytecode: mock.bytecode, args: ['USD Coin', '2'] });
  const usdc = (await pub.waitForTransactionReceipt({ hash: usdcTx })).contractAddress!;
  const recTx = await wallet.deployContract({ abi: rec.abi, bytecode: rec.bytecode, args: [operator.address] });
  const receipts = (await pub.waitForTransactionReceipt({ hash: recTx })).contractAddress!;
  const mintTx = await wallet.writeContract({ address: usdc, abi: ERC20_EIP3009_ABI, functionName: 'mint', args: [buyer.address, opts.buyerUsdc ?? USDC(10)] });
  await pub.waitForTransactionReceipt({ hash: mintTx });

  const saved: Saved = { rpcUrl, chainId, usdc: getAddress(usdc), receipts: getAddress(receipts), keys };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  return { net: toNet(saved), keys };
}

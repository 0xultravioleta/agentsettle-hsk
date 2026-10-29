# Funding route: HSK and USDC on HashKey Chain mainnet (177)

Researched 2026-10-29, read-only: `cast call` against `https://mainnet.hsk.xyz` and an Ethereum public RPC, CoinGecko,
and the HashKey docs. **Nothing was bought, bridged, signed or moved.** Every number below must be re-checked and approved by
the owner with the exact amount before anyone sends anything (brief §5, hard rule 2).

## What to send, and why that much

Measured, not estimated:
- **Gas price** is 500.001 gwei, read with `cast gas-price` and stable across every check on Oct 29.
- **HSK** is $0.088113 (CoinGecko `hashkey-ecopoints`).
- **Deploy gas** comes from `forge script` simulating `Deploy.s.sol`.
- **`recordReceipt` gas** is the `gasUsed` of a real receipt tx on anvil (185,942). The brief guessed 90k: eight fresh storage slots cost more.

| Wallet | Pays for | Gas | HSK needed | Send | Buffer |
|---|---|---|---|---|---|
| **W1** `0x103040545AC5031A11E8C03dd11324C7333a13C7` (facilitator signer) | 30 × `transferWithAuthorization` (~100k each, FiatToken v2.2) | 3,000,000 | 1.50 | **5 HSK** | 3.3× |
| **W3** `0xAaB1a67023A3ff5d7ebf64262491d144b6080bAc` (operator) | deploy `AgentSettleReceipts` (413,515) + 20 × `recordReceipt` (185,942) | 4,132,355 | 2.07 | **5 HSK** | 2.4× |
| **W4** `0x83F074aF971Eef404B84dA63bb1f1a6D0fce44C4` (buyer) | settlement float, not gas: 20 tasks × 0.10 USDC; it flows W4 → W3, both ours | – | 0 | **5 USDC** (`0x054e…8D0a`) | 2.5× |
| **Total** | | 7.13M | **3.57 HSK ≈ $0.31** | **10 HSK (≈ $0.88) + 5 USDC** | |

- The L1 data fee on this OP-stack chain is negligible: about 0.00007 HSK for a 3.5 KB deploy.
- The P1 EAS attestations are not built. If they are added, W3 needs about +1.9 HSK for 20 attestations and the schema, and 5 HSK still covers that.
- To re-check before sending, run `cast gas-price --rpc-url https://mainnet.hsk.xyz`.

## HSK (the gas token)

Native HSK is the chain's custom gas token. Its Ethereum ERC-20 is `0xE7C6BF469e97eEB0bFB74C8dbFF5BD47D4C1C98a`: `SystemConfig.gasPayingToken()` on L1 returns it. The official bridge turns ERC-20 HSK into native HSK.

**Recommended route: a CEX that withdraws HSK on the "HashKey Chain" network, straight to W1 and W3.**

| Exchange | HashKey Chain withdrawal | Status |
|---|---|---|
| HashKey Global | Yes, says its help center ("HSK on both HashKey Chain and ERC20") | the help pages answer 403 to scripts: fee, minimum and region **unconfirmed** |
| KuCoin | Yes, per a May 2025 announcement ("withdraw HSK to the HashKey Chain mainnet") | fee and minimum **unconfirmed** |
| HashKey Exchange (HK) | Yes, but for professional investors only | not practical |
| MEXC, Gate, LBank, CoinW, Kraken | HSK spot markets exist | whether they offer the HashKey Chain network or only ERC-20 is **unconfirmed** |

- **Buy about 14 HSK** (≈ $1.25). That covers 10 HSK delivered plus up to 2 HSK of withdrawal fee each. Exchange minimum order sizes (≈ $1–5) will dominate the cost.
- **If the minimum withdrawal is too high,** withdraw about 11 HSK to W1 once and forward 5 HSK to W3 on-chain. The transfer costs 21k gas, ≈ 0.0105 HSK.
- **Fallback:** withdraw ERC-20 HSK on Ethereum, then bridge it at https://bridge.hashkeychain.net (Superbridge). This needs a little ETH for L1 gas (≈ $0.15 today at 0.24 gwei).

## USDC (`0x054ed45810DbBAb8B27668922D110669c9D88D0a`, "Bridged USDC")

**It cannot be bought on HashKey Chain.** These facts were verified on Oct 29:
- The only WHSK/USDC pool is `0xB580D654…0E02` (Uniswap V3 factory `0x972cA9D1…c742`, 0.3%), and it holds **0.0768 USDC**. The 1% pool is empty.
- USDT (`0xf1b5…9029`) has a deep pool, about 221k USDT. It is useless here because it has no EIP-3009 and no permit.
- Total supply is **1,781.54 USDC**.
- The token is Circle's "Bridged USDC Standard" (op-usdc):
  - `masterMinter()` = `0x7BC37573d5CC18E9C42AC5c48FbE6BBFD95A68b1`, the L2 adapter.
  - Its `LINKED_ADAPTER()` = `0xa5939F60212C3DB032032C1176e5Ac00bCEFc60E` on Ethereum.
  - That L1 adapter's `USDC()` = Ethereum USDC `0xA0b86991…eB48`.
  - `sendMessage(address,uint256,uint32)` (selector `0x4c598b56`) is present in the adapter's implementation `0xf8989cdc…43ac`.
- The **standard** bridge does not mint it. Only the adapter does.
- No CEX was found that withdraws USDC on HashKey Chain.

**Recommended route: Ethereum USDC → Circle op-usdc L1 adapter → `0x054e…` on HashKey, with W4 as the L2 recipient.**

1. Get **about 8 USDC** on an Ethereum wallet we control: 5 to bridge, plus a cushion for the exchange's ERC-20 withdrawal fee. Also get **about 0.001 ETH** (≈ $2.3) for gas.
2. On Ethereum, `approve` the L1 adapter for 5 USDC, then call `sendMessage(W4, 5000000, <minGasLimit>)`. The two transactions total ≈ 250k gas, about $0.15 at 0.24 gwei. Alternatively, use the Superbridge UI if it routes USDC through the adapter (**unconfirmed**).
3. Wait for the OP-stack deposit, usually 1–3 min (**unconfirmed** for HashKey). Then check: `cast call 0x054ed45810DbBAb8B27668922D110669c9D88D0a "balanceOf(address)(uint256)" 0x83F074aF971Eef404B84dA63bb1f1a6D0fce44C4 --rpc-url https://mainnet.hsk.xyz` → `5000000`.

A cheaper shortcut exists but is not ours to take: an existing holder sends 5 USDC directly. The top holder is an EOA with about 1,203 USDC.

## Total

| Leg | Cost |
|---|---|
| HSK | ≈ $1.25 (≈ $5 if an exchange minimum binds) |
| USDC | 5 USDC (recoverable: it ends in W3) + ≈ $3 withdrawal cushion + ≈ $2.3 ETH + ≈ $0.15 L1 gas |
| **All in** | **≈ $12–16**, mostly exchange fees and minimums; the HashKey gas itself is ≈ $0.31 |

## Still unconfirmed

1. HSK withdrawal fee and minimum on HashKey Chain at HashKey Global and KuCoin, and HashKey Global's region and KYC rules.
2. Whether MEXC, Gate, LBank, CoinW or Kraken offer the HashKey Chain network for HSK.
3. The HSKSwap router and factory: the app answers 403 "jurisdiction restricted" here. The V3 factory above is the one in use on-chain.
4. Whether the Superbridge UI routes USDC through the op-usdc adapter, and the exact deposit time.
5. The `_minGasLimit` to pass to `sendMessage`. Read Circle's op-usdc docs or a past deposit on the adapter before sending.

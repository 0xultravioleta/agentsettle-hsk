# Wallets

Public addresses only. The private keys were generated with `cast wallet new` on 2026-10-29 and live **only** in the
operator's local `.env` (gitignored, mode 600). They were never printed, logged or committed.

| ID | Role | Network | Address | `.env` variable |
|---|---|---|---|---|
| W1 | x402 facilitator signer: pays the gas of every mainnet settle (Ultravioleta, key held by c0der) | HashKey mainnet (177) | `0x103040545AC5031A11E8C03dd11324C7333a13C7` | not here |
| W2 | x402 facilitator signer, testnet (Ultravioleta) | HashKey testnet (133) | `0x34033041a5944B8F10f8E4D8496Bfb84f1A293A8` | not here |
| **W3** | **Agent B / operator**: receives the USDC, deploys `AgentSettleReceipts`, writes receipts | HashKey mainnet (177) | `0xAaB1a67023A3ff5d7ebf64262491d144b6080bAc` | `OPERATOR_PRIVATE_KEY` |
| **W4** | **Agent A / buyer**: signs EIP-3009 authorizations, never pays gas on x402 | HashKey mainnet (177) | `0x83F074aF971Eef404B84dA63bb1f1a6D0fce44C4` | `BUYER_PRIVATE_KEY` |
| **W5** | Testnet copy of W3 (also the gas wallet of the local dev facilitator on testnet) | HashKey testnet (133) | `0xfc104F3666Aeaf5BE5361E149B2B1015D0F9A38D` | `TESTNET_OPERATOR_PRIVATE_KEY` |
| **W6** | Testnet copy of W4 (HSP `pay()` settles from this wallet, so it needs test HSK too) | HashKey testnet (133) | `0xc9eAB77D415EcDf7FAA93130ff74F402FF99E289` | `TESTNET_BUYER_PRIVATE_KEY` |

USDC only moves W4 → W3 (both ours): the settlement float is parked, not spent. W1 is never used as a deployer.
Funding amounts and routes: [FUNDING.md](FUNDING.md).

Local runs (`scripts/demo.sh` with no flags) do not use any of these: they generate throwaway keys on anvil.

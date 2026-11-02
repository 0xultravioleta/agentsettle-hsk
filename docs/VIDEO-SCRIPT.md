# Demo video: quick recording (browser only, about 2 minutes)

This is the fast version: no terminal run, only pages that already exist. Every hash on screen is real. The full shot list with the terminal demo is in [`kit/video-script.md`](kit/video-script.md).

- **Record:** macOS Cmd+Shift+5 → "Record Entire Screen", microphone on (Options). 1080p is enough.
- **Before recording:** open the six tabs below in order and close anything with keys, `.env`, emails or tokens.
- **Upload:** YouTube, Unlisted, title `AgentSettle (HSP, x402) | HashKey Chain Horizon Hackathon, Agent Payments & A2A Settlement`. Paste the URL in the DoraHacks BUIDL → Edit → + Video.

| # | Time | Tab on screen | Voice-over |
|---|---|---|---|
| 1 | 0:00–0:20 | Repo: https://github.com/0xultravioleta/agentsettle-hsk (README diagram) | Agents can now hire other agents and pay them. AgentSettle gives them three things: a payment request over HTTP, settlement they can verify on-chain, and a receipt anyone can check. |
| 2 | 0:20–0:45 | README, "How it works" section | Agent A asks Agent B for a task. B answers HTTP 402 with a USDC price. A checks its spend policy and signs an EIP-3009 authorization, so it never needs gas. An x402 facilitator settles the transfer on-chain, and B delivers. |
| 3 | 0:45–1:05 | Settle tx: https://sepolia.etherscan.io/tx/0x817c2d667ab5509b84d7aeb37ce1f568cc446b7b97eed3bac6940e7a1d4fc8dc | As HashKey asks, the payment test runs on Ethereum Sepolia with Circle's official USDC. This is a real 10-cent payment from Agent A to Agent B, settled by AgentSettle's facilitator. |
| 4 | 1:05–1:20 | Receipt tx: https://sepolia.etherscan.io/tx/0x56c3e28c7e00d133779e1a0385a4f491c118809c69080195f4c3c1cb583200c0 | After delivering, B writes a receipt to our AgentSettleReceipts contract. It links the settlement tx, the payer and a hash of the work. The receipt id comes from the payment itself, so a retry can never write a second receipt. |
| 5 | 1:20–1:35 | Mainnet contract: https://explorer.hsk.xyz/address/0xb8956dFe5819b9828b6D55315bFB871c443f08a1 | The same contract is deployed and verified on HashKey Chain mainnet, chain 177, ready for the migration. |
| 6 | 1:35–1:50 | Facilitator PR: https://github.com/UltravioletaDAO/x402-rs/pull/132 | We also added HashKey Chain mainnet and testnet to Ultravioleta's open-source production x402 facilitator, settling Bridged USDC. |
| 7 | 1:50–2:05 | README, "How we use HashKey Chain and HSP" table (`src/rails/hsp-mcp.ts`, `src/spend-guard.ts`) | The HSP rail uses HSP Agentic Payment, HashKey's MCP server: a cart mandate, and an EIP-712 authorization the agent checks field by field before signing. It is built and tested, and its first QA payment waits for HashKey testnet USDC. Spend caps keep agents in bounds: 50 cents per transaction, 5 dollars a day, so a 2-dollar request is refused before anything is signed. |
| 8 | 2:05–2:15 | Back to the repo | AgentSettle, by Ultravioleta DAO. The repo, the contract and the facilitator PR are linked below. |

## Checklist
- [ ] Every link above opens before recording.
- [ ] No keys, seeds, emails or tokens on screen.
- [ ] Do not say HSP paid live: its first QA payment has not happened yet.

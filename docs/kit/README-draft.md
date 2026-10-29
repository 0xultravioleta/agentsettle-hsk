# AgentSettle (HSP, x402)

> Agents hire and pay each other on HashKey Chain: HSP settlement plus an x402 facilitator with HashKey support, with ERC-8004 receipts.

**Built for HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement.** Demo video: [VIDEO_URL] · Live demo: [DEMO_URL]

## What it does
Agent A asks Agent B for a paid micro-task. B answers HTTP 402 with a USDC price on HashKey Chain mainnet (eip155:177). A signs an EIP-3009 authorization (no gas) and our x402 facilitator settles it on-chain. B delivers and writes a receipt to the AgentSettleReceipts contract on mainnet. The same task also runs through HSP on testnet: mandate, wallet settlement, independent HSPVerifier ACCEPT. Per-transaction and daily spend caps keep the agent in bounds.

## Why
Agent-to-agent commerce needs three things: a way to ask for payment over HTTP, a settlement layer with compliance controls, and a receipt others can trust. HashKey's HSP provides the second. Our open-source x402 facilitator provides the first, across 43 networks, so we added HashKey Chain.

## How it works
We added hashkey (chain 177) and hashkey-testnet (133) to Ultravioleta's Rust x402 facilitator, settling Bridged USDC (0x054e…8D0a) via EIP-3009. The TypeScript agents use our x402 SDK on mainnet and the HSP SDK (pay, payX402, HSPVerifier) on the HSP testnet sandbox. AgentSettleReceipts is deployed on HashKey Chain mainnet at [CONTRACT_ADDRESS].

```
Agent A ──GET /task──▶ Agent B ──402 (USDC, eip155:177)──▶ A signs EIP-3009 ──▶ x402 facilitator settles on HashKey ──▶ B delivers ──▶ AgentSettleReceipts.recordReceipt() (mainnet)
                                   └── testnet: HSP mandate ──▶ wallet settles ──▶ Coordinator observes ──▶ HSPVerifier ACCEPT
```

## How we use HashKey Chain mainnet + HSP SDK
- **HashKey Chain mainnet (177):** facilitator network `hashkey` in `UltravioletaDAO/x402-rs` ([PR_URL]: `src/network.rs`, `config/supported_tokens.json`); USDC `0x054ed45810DbBAb8B27668922D110669c9D88D0a` (EIP-712 "Bridged USDC" v2). Settlement txs: [TX_LINKS on explorer.hsk.xyz].
- **Contract:** `contracts/AgentSettleReceipts.sol`, deployed and verified at [CONTRACT_ADDRESS] (https://explorer.hsk.xyz/address/[CONTRACT_ADDRESS]).
- **HSP SDK:** `src/rails/hsp.ts` calls `HSPClient.pay()`, `payX402()` and `HSPVerifier.verify()` against the HSP sandbox on hashkey-testnet (USDC `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6`). Coordinator explorer: [HSP_EXPLORER_LINK].
- **x402:** `src/rails/x402.ts` (uvd-x402-sdk-typescript → facilitator.ultravioletadao.xyz, network `eip155:177`).

## Try it (judges: under 5 minutes)
1. `git clone [REPO_URL] && cd [REPO]`
2. `cp .env.example .env` and fill the test values listed in `.env.example` (no real keys in the repo).
3. `npm install && npm run dev` (or `docker compose up`).
4. Open http://localhost:3000 → do **[STEP]** → see **[RESULT]**.
5. Hosted demo: [DEMO_URL] (test login in the submission's testing instructions, never in the repo).

## Built during the hackathon
Everything in this repo was written during the submission period unless listed here. Pre-existing services used only through their public APIs: Execution Market, PayBox, Ultravioleta x402 facilitator (https://github.com/UltravioletaDAO/x402-rs), ERC-8004 contracts. Commit range: [FIRST_COMMIT]…[LAST_COMMIT].

## Challenges and what we learned
A 60-hour window and a new chain. HashKey's USDC is EIP-3009 but its USDT has neither EIP-3009 nor permit, so we settled in USDC and checked every token's EIP-712 domain against the chain. Bridged USDC liquidity on mainnet is thin, and HSP and x402 had to coexist in one receipt. HSP's mandate, receipt and verifier model maps cleanly onto x402: an x402 settlement is just another observable settlement. Verifying locally (ACCEPT means ship) is what makes agent-to-agent payments trustworthy.

## What's next
Ship an HSP settlement adapter for our facilitator so every x402 payment on HashKey becomes an HSP receipt, add KYC and sanctions-gated tasks, and onboard Execution Market tasks paid on HashKey.

## Team
Ultravioleta DAO: Luis ([LUIS_X_HANDLE]) and c0der.

## License
MIT (see LICENSE). Must be visible in the GitHub About panel.

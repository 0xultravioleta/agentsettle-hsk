# SUBMISSION: HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement

- **Submit at:** https://dorahacks.io/hackathon/hskchainindia/detail → Submit BUIDL
- **Deadline:** Mon Nov 2, 2026, 21:30 IST = **16:00 UTC** = 11:00 AM EST (Nov 3, 00:00 Beijing). It covers registration and submission. DoraHacks closes the form automatically at that time and takes no late submissions. Read from the DoraHacks page on Nov 1, 2026: its countdown and timeline end at 2026-11-02 16:00 UTC. An older section of the page says Nov 1, 21:30 IST, but at 16:06 UTC on Nov 1 the page still showed "23 hours left", so Nov 2, 16:00 UTC is the cut-off. Internal freeze: [the owner sets it again after the extension].
- **Format:** remote. The BUIDL is submitted on DoraHacks and the presentation is online. Per the page, the venue is Mumbai and online demo participants get a fixed time slot (missing it forfeits the demo). Selected pitch teams are announced Nov 3; Demo Day is Nov 4.
- **Source:** the first draft in `docs/kit/form-fields.md`, corrected so every claim matches what this repo actually does. This file is now the only copy of the fields.
- **Rule:** nobody registered, saved or submitted anything. Luis pastes and submits. Replace every `[PLACEHOLDER]` first.

> **Before pasting, check two things.**
> - **The `[IF HSP LIVE]` sentences.** Keep them only if `pnpm hsp:pay` reached `payment-safe` or `payment-finalized` on HSP QA, B confirmed the transfer on-chain and the receipt was written (its tx link goes in README). Otherwise use the `[IF HSP NOT LIVE]` variant.
> - **Changes from the kit:**
>   - The kit's vision said "with ERC-8004 receipts". That is not built (it is P2), so the vision now says "on-chain receipts".
>   - The kit stated HSP as done. It is now conditional.
>   - The kit describes HSP as an SDK (`pay`, `payX402`, `HSPVerifier`). The organizer clarified that HSP is the HashKey Merchant API (cart mandates, checkout, payment queries, webhooks), and this file now describes that. The rest of `docs/kit/` (click list, deck outline, video script, social post) was corrected the same way, with the same `[IF HSP LIVE]` choice. `form-fields.md` and `README-draft.md` now point here and to README.md.

### BUIDL name · 23 chars
```text
AgentSettle (HSP, x402)
```

### Logo
```text
[LOGO: square 512×512 PNG; not in the repo yet]
```

### Vision (one line, ≤150 self-imposed) · 129 chars
```text
Agents hire and pay each other on HashKey Chain: HSP settlement plus an x402 facilitator with HashKey support, on-chain receipts.
```

### Category / key domains
```text
Category: Infrastructure / Payments. Domains: AI agents, payments, stablecoins, hashkey-chain, hsp, x402
```

### Links (GitHub, website, demo video, social)
```text
GitHub: https://github.com/0xultravioleta/agentsettle-hsk
Demo video: [YOUTUBE_URL]
Deck: [DECK_URL]
Facilitator PR: https://github.com/UltravioletaDAO/x402-rs/pull/132
```

### Description (markdown)
```markdown
## Inspiration
Agent-to-agent commerce needs three things: a way to ask for payment over HTTP, a settlement layer with compliance controls, and a receipt others can trust. HashKey's HSP provides the second. Our open-source x402 facilitator provides the first, across 43 networks, so we added HashKey Chain.

## What it does
Agent A asks Agent B for a paid micro-task. B answers HTTP 402 with a USDC price. A checks its spend policy, signs an EIP-3009 authorization (no gas), and an x402 facilitator settles it on-chain. B delivers and writes a receipt to the AgentSettleReceipts contract, linking the settlement tx, the payer and a hash of the work. As HashKey asks, the payment test runs on Ethereum Sepolia with Circle's official USDC: our contract there is 0x751b5509aa6F1186077B39e36902e7D54C76a4aF (source verified on Sourcify, exact match), a 0.10 USDC payment settled in https://sepolia.etherscan.io/tx/0x817c2d667ab5509b84d7aeb37ce1f568cc446b7b97eed3bac6940e7a1d4fc8dc and its receipt is https://sepolia.etherscan.io/tx/0x56c3e28c7e00d133779e1a0385a4f491c118809c69080195f4c3c1cb583200c0. Our production facilitator has no exact scheme on Ethereum Sepolia, so AgentSettle's own facilitator settles there, and our operator wallet pays the gas. AgentSettleReceipts is also deployed and verified on HashKey Chain mainnet (eip155:177), ready for the migration: 0xb8956dFe5819b9828b6D55315bFB871c443f08a1, deploy tx 0x9f86a83512b32dc223336420bef95bc05d93c8c1613b1d1c0e6454d0a2caba8c, verified source on Blockscout at https://explorer.hsk.xyz/address/0xb8956dFe5819b9828b6D55315bFB871c443f08a1. [IF HSP LIVE] The same task also runs through HSP Agentic Payment, HashKey's MCP server, on testnet. B gets a cart mandate and A pays it itself. The server prepares the EIP-712 authorization, and A checks every field before signing with its own key: token, chain, payer, recipient, amount cap and validity. A person approves before signing, and again before the signature leaves for HSP. B delivers only after the mined transfer consumes that exact authorization, and the receipt carries the HSP payment request id. [IF HSP NOT LIVE] The HSP rail is built and tested, waiting for HashKey testnet USDC (0x8FE3…, the only token HSP Agentic Payment accepts) for its first QA payment. It uses HSP Agentic Payment, HashKey's MCP server: a cart mandate, an EIP-712 authorization checked field by field before A signs it, submission and payment queries. Per-transaction (0.50 USDC) and daily (5 USDC) caps keep the agent in bounds: a 2 USDC request is refused before anything is signed.

## How we built it
We added hashkey (chain 177) and hashkey-testnet (133) to Ultravioleta's Rust x402 facilitator, settling Bridged USDC (0x054e…8D0a) via EIP-3009. The TypeScript agents use viem to sign and our x402 SDK (uvd-x402-sdk) to call the facilitator; the HSP rail talks to HSP Agentic Payment over MCP (Streamable HTTP, the official TypeScript SDK). No key goes to the server: A checks the EIP-712 authorization and signs it locally. We also built a rail for the HashKey Merchant REST API (HMAC-signed requests, an ES256K merchant JWT, signed webhooks) and kept it off the critical path. AgentSettleReceipts (Solidity, Foundry) is deployed on HashKey Chain mainnet at 0xb8956dFe5819b9828b6D55315bFB871c443f08a1 and on Ethereum Sepolia at 0x751b5509aa6F1186077B39e36902e7D54C76a4aF. The receipt id is derived from the payment itself, so a retried delivery can never write a second receipt.

## Challenges we ran into
A 60-hour window and a new chain. HashKey's USDC is EIP-3009 but its USDT has neither EIP-3009 nor permit, so we settled in USDC and checked every token's EIP-712 domain against the chain. Bridged USDC on mainnet can only be minted through Circle's bridge adapter (the on-chain pool holds cents). HashKey then asked teams to test USDC payments on Ethereum Sepolia with Circle's USDC, where our production facilitator has no exact scheme, so AgentSettle gained that network and settles there with its own facilitator. HSP and x402 had to coexist in one receipt.

## Accomplishments that we're proud of
HashKey Chain is now a supported network in a production x402 facilitator, on mainnet and testnet. AgentSettleReceipts is deployed and verified on HashKey Chain mainnet, ready for the migration. A real 0.10 USDC payment with Circle's USDC on Ethereum Sepolia went from the 402 to the on-chain receipt: https://sepolia.etherscan.io/tx/0x817c2d667ab5509b84d7aeb37ce1f568cc446b7b97eed3bac6940e7a1d4fc8dc. Every guard in the payment path has a test that fails if the guard is removed.

## What we learned
HSP cart mandates use x402 as their payment method (x402Version 2, EIP-3009 USDC), so both rails end in the same kind of on-chain transfer and the same receipt. When a server prepares the data an agent signs, the agent has to check every field itself, because that signature is what moves the money. And B never takes a gateway's word alone: it checks the transfer on-chain before delivering.

## What's next for AgentSettle (HSP, x402)
Let agents pay HSP mandates under a pre-approved spending policy where HSP allows it, add KYC and sanctions-gated tasks, attest each receipt with EAS, and onboard Execution Market tasks paid on HashKey.
```

### Team
```text
Team: Luis ([LUIS_FULL_NAME], @[LUIS_X_HANDLE], lead and submitter) · c0der ([C0DER_NAME], engineering; add as teammate only if Luis decides) · Built with help from AI coding agents.
```

### Track
```text
Agent Payments & A2A Settlement
```

### Contract address on HashKey Chain mainnet (required for demo eligibility)
```text
0xb8956dFe5819b9828b6D55315bFB871c443f08a1
```

### Organizer questions
```text
[Fill after opening the BUIDL form]
```

## Placeholders to fill (and who has them)

| Placeholder | Source |
|---|---|
| ~~`[CONTRACT_ADDRESS]`~~ | filled: `0xb8956dFe5819b9828b6D55315bFB871c443f08a1` (deployed by W3 on 2026-11-01, tx 0x9f86a83512b32dc223336420bef95bc05d93c8c1613b1d1c0e6454d0a2caba8c, verified, https://explorer.hsk.xyz/address/0xb8956dFe5819b9828b6D55315bFB871c443f08a1) |
| ~~`[TESTNET_CONTRACT_ADDRESS]`~~ | filled: `0xaE84CA772f0ECA0Af6A79bEd82270Bb41F1A6Df1` (verified, https://testnet-explorer.hskchain.net/address/0xaE84CA772f0ECA0Af6A79bEd82270Bb41F1A6Df1) |
| ~~`[REPO_URL]`~~ | filled: https://github.com/0xultravioleta/agentsettle-hsk (public since 2026-11-02) |
| ~~`[PR_URL]`~~ | filled: https://github.com/UltravioletaDAO/x402-rs/pull/132 (merged, live in 2.52.0) |
| `[YOUTUBE_URL]`, `[DECK_URL]`, `[LOGO]` | after recording and upload |
| ~~`[SEPOLIA_CONTRACT]`, `[SEPOLIA_SETTLE_TX]`, `[SEPOLIA_RECEIPT_TX]`~~ | filled on 2026-11-02: contract 0x751b5509aa6F1186077B39e36902e7D54C76a4aF (deploy tx 0xab517821080f941aee7e0cf9193caa9f3d080d8835ef4293f4ec17842942df5d, Sourcify exact match), settle 0x817c2d667ab5509b84d7aeb37ce1f568cc446b7b97eed3bac6940e7a1d4fc8dc, receipt 0x56c3e28c7e00d133779e1a0385a4f491c118809c69080195f4c3c1cb583200c0 |
| `[LAST_COMMIT]` | the last commit before submitting |
| `[LUIS_FULL_NAME]`, `[LUIS_X_HANDLE]`, `[C0DER_NAME]` | Luis |

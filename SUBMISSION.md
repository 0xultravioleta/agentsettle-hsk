# SUBMISSION: HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement

- **Submit at:** https://dorahacks.io/hackathon/hskchainindia/detail → Submit BUIDL
- **Deadline:** Sun Nov 1, 2026, 11:00 AM EST (21:30 IST). Internal freeze: Sat Oct 31, 10:00 PM EDT.
- **Source:** `docs/kit/form-fields.md` (kit), corrected so every claim matches what this repo actually does.
- **Rule:** nobody registered, saved or submitted anything. Luis pastes and submits. Replace every `[PLACEHOLDER]` first.

> **Before pasting, check two things.**
> - **The `[IF HSP LIVE]` sentences.** Keep them only if `scripts/demo.sh --network hashkey-testnet` showed a real **HSPVerifier: ACCEPT**. If the rail is still a stub, use the `[IF HSP NOT LIVE]` variant.
> - **Changes from the kit:**
>   - The kit's vision said "with ERC-8004 receipts". That is not built (it is P2), so the vision now says "on-chain receipts".
>   - The kit stated HSP as done. It is now conditional.

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
GitHub: [REPO_URL]
Demo video: [YOUTUBE_URL]
Deck: [DECK_URL]
Facilitator PR: [PR_URL]
```

### Description (markdown)
```markdown
## Inspiration
Agent-to-agent commerce needs three things: a way to ask for payment over HTTP, a settlement layer with compliance controls, and a receipt others can trust. HashKey's HSP provides the second. Our open-source x402 facilitator provides the first, across 43 networks, so we added HashKey Chain.

## What it does
Agent A asks Agent B for a paid micro-task. B answers HTTP 402 with a USDC price on HashKey Chain mainnet (eip155:177). A checks its spend policy, signs an EIP-3009 authorization (no gas), and our x402 facilitator settles it on-chain. B delivers and writes a receipt to the AgentSettleReceipts contract on mainnet, linking the settlement tx, the payer and a hash of the work. [IF HSP LIVE] The same task also runs through HSP on testnet: mandate, wallet settlement, independent HSPVerifier ACCEPT, and a receipt that carries the HSP paymentId. [IF HSP NOT LIVE] The HSP rail (pay, payX402, HSPVerifier) is wired behind one interface and runs on the HSP testnet sandbox. Per-transaction (0.50 USDC) and daily (5 USDC) caps keep the agent in bounds: a 2 USDC request is refused before anything is signed.

## How we built it
We added hashkey (chain 177) and hashkey-testnet (133) to Ultravioleta's Rust x402 facilitator, settling Bridged USDC (0x054e…8D0a) via EIP-3009. The TypeScript agents use viem to sign and our x402 SDK (uvd-x402-sdk) to call the facilitator; the HSP rail uses HashKey's HSP SDK (pay, payX402, HSPVerifier) on the testnet sandbox. AgentSettleReceipts (Solidity, Foundry) is deployed on HashKey Chain mainnet at [CONTRACT_ADDRESS]. The receipt id is derived from the payment itself, so a retried delivery can never write a second receipt.

## Challenges we ran into
A 60-hour window and a new chain. HashKey's USDC is EIP-3009 but its USDT has neither EIP-3009 nor permit, so we settled in USDC and checked every token's EIP-712 domain against the chain. Bridged USDC on mainnet can only be minted through Circle's bridge adapter (the on-chain pool holds cents), so even funding the demo took a route through Ethereum. HSP and x402 had to coexist in one receipt.

## Accomplishments that we're proud of
HashKey Chain is now a supported network in a production x402 facilitator, with mainnet settlements, a deployed contract and one receipt per paid task. Every guard in the payment path has a test that fails if the guard is removed.

## What we learned
HSP's mandate, receipt and verifier model maps cleanly onto x402: an x402 settlement is just another observable settlement. Verifying locally (ACCEPT means ship) is what makes agent-to-agent payments trustworthy.

## What's next for AgentSettle (HSP, x402)
Ship an HSP settlement adapter for our facilitator so every x402 payment on HashKey becomes an HSP receipt, add KYC and sanctions-gated tasks, attest each receipt with EAS, and onboard Execution Market tasks paid on HashKey.
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
[CONTRACT_ADDRESS]
```

### Organizer questions
```text
[Fill after opening the BUIDL form]
```

## Placeholders to fill (and who has them)

| Placeholder | Source |
|---|---|
| `[CONTRACT_ADDRESS]` | mainnet deploy of `AgentSettleReceipts` (after the owner's OK); also in README.md |
| `[TESTNET_CONTRACT_ADDRESS]` | testnet deploy (after faucet HSK reaches W5) |
| `[REPO_URL]` | after the owner approves making the repo public |
| `[PR_URL]` | the x402-rs HashKey PR |
| `[YOUTUBE_URL]`, `[DECK_URL]`, `[LOGO]` | after recording and upload |
| `[HSP_EXPLORER_LINK]` | `<COORDINATOR_URL>/explorer` once the sandbox credentials arrive |
| `[TX_LINKS on explorer.hsk.xyz]`, `[LAST_COMMIT]` | after the mainnet run |
| `[LUIS_FULL_NAME]`, `[LUIS_X_HANDLE]`, `[C0DER_NAME]` | Luis |

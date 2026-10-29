# Form fields: HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement

- **Submit at:** https://dorahacks.io/hackathon/hskchainindia/detail → Submit BUIDL
- **Deadline:** Sun Nov 1, 2026, 11:00 AM EST (21:30 IST)
- **Brief:** briefs/03-hsk-horizon.md (GO, Oct 29)
- **Rule:** copy each block as-is. Replace every `[PLACEHOLDER]` first. Grok Bot did NOT register, save or submit anything.

Source: DoraHacks 'Create new BUIDL' form (BUIDL name, logo, vision one-liner, category, key domains, GitHub, website/prototype, demo video, social links, description markdown, then track + organizer questions on 'Submit for review'). DoraHacks publishes no character limits; the vision is kept ≤150 to be safe. Tip from DoraHacks guides: include the sponsor SDK names in the BUIDL name.

### BUIDL name · 23 chars
```text
AgentSettle (HSP, x402)
```
### Logo
```text
assets/logo.png (square, 512×512)
```
### Vision (one line, ≤150 self-imposed) · 134 chars ✅
```text
Agents hire and pay each other on HashKey Chain: HSP settlement plus an x402 facilitator with HashKey support, with ERC-8004 receipts.
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
### Description (markdown) · 2095 chars
```markdown
## Inspiration
Agent-to-agent commerce needs three things: a way to ask for payment over HTTP, a settlement layer with compliance controls, and a receipt others can trust. HashKey's HSP provides the second. Our open-source x402 facilitator provides the first, across 43 networks, so we added HashKey Chain.

## What it does
Agent A asks Agent B for a paid micro-task. B answers HTTP 402 with a USDC price on HashKey Chain mainnet (eip155:177). A signs an EIP-3009 authorization (no gas) and our x402 facilitator settles it on-chain. B delivers and writes a receipt to the AgentSettleReceipts contract on mainnet. The same task also runs through HSP on testnet: mandate, wallet settlement, independent HSPVerifier ACCEPT. Per-transaction and daily spend caps keep the agent in bounds.

## How we built it
We added hashkey (chain 177) and hashkey-testnet (133) to Ultravioleta's Rust x402 facilitator, settling Bridged USDC (0x054e…8D0a) via EIP-3009. The TypeScript agents use our x402 SDK on mainnet and the HSP SDK (pay, payX402, HSPVerifier) on the HSP testnet sandbox. AgentSettleReceipts is deployed on HashKey Chain mainnet at [CONTRACT_ADDRESS].

## Challenges we ran into
A 60-hour window and a new chain. HashKey's USDC is EIP-3009 but its USDT has neither EIP-3009 nor permit, so we settled in USDC and checked every token's EIP-712 domain against the chain. Bridged USDC liquidity on mainnet is thin, and HSP and x402 had to coexist in one receipt.

## Accomplishments that we're proud of
HashKey Chain is now a supported network in a production x402 facilitator, with mainnet settlements and a deployed contract.

## What we learned
HSP's mandate, receipt and verifier model maps cleanly onto x402: an x402 settlement is just another observable settlement. Verifying locally (ACCEPT means ship) is what makes agent-to-agent payments trustworthy.

## What's next for AgentSettle (HSP, x402)
Ship an HSP settlement adapter for our facilitator so every x402 payment on HashKey becomes an HSP receipt, add KYC and sanctions-gated tasks, and onboard Execution Market tasks paid on HashKey.
```
### Team
```text
Team (placeholders): Luis ([LUIS_FULL_NAME], @[LUIS_X_HANDLE], lead and submitter) · c0der ([C0DER_NAME], engineering; add as teammate only if Luis decides) · Built with help from AI coding agents.
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

## Track selection
```text
Agent Payments & A2A Settlement
```

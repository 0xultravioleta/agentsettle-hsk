# Deck outline + speaker notes: AgentSettle (HSP, x402) (HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement)

10 slides, 16:9. Export to PDF for upload. Visual style: dark violet (#2B0A3D) background, white text, one accent colour, a screenshot on every slide after 3.

## Slide 1: Title
**On slide:**
AgentSettle (HSP, x402)
Agents paying agents, settled on HashKey Chain.

**Speaker notes:**
Hi, I'm Luis from Ultravioleta. Agents paying agents, settled on HashKey Chain. This is AgentSettle (HSP, x402), built for HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement.

## Slide 2: The problem
**On slide:**
Agent-to-agent commerce needs three things: a way to ask for payment over HTTP, a settlement layer with compliance controls, and a receipt others can trust. HashKey's HSP provides the second. Our open-source x402 facilitator provides the first, across 43 networks, so we added HashKey Chain.

**Speaker notes:**
Set up the pain in one story. Name a real person or worker type. 20 seconds.

## Slide 3: The solution
**On slide:**
Agents hire and pay each other on HashKey Chain: HSP settlement plus an x402 facilitator with HashKey support, with ERC-8004 receipts.

**Speaker notes:**
One sentence, then go straight to the demo.

## Slide 4: Live demo
**On slide:**
Flow: request → task → claim → evidence → AI check → payout → reputation

**Speaker notes:**
Play the 60–90 s demo clip. Pause on the payout confirmation and on the AI's reasons.

## Slide 5: How it works
**On slide:**
We added hashkey (chain 177) and hashkey-testnet (133) to Ultravioleta's Rust x402 facilitator, settling Bridged USDC (0x054e…8D0a) via EIP-3009. The TypeScript agents use our x402 SDK on mainnet and the HSP SDK (pay, payX402, HSPVerifier) on the HSP testnet sandbox. AgentSettleReceipts is deployed on HashKey Chain mainnet at [CONTRACT_ADDRESS].

**Speaker notes:**
Architecture diagram. Point at the sponsor component first.

## Slide 6: Sponsor tech: HashKey Chain mainnet + HSP SDK
**On slide:**
Exact APIs used, and where in the code

**Speaker notes:**
Judges score sponsor usage heavily. Show the file names and one log line or tx hash.

## Slide 7: What's new in this hackathon
**On slide:**
New repo or module, commit range, demo stats: [N tasks / N payouts / N users]

**Speaker notes:**
Be explicit about what existed before and what is new.

## Slide 8: Challenges and learnings
**On slide:**
A 60-hour window and a new chain. HashKey's USDC is EIP-3009 but its USDT has neither EIP-3009 nor permit, so we settled in USDC and checked every token's EIP-712 domain against the chain. Bridged USDC liquidity on mainnet is thin, and HSP and x402 h

**Speaker notes:**
One honest challenge, one lesson.

## Slide 9: What's next
**On slide:**
Ship an HSP settlement adapter for our facilitator so every x402 payment on HashKey becomes an HSP receipt, add KYC and sanctions-gated tasks, and onboard Execution Market tasks paid on HashKey.

**Speaker notes:**
Concrete next steps with dates if possible.

## Slide 10: Team and links
**On slide:**
Luis, c0der · Ultravioleta DAO
Repo · Demo · Video

**Speaker notes:**
Thank the sponsor. Show the QR code to the demo.

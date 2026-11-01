# Deck outline + speaker notes: AgentSettle (HSP, x402) (HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement)

10 slides, 16:9. Export to PDF for upload. Visual style: dark violet (#2B0A3D) background, white text, one accent colour, a screenshot on every slide after 3. Every claim here matches `SUBMISSION.md`. Where it says `[IF HSP LIVE]` / `[IF HSP NOT LIVE]`, keep the same variant as in SUBMISSION.md.

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
One agent needs a translation and another agent sells it. Today there is no standard way for the first to pay the second and prove it. 20 seconds.

## Slide 3: The solution
**On slide:**
Agents hire and pay each other on HashKey Chain: HSP settlement plus an x402 facilitator with HashKey support, on-chain receipts.

**Speaker notes:**
One sentence, then go straight to the demo.

## Slide 4: Live demo
**On slide:**
Flow: GET /task → 402 (USDC, eip155:177) → spend check → EIP-3009 signature (no gas) → facilitator settles → delivery → recordReceipt

**Speaker notes:**
Play the 60–90 s demo clip. Pause on the settle tx on explorer.hsk.xyz and on the 2 USDC request the spend policy refuses.

## Slide 5: How it works
**On slide:**
We added hashkey (chain 177) and hashkey-testnet (133) to Ultravioleta's Rust x402 facilitator, settling Bridged USDC (0x054e…8D0a) via EIP-3009. The agents sign with viem and call the facilitator through our x402 SDK. On the HSP rail, Agent A pays through HSP Agentic Payment (MCP) and signs locally after checking what the server prepared. AgentSettleReceipts is deployed on HashKey Chain mainnet at 0xb8956dFe5819b9828b6D55315bFB871c443f08a1.

**Speaker notes:**
Architecture diagram. Point at the sponsor component first.

## Slide 6: Sponsor tech: HashKey Chain mainnet + HSP (HashKey Merchant API)
**On slide:**
- HashKey Chain mainnet (177): facilitator network `hashkey` (x402-rs #132, live in 2.52.0), USDC `0x054e…8D0a` via EIP-3009, `AgentSettleReceipts` at `0xb8956dFe5819b9828b6D55315bFB871c443f08a1`
- HSP Agentic Payment (MCP): `src/rails/hsp-mcp.ts`, `src/agents/hsp-mcp-flow.ts`: `create_order` → `prepare_payment` → our field-by-field check of the EIP-712 data → Agent A signs → `finalize_payment` → `submit_payment` → `query_payment`, with a person confirming each step

**Speaker notes:**
Judges score sponsor usage heavily. Show the file names and one settle tx hash. [IF HSP LIVE] Show the `pnpm hsp:pay` run: the two approvals, payment-safe and its tx. [IF HSP NOT LIVE] Say the rail is built and tested, and waits for testnet USDC for its first payment.

## Slide 7: What's new in this hackathon
**On slide:**
New repo, commit range `cac5ebf`…[LAST_COMMIT], the HashKey networks in the facilitator (x402-rs #132), demo stats: [N mainnet settlements / N receipts]

**Speaker notes:**
Existed before: the x402 facilitator and its TypeScript SDK. New: HashKey support in the facilitator, the agents, the contract, the HSP rail and the console.

## Slide 8: Challenges and learnings
**On slide:**
HashKey's USDC is EIP-3009 but its USDT has neither EIP-3009 nor permit, so we settled in USDC and checked every token's EIP-712 domain against the chain. Bridged USDC on mainnet can only be minted through Circle's bridge adapter, so even funding the demo took a route through Ethereum.

**Speaker notes:**
One honest challenge, one lesson: never trust a gateway's word alone. Agent B checks the payment record against the order and the transfer on-chain before it delivers.

## Slide 9: What's next
**On slide:**
Let agents pay HSP mandates under a pre-approved spending policy where HSP allows it, add KYC and sanctions-gated tasks, attest each receipt with EAS, and onboard Execution Market tasks paid on HashKey.

**Speaker notes:**
Concrete next steps with dates if possible.

## Slide 10: Team and links
**On slide:**
Luis, c0der · Ultravioleta DAO
Repo · Video · Contract 0xb8956dFe5819b9828b6D55315bFB871c443f08a1

**Speaker notes:**
Thank the sponsor. Show the repo link and the contract page.

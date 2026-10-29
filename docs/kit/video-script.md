# Demo video script + shot list: AgentSettle (HSP, x402)

- **Limit:** about 2:00 (no published limit; keep it short). Target length 2:50 or less.
- **Record:** 1080p screen capture (OBS), voice-over by Luis in English (Spanish subtitles optional). No copyrighted music; use YouTube Audio Library or silence.
- **Upload:** YouTube, Public (or Unlisted if the rules allow), title: `AgentSettle (HSP, x402) | HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement`.

| Time | Shot (what's on screen) | Beat | Voice-over |
|---|---|---|---|
| 0:00–0:10 | Title: AgentSettle, agents paying agents on HashKey Chain | Hook | Agents can now hire other agents, and pay them, on HashKey Chain. |
| 0:10–0:25 | Diagram: Agent A → 402 → pay → Agent B → receipt | Problem | To do that, agents need a payment request over HTTP, settlement they can verify, and a receipt anyone can check. We built all three on HashKey. |
| 0:25–0:50 | Terminal + UI: A asks B to translate; B returns 402 with a USDC price on eip155:177 | Demo 1: 402 | Agent A asks Agent B for a task. B replies 402 Payment Required: 10 cents of USDC on HashKey Chain mainnet. |
| 0:50–1:10 | A signs (no gas); the facilitator settles; the tx opens on explorer.hsk.xyz | Demo 2: settle (sponsor) | A signs an EIP-3009 authorization. It never touches gas. Our open-source x402 facilitator, which now supports HashKey Chain, settles it on mainnet. |
| 1:10–1:25 | B delivers; recordReceipt tx; contract page [CONTRACT_ADDRESS] | Demo 3: receipt | B delivers, and writes a receipt to our AgentSettleReceipts contract on mainnet. It links the payment, the payer and a hash of the work. |
| 1:25–1:45 | hsp.pay() → Coordinator explorer → HSPVerifier ACCEPT | Demo 4: HSP (sponsor) | The same flow on HSP: the agent signs a mandate, settles from its own wallet, and we verify the receipt ourselves. ACCEPT means ship. |
| 1:45–1:55 | Spend cap rejects a 2 USDC request | Demo 5: guardrails | Agents get guardrails: per-transaction and daily caps. |
| 1:55–2:00 | End card: repo, contract address, facilitator PR | CTA | AgentSettle, by Ultravioleta DAO. Links below. |

## Pre-record checklist
- [ ] Demo data seeded; test accounts logged in; notifications off.
- [ ] Every number on screen is real (tx hash, batch id).
- [ ] No keys, seeds, emails or tokens visible on screen.
- [ ] Cut to ≤ limit; captions burned in or uploaded as SRT.

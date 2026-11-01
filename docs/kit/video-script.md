# Demo video script + shot list: AgentSettle (HSP, x402)

- **Length:** about 2:00 (no published limit; keep it short).
- **Record:** 1080p screen capture (OBS), voice-over by Luis in English (Spanish subtitles optional). No copyrighted music; use YouTube Audio Library or silence.
- **Upload:** YouTube, Public (or Unlisted if the rules allow), title: `AgentSettle (HSP, x402) | HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement`.
- **HSP row:** record the `[IF HSP LIVE]` shot only if SUBMISSION.md keeps the `[IF HSP LIVE]` sentence; otherwise record the `[IF HSP NOT LIVE]` one.

| Time | Shot (what's on screen) | Beat | Voice-over |
|---|---|---|---|
| 0:00–0:10 | Title: AgentSettle, agents paying agents on HashKey Chain | Hook | Agents can now hire other agents, and pay them, on HashKey Chain. |
| 0:10–0:25 | Diagram: Agent A → 402 → pay → Agent B → receipt | Problem | To do that, agents need a payment request over HTTP, settlement they can verify, and a receipt anyone can check. We built all three on HashKey. |
| 0:25–0:50 | Terminal + UI: A asks B to translate; B returns 402 with a USDC price on eip155:177 | Demo 1: 402 | Agent A asks Agent B for a task. B replies 402 Payment Required: 10 cents of USDC on HashKey Chain mainnet. |
| 0:50–1:10 | A signs (no gas); the facilitator settles; the tx opens on explorer.hsk.xyz | Demo 2: settle (sponsor) | A signs an EIP-3009 authorization. It never touches gas. Our open-source x402 facilitator, which now supports HashKey Chain, settles it on mainnet. |
| 1:10–1:25 | B delivers; recordReceipt tx; contract page https://explorer.hsk.xyz/address/0xb8956dFe5819b9828b6D55315bFB871c443f08a1 | Demo 3: receipt | B delivers, and writes a receipt to our AgentSettleReceipts contract on mainnet. It links the payment, the payer and a hash of the work. |
| 1:25–1:45 | [IF HSP LIVE] `pnpm hsp:pay`: merchant_name, pay_to and payer confirmed; "Sign?" and "Submit?" approved; payment-safe; the tx on testnet-explorer.hskchain.net; receipt with the payment_request_id | Demo 4: HSP (sponsor) | The same task over HSP Agentic Payment, HashKey's MCP server. Agent A pays the cart mandate itself. The server prepares what to sign, and the agent checks every field first: token, chain, recipient, amount. I approve, it signs with its own key, and B delivers only once that exact transfer is on-chain. |
| 1:25–1:45 | [IF HSP NOT LIVE] `src/agents/hsp-mcp-flow.ts` and its tests | Demo 4: HSP (sponsor) | HSP Agentic Payment, HashKey's MCP server, is wired in: cart mandate, a field-by-field check of what the agent signs, submission and payment queries. Its first payment waits for testnet USDC. |
| 1:45–1:55 | Spend cap rejects a 2 USDC request | Demo 5: guardrails | Agents get guardrails: a 50-cent cap per transaction and 5 dollars a day. A 2-dollar request is refused before anything is signed. |
| 1:55–2:00 | End card: repo, contract address, facilitator PR | CTA | AgentSettle, by Ultravioleta DAO. Links below. |

## Pre-record checklist
- [ ] Mainnet runs done; their tx links are in README.md and SUBMISSION.md.
- [ ] Every number on screen is real (tx hash, contract address).
- [ ] No keys, seeds, emails or tokens visible on screen (`.env` and the SSM console stay closed).
- [ ] Cut to about 2:00; captions burned in or uploaded as SRT.

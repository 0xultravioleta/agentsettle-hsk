# Luis click list: HashKey Chain Horizon Hackathon (Mumbai), Agent Payments & A2A Settlement


- **URL:** https://dorahacks.io/hackathon/hskchainindia/detail → Submit BUIDL
- **Deadline:** Mon Nov 2, 2026, 21:30 IST = **16:00 UTC** = 11:00 AM EST (Nov 3, 00:00 Beijing). It covers registration and submission. DoraHacks closes the form automatically at that time and takes no late submissions. Read from the DoraHacks page on Nov 1, 2026: its countdown and timeline end at 2026-11-02 16:00 UTC. An older section of the page says Nov 1, 21:30 IST, but at 16:06 UTC on Nov 1 the page still showed "23 hours left", so Nov 2, 16:00 UTC is the cut-off.
- **Format:** remote. The BUIDL is submitted on DoraHacks and the presentation is online. Per the page, the venue is Mumbai and online demo participants get a fixed time slot (missing it forfeits the demo). Selected pitch teams are announced Nov 3; Demo Day is Nov 4.
- **Copy from:** `SUBMISSION.md` at the repo root (in form order), video from `video-script.md`, deck PDF from `deck-outline.md`.

## Fill these placeholders first (only Luis has them)
Search SUBMISSION.md for `[` and replace: repo URL (after Luis approves making it public), video URL (after upload), deck URL, logo, personal fields (name, handles) and the mainnet tx links. The mainnet contract address is already filled in. Keep either the `[IF HSP LIVE]` or the `[IF HSP NOT LIVE]` sentence; SUBMISSION.md says how to tell which.

## Before submit day (only Luis)
- [ ] DoraHacks login → Register as Hacker on hskchainindia.
- [ ] HSP: register the merchant on the HashKey Merchant QA gateway with the data in `docs/hsp/REGISTRATION.md`, then put app_key and app_secret into AWS SSM with the recipe there (never in chat, `.env` or the repo).
- [ ] Mainnet: fund W3 `0xAaB1a67023A3ff5d7ebf64262491d144b6080bAc` (5 HSK) and W4 `0x83F074aF971Eef404B84dA63bb1f1a6D0fce44C4` (5 USDC). The deploy and 5 to 10 runs are approved (Oct 31). W1, the facilitator, is funded separately.
- [ ] Testnet: faucet USDC to W6 `0xc9eAB77D415EcDf7FAA93130ff74F402FF99E289`.
- [ ] Record the voice-over (video-script.md) after the mainnet runs, so every tx hash on screen is real.
- [ ] Approve the repo going public (it stays private until then).

## Clicks left for Luis
1. Sign in / join (Luis only: login, passkey, 2FA).
2. Paste each field from SUBMISSION.md.
3. Upload video / cover / deck where asked.
4. Choose the track(s): Agent Payments & A2A Settlement.
5. Tick the rules/consent box (Luis reads it).
6. Click **Submit** (not just Save draft) and screenshot the confirmation.
7. Optional: post social-post.md from his account.

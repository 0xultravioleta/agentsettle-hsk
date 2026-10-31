# HSP (HashKey Merchant) registration: data to send

The fields come from the gateway's onboarding guide, step 2. Operations need them to create the organization invite.
Nothing has been submitted from this repo. The owner sends them.

| Field | Value | Status |
|---|---|---|
| `organization_name` | `Ultravioleta DAO` | proposed |
| `email` | `ultravioletadao@gmail.com` | proposed; the owner confirms (the invite link goes there) |
| `description` | `AgentSettle: AI agents hire and pay each other on HashKey Chain (HSK Chain Horizon hackathon)` | proposed |
| `default_language` | `en` | proposed |
| `service_rate` | `0.0000` | the docs' example value |
| `public_key` | see below ([`merchant-public-key.pem`](merchant-public-key.pem)) | generated 2026-10-31 |
| `supported_chain_tokens` | the two rows below | from the gateway's testnet table |

**`supported_chain_tokens` (QA = testnet):**

| Network | Chain ID | Token | Contract | Decimals | Stablecoin | Protocol |
|---|---|---|---|---|---|---|
| hashkey-testnet | 133 | USDC | `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` | 6 | Yes | EIP-3009 |
| hashkey-testnet | 133 | USDT | `0x372325443233fEbaC1F6998aC750276468c83CC6` | 6 | Yes | Permit2 |

AgentSettle offers only USDC in its cart mandates. The receipt contract and the on-chain transfer check both use
USDC. USDT is registered because it was requested.

**`public_key` (secp256k1, SPKI PEM):**

```text
-----BEGIN PUBLIC KEY-----
MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEu6nDVRA60+ifSt4IJ23h5GU86iZoJlyd
sw92mNHVamms8dsfb8wHnd7uwoSaAnx91bfmX3w0Bnr5RVDrDW+G5Q==
-----END PUBLIC KEY-----
```

## Where the keys are

- **Merchant private key:** AWS SSM `/agentsettle-hsk/hsp/merchant-private-key` (SecureString, us-east-1).
  - `pnpm hsp:keygen` generated it. It went straight into SSM and was never printed or written to disk.
  - Running `pnpm hsp:keygen` again reuses the key and rewrites the public PEM. It never overwrites the key.
- **`app_key` and `app_secret`:** the merchant console gives them after the email is verified and an app is
  created. They go to SSM without passing through argv, the shell history or the screen:

  ```bash
  read -rs V && printf %s "$V" | aws ssm put-parameter --name /agentsettle-hsk/hsp/app-key --type SecureString --value file:///dev/stdin && unset V
  read -rs V && printf %s "$V" | aws ssm put-parameter --name /agentsettle-hsk/hsp/app-secret --type SecureString --value file:///dev/stdin && unset V
  ```

  With the 3 parameters in place, the runtime switches the HSP rail from `stub` to `merchant` on `hashkey-testnet`.

## Network

- **IP allowlist:** `23.116.75.210`. The owner sent it to the HashKey group, and it is the egress IP of the machine
  that runs the demo (checked 2026-10-31).
- **Webhook URL:** none for now. The gateway only calls HTTPS URLs, and the demo runs locally. It reads the outcome
  from `GET /api/v1/merchant/payments`. The `/hsp/webhook` route is ready (it checks the HMAC) for when a public
  HTTPS URL exists.

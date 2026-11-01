Responses recorded from the HashKey Merchant API docs (https://hashkey-merchant.github.io, English sources, fetched
2026-10-31). Each `.json` is a published example copied without changes:

| file | doc section |
|---|---|
| `create-order-request.json` | API reference, "Create one-time order", request body |
| `create-order-response.json` | API reference, "Create one-time order", success response |
| `payment-record.json` | API reference, "Query one-time payments", sample (`payment_request_id` or `flow_id`) |
| `payments-reusable-page.json` | API reference, "Query reusable payments", paged response |
| `webhook-finalized.json` | Webhooks, sample `payment-finalized` |
| `webhook-failed.json` | Webhooks, sample `payment-failed` |

The doc samples use placeholder values (`payer_address: "0x1234567890abcdef"`, `tx_signature: "0xabcd1234..."`); the
tests rely on that: a record with them must never be delivered on.

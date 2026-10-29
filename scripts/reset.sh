#!/usr/bin/env bash
# Back to a clean demo: forgets the local anvil chain and the buyer's spend ledger (data/ is gitignored).
# Does not touch .env, any key, or anything on a public chain (on-chain receipts are permanent by design).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -d data ]]; then
  rm -rf -- ./data
  echo "removed ./data (local chain state + spend ledgers)"
else
  echo "nothing to reset"
fi

#!/usr/bin/env bash
# Deploys AgentSettleReceipts with the network's operator key from .env, verifies it on Blockscout and writes the
# address to .env (RECEIPTS_ADDRESS_TESTNET / RECEIPTS_ADDRESS_MAINNET).
#
#   scripts/deploy.sh hashkey-testnet
#   MAINNET_OWNER_OK=yes scripts/deploy.sh hashkey     # ONLY after the owner approved the exact HSK amount
set -euo pipefail
cd "$(dirname "$0")/.."
NET="${1:-}"
[[ -f .env ]] || { echo "no .env (cp .env.example .env and fill it)" >&2; exit 1; }
set -a; . ./.env; set +a

case "$NET" in
  hashkey-testnet)
    RPC="${HASHKEY_TESTNET_RPC_URL:-https://testnet.hsk.xyz}"; CHAIN=133
    VERIFIER_URL="https://testnet-explorer.hskchain.net/api/"; EXPLORER="https://testnet-explorer.hskchain.net"
    KEY_VAR=TESTNET_OPERATOR_PRIVATE_KEY; OUT_VAR=RECEIPTS_ADDRESS_TESTNET ;;
  hashkey)
    if [[ "${MAINNET_OWNER_OK:-}" != "yes" ]]; then
      echo "refusing to deploy on HashKey mainnet: set MAINNET_OWNER_OK=yes only after the owner approved the exact amount" >&2
      exit 1
    fi
    RPC="${HASHKEY_RPC_URL:-https://mainnet.hsk.xyz}"; CHAIN=177
    VERIFIER_URL="https://hsk.blockscout.com/api/"; EXPLORER="https://explorer.hsk.xyz"
    KEY_VAR=OPERATOR_PRIVATE_KEY; OUT_VAR=RECEIPTS_ADDRESS_MAINNET ;;
  *) echo "usage: scripts/deploy.sh hashkey-testnet|hashkey" >&2; exit 1 ;;
esac

KEY="${!KEY_VAR:-}"
[[ -n "$KEY" ]] || { echo "$KEY_VAR is empty in .env" >&2; exit 1; }
FROM=$(cast wallet address --private-key "$KEY")
[[ "$(cast chain-id --rpc-url "$RPC")" == "$CHAIN" ]] || { echo "RPC $RPC is not chain $CHAIN" >&2; exit 1; }
BAL=$(cast balance "$FROM" --rpc-url "$RPC")
echo "operator $FROM balance $(cast from-wei "$BAL") HSK on chain $CHAIN"
[[ "$BAL" != "0" ]] || { echo "operator has no gas" >&2; exit 1; }

forge build --quiet
OUT=$(DEPLOYER_PRIVATE_KEY="$KEY" forge script contracts/script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1) || { echo "$OUT" | grep -v -i "private" >&2; exit 1; }
ADDR=$(echo "$OUT" | grep -o 'AgentSettleReceipts 0x[0-9a-fA-F]\{40\}' | head -1 | awk '{print $2}')
[[ -n "$ADDR" ]] || { echo "could not read the deployed address" >&2; exit 1; }
[[ "$(cast call "$ADDR" 'operator()(address)' --rpc-url "$RPC")" == "$FROM" ]] || { echo "operator() mismatch on $ADDR" >&2; exit 1; }
echo "deployed $ADDR  $EXPLORER/address/$ADDR"

forge verify-contract "$ADDR" contracts/AgentSettleReceipts.sol:AgentSettleReceipts \
  --chain "$CHAIN" --verifier blockscout --verifier-url "$VERIFIER_URL" \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$FROM")" --watch || echo "verification failed: retry the forge verify-contract line by hand" >&2

python3 - "$OUT_VAR" "$ADDR" <<'PY'
import sys, re
var, addr = sys.argv[1], sys.argv[2]
p = '.env'
s = open(p).read()
s = re.sub(rf'^{var}=.*$', f'{var}={addr}', s, flags=re.M) if re.search(rf'^{var}=', s, flags=re.M) else s + f'\n{var}={addr}\n'
open(p, 'w').write(s)
PY
echo "$OUT_VAR=$ADDR written to .env"

#!/usr/bin/env bash
# One command for the whole AgentSettle flow. Prints every step and the explorer links.
#
#   scripts/demo.sh                                  # local anvil: no keys, no funds, nothing leaves this machine
#   scripts/demo.sh --network hashkey-testnet --runs 3
#   scripts/demo.sh --ui                             # same, then keeps the judge UI up on http://127.0.0.1:8402
#   MAINNET_OWNER_OK=yes scripts/demo.sh --network hashkey   # ONLY after the owner approved the exact amount
#
# Other flags go to the demo: --runs N, --text "...", --facilitator auto|local|remote, --port P.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK=local
UI=0
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; ARGS+=("$1" "$2"); shift 2 ;;
    --ui) UI=1; shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[[ " ${ARGS[*]-} " == *" --network "* ]] || ARGS+=(--network "$NETWORK")

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing $1: $2" >&2; exit 1; }; }
need node "install Node 20+ (https://nodejs.org)"
need forge "install Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
PNPM="pnpm"
command -v pnpm >/dev/null 2>&1 || PNPM="npx -y pnpm@10.34.9"

[[ -f lib/forge-std/src/Test.sol ]] || git submodule update --init --recursive
[[ -d node_modules ]] || $PNPM install --frozen-lockfile
forge build --quiet

ANVIL_PID=""
cleanup() { [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

if [[ "$NETWORK" == "local" ]]; then
  need anvil "it ships with Foundry"
  if ! curl -s -m 2 -X POST -H 'content-type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 >/dev/null; then
    mkdir -p data
    anvil --port 8545 --silent --state data/anvil-state.json >/dev/null 2>&1 &
    ANVIL_PID=$!
    for _ in $(seq 1 50); do
      curl -s -m 1 -X POST -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 >/dev/null && break
      sleep 0.2
    done
  fi
fi

$PNPM exec tsx src/cli/demo.ts "${ARGS[@]}"

if [[ "$UI" == 1 ]]; then
  $PNPM exec vite build web --logLevel warn
  echo
  echo "Judge UI: http://127.0.0.1:8402   (Ctrl+C to stop)"
  SERVE_ARGS=()
  for ((i = 0; i < ${#ARGS[@]}; i++)); do
    case "${ARGS[$i]}" in
      --network|--facilitator|--port) SERVE_ARGS+=("${ARGS[$i]}" "${ARGS[$((i + 1))]}"); i=$((i + 1)) ;;
      --runs|--text) i=$((i + 1)) ;;
    esac
  done
  $PNPM exec tsx src/cli/serve.ts "${SERVE_ARGS[@]}"
fi

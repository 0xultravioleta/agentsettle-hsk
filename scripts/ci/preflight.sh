#!/usr/bin/env bash
# The CI, locally and with the CI's versions (Node 20, pnpm 10.34.9, Foundry). Red here = red in Actions.
#   bash scripts/ci/preflight.sh [base]     (base defaults to origin/main; used for the secret scan range)
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE="${1:-${PREFLIGHT_BASE:-origin/main}}"

if node --version 2>/dev/null | grep -q '^v20\.'; then
  N() { "$@"; }
else
  N() { npx -y -p node@20 -p pnpm@10.34.9 "$@"; }
fi
PNPM_BIN="pnpm"
command -v pnpm >/dev/null 2>&1 || PNPM_BIN="npx -y pnpm@10.34.9"

rows=()
step() {
  local name="$1"; shift
  local t0=$SECONDS
  if "$@"; then rows+=("| $name | \`$*\` | ok | $((SECONDS - t0))s |")
  else rows+=("| $name | \`$*\` | FAIL | $((SECONDS - t0))s |"); printf '%s\n' "${rows[@]}"; exit 1; fi
}

[[ -f lib/forge-std/src/Test.sol ]] || git submodule update --init --recursive
step "install" N pnpm install --frozen-lockfile
step "typecheck" N pnpm typecheck
step "forge build" forge build --sizes
step "forge test" forge test
# tests only talk to 127.0.0.1 (anvil + in-process servers); any other egress is pointed at a dead proxy
step "vitest" N env HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost pnpm test
step "web build" N pnpm web:build
if command -v gitleaks >/dev/null 2>&1; then
  # every commit of the branch (the repo is small); .env is gitignored and never scanned from disk
  step "gitleaks" gitleaks git --no-banner --redact .
else
  echo "gitleaks not installed: the CI job runs it" >&2
fi

echo
echo "| step | command | result | time |"
echo "|---|---|---|---|"
printf '%s\n' "${rows[@]}"

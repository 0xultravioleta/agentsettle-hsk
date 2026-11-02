#!/usr/bin/env bash
# Deploys AgentSettleReceipts with the network's operator key from .env, verifies it (Blockscout on HashKey; Etherscan
# on Ethereum Sepolia when ETHERSCAN_API_KEY is in .env, else Sourcify) and writes the address to .env
# (RECEIPTS_ADDRESS_TESTNET / RECEIPTS_ADDRESS_ETH_SEPOLIA / RECEIPTS_ADDRESS_MAINNET).
#
#   scripts/deploy.sh hashkey-testnet
#   scripts/deploy.sh ethereum-sepolia                 # where HashKey asks teams to test USDC payments
#   MAINNET_OWNER_OK=yes scripts/deploy.sh hashkey     # ONLY after the owner approved the exact HSK amount
#   MAINNET_OWNER_OK=yes scripts/deploy.sh hashkey --redeploy   # a SECOND mainnet contract: only with the owner's OK for it
set -euo pipefail
cd "$(dirname "$0")/.."
NET="${1:-}"
REDEPLOY=0
if [[ $# -eq 2 && "$2" == "--redeploy" ]]; then REDEPLOY=1
elif [[ $# -gt 1 ]]; then echo "usage: scripts/deploy.sh hashkey-testnet|ethereum-sepolia|hashkey [--redeploy]" >&2; exit 1; fi
[[ -f .env ]] || { echo "no .env (cp .env.example .env and fill it)" >&2; exit 1; }
CALLER_OWNER_OK="${MAINNET_OWNER_OK:-}"
# .env cannot reset these: a NET, REDEPLOY or CALLER_OWNER_OK line there stops the script instead of opening a gate
readonly NET REDEPLOY CALLER_OWNER_OK
set -a; . ./.env; set +a
# the mainnet OK comes only from the caller's environment, never from .env: here and in Deploy.s.sol's own guard
# (exported even when empty, so forge's own .env loading cannot fill it in either)
export MAINNET_OWNER_OK="$CALLER_OWNER_OK"

case "$NET" in
  hashkey-testnet)
    RPC="${HASHKEY_TESTNET_RPC_URL:-https://testnet.hsk.xyz}"; CHAIN=133; GAS=HSK
    VERIFY=(--verifier blockscout --verifier-url "https://testnet-explorer.hskchain.net/api/"); EXPLORER="https://testnet-explorer.hskchain.net"
    KEY_VAR=TESTNET_OPERATOR_PRIVATE_KEY; OUT_VAR=RECEIPTS_ADDRESS_TESTNET ;;
  ethereum-sepolia)
    RPC="${ETH_SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"; CHAIN=11155111; GAS=ETH
    # forge reads ETHERSCAN_API_KEY from the environment (.env is exported above), so the key never goes on argv
    if [[ -n "${ETHERSCAN_API_KEY:-}" ]]; then VERIFY=(--verifier etherscan); else VERIFY=(--verifier sourcify); fi
    EXPLORER="https://sepolia.etherscan.io"
    KEY_VAR=TESTNET_OPERATOR_PRIVATE_KEY; OUT_VAR=RECEIPTS_ADDRESS_ETH_SEPOLIA ;;
  hashkey)
    if [[ "${MAINNET_OWNER_OK:-}" != "yes" ]]; then
      echo "refusing to deploy on HashKey mainnet: set MAINNET_OWNER_OK=yes only after the owner approved the exact amount" >&2
      exit 1
    fi
    # one mainnet contract: README, SUBMISSION and the demo all use the address in .env, and a new deploy would replace it
    if [[ -n "${RECEIPTS_ADDRESS_MAINNET:-}" && "$REDEPLOY" != 1 ]]; then
      echo "refusing to deploy on HashKey mainnet: RECEIPTS_ADDRESS_MAINNET is already $RECEIPTS_ADDRESS_MAINNET in .env (pass --redeploy only with the owner's OK for a second contract)" >&2
      exit 1
    fi
    RPC="${HASHKEY_RPC_URL:-https://mainnet.hsk.xyz}"; CHAIN=177; GAS=HSK
    VERIFY=(--verifier blockscout --verifier-url "https://hsk.blockscout.com/api/"); EXPLORER="https://explorer.hsk.xyz"
    KEY_VAR=OPERATOR_PRIVATE_KEY; OUT_VAR=RECEIPTS_ADDRESS_MAINNET ;;
  *) echo "usage: scripts/deploy.sh hashkey-testnet|ethereum-sepolia|hashkey [--redeploy]" >&2; exit 1 ;;
esac

KEY="${!KEY_VAR:-}"
[[ -n "$KEY" ]] || { echo "$KEY_VAR is empty in .env" >&2; exit 1; }
# the key travels in the environment only (argv is visible to every local user in ps)
FROM=$(DEPLOYER_PRIVATE_KEY="$KEY" node --input-type=module -e \
  "import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY).address)")
[[ "$(cast chain-id --rpc-url "$RPC")" == "$CHAIN" ]] || { echo "RPC $RPC is not chain $CHAIN" >&2; exit 1; }
BAL=$(cast balance "$FROM" --rpc-url "$RPC")
echo "operator $FROM balance $(cast from-wei "$BAL") $GAS on chain $CHAIN"
[[ "$BAL" != "0" ]] || { echo "operator has no gas" >&2; exit 1; }

forge build --quiet
if [[ "$NET" == ethereum-sepolia ]]; then
  # Sepolia runs a fork newer than forge's EVM: there the creation costs ~2.1M gas, forge simulates ~318k (2026-11-02),
  # and a deploy with forge's gas limit runs out of gas. viem sends it with the gas the node estimates; the key travels
  # in the environment only.
  OUT=$(DEPLOYER_PRIVATE_KEY="$KEY" DEPLOY_RPC="$RPC" DEPLOY_CHAIN="$CHAIN" DEPLOY_OPERATOR="$FROM" node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const art = JSON.parse(readFileSync('out/AgentSettleReceipts.sol/AgentSettleReceipts.json', 'utf8'));
const chain = defineChain({ id: Number(process.env.DEPLOY_CHAIN), name: 'deploy', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [process.env.DEPLOY_RPC] } } });
const wallet = createWalletClient({ account: privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY), chain, transport: http() });
const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [process.env.DEPLOY_OPERATOR] });
console.log('deploy tx ' + hash);
const r = await createPublicClient({ chain, transport: http() }).waitForTransactionReceipt({ hash });
if (r.status !== 'success') throw new Error('deploy tx ' + hash + ' failed on-chain (gas used ' + r.gasUsed + ')');
console.log('AgentSettleReceipts ' + r.contractAddress);
" 2>&1) || { echo "$OUT" | grep -v -i "private" >&2; exit 1; }
  echo "$OUT" | grep '^deploy tx '
else
  OUT=$(DEPLOYER_PRIVATE_KEY="$KEY" forge script contracts/script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1) || { echo "$OUT" | grep -v -i "private" >&2; exit 1; }
fi
ADDR=$(echo "$OUT" | grep -o 'AgentSettleReceipts 0x[0-9a-fA-F]\{40\}' | head -1 | awk '{print $2}')
[[ -n "$ADDR" ]] || { echo "could not read the deployed address" >&2; exit 1; }
# a load-balanced RPC can answer from a node that has not seen the deploy block yet: retry before calling it a mismatch
OP=""
for _ in $(seq 1 20); do
  OP=$(cast call "$ADDR" 'operator()(address)' --rpc-url "$RPC" 2>/dev/null) && [[ -n "$OP" ]] && break
  sleep 3
done
[[ "$OP" == "$FROM" ]] || { echo "operator() on $ADDR is '${OP:-no code yet}', expected $FROM (the deploy tx is in broadcast/; do not redeploy blindly)" >&2; exit 1; }
echo "deployed $ADDR  $EXPLORER/address/$ADDR"

forge verify-contract "$ADDR" contracts/AgentSettleReceipts.sol:AgentSettleReceipts \
  --chain "$CHAIN" "${VERIFY[@]}" \
  --constructor-args "$(cast abi-encode 'constructor(address)' "$FROM")" --watch || echo "verification failed: retry the forge verify-contract line by hand" >&2

python3 scripts/set-env-var.py .env "$OUT_VAR" "$ADDR"
echo "$OUT_VAR=$ADDR written to .env"

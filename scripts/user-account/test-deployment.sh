#!/usr/bin/env bash
# Isolated localnet deployment and optional account-creation workflow. No pool bootstrap.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODE="${1:-workflow}"
if [[ "$MODE" != deployment && "$MODE" != workflow && "$MODE" != production ]]; then
  echo 'Expected mode: deployment, workflow, or production' >&2
  exit 1
fi
# shellcheck source=../ensure-localnet-tools.sh
source "$WORKSPACE_DIR/scripts/ensure-localnet-tools.sh"
cd "$WORKSPACE_DIR"
RPC_PORT="${USER_ACCOUNT_RPC_PORT:-18899}"
if [[ ! "$RPC_PORT" =~ ^[0-9]+$ ]] || (( 10#$RPC_PORT < 1024 || 10#$RPC_PORT > 65535 )); then
  echo 'USER_ACCOUNT_RPC_PORT must be an integer from 1024 through 65535' >&2
  exit 1
fi
RPC_PORT="$((10#$RPC_PORT))"
RPC_URL="http://127.0.0.1:$RPC_PORT"
if solana --url "$RPC_URL" cluster-version >/dev/null 2>&1; then
  echo "A validator already uses $RPC_URL; refusing to replace it" >&2
  exit 1
fi
TEMP_DIR="$(mktemp -d /tmp/comfi-user-account.XXXXXX)"
VALIDATOR_PID=''
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [[ -n "$VALIDATOR_PID" ]] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID"
    wait "$VALIDATOR_PID" || true
  fi
  rm -f "$TEMP_DIR/payer.json"
  if (( result != 0 )); then
    echo "UserAccount test failed; validator log: $TEMP_DIR/validator.log" >&2
  else
    rm -rf "$TEMP_DIR"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p target/deploy
install -m 0600 programs/user-account/localnet-keypair.json target/deploy/user_account-keypair.json
if [[ "$MODE" == production ]]; then
  anchor build --program-name user_account
else
  anchor build --program-name user_account -- --features testing
fi
PROGRAM_ID='7FHwv2r8R8avPiqq7ZaAUx3XYozt36F1zFfoNMHZeJ57'
[[ "$(solana-keygen pubkey target/deploy/user_account-keypair.json)" == "$PROGRAM_ID" ]]
[[ -s target/deploy/user_account.so ]]
node --input-type=module -e 'import {readFileSync} from "node:fs"; import assert from "node:assert/strict"; assert.equal(JSON.parse(readFileSync("target/idl/user_account.json")).address, process.argv[1]);' "$PROGRAM_ID"
solana-test-validator --reset --ledger "$TEMP_DIR/ledger" --bind-address 127.0.0.1 --rpc-port "$RPC_PORT" --faucet-port 18900 --gossip-port 19000 --dynamic-port-range 19000-19030 >"$TEMP_DIR/validator.log" 2>&1 &
VALIDATOR_PID=$!
READY=false
for _ in $(seq 1 60); do
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    tail -40 "$TEMP_DIR/validator.log" >&2
    exit 1
  fi
  if solana --url "$RPC_URL" cluster-version >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done
[[ "$READY" == true ]] || { echo 'Localnet did not become ready' >&2; exit 1; }
solana-keygen new --no-bip39-passphrase --silent --outfile "$TEMP_DIR/payer.json"
solana --url "$RPC_URL" airdrop 30 "$(solana-keygen pubkey "$TEMP_DIR/payer.json")"
solana --url "$RPC_URL" --keypair "$TEMP_DIR/payer.json" program deploy --use-rpc --program-id target/deploy/user_account-keypair.json target/deploy/user_account.so
solana --url "$RPC_URL" --keypair "$TEMP_DIR/payer.json" program show "$PROGRAM_ID"
if [[ "$MODE" == workflow ]]; then
  node scripts/user-account/create-single-account.mjs --rpc-url="$RPC_URL" --payer="$TEMP_DIR/payer.json" --negative-tests
elif [[ "$MODE" == production ]]; then
  node scripts/user-account/create-single-account.mjs --expect-disabled --rpc-url="$RPC_URL" --payer="$TEMP_DIR/payer.json"
fi

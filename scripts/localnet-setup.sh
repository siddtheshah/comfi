#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Load .env from workspace root if present
if [ -f "$WORKSPACE_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$WORKSPACE_DIR/.env"
  set +a
fi

RPC_URL="${COMFI_LOCALNET_RPC:-http://127.0.0.1:8899}"
LEDGER="${LOCALNET_LEDGER_DIR:-/tmp/comfi-localnet-ledger}"
PAYER="${LOCALNET_PAYER_KEYPAIR:-/tmp/comfi-local-payer.json}"
SOLANA_BIN_DIR="${SOLANA_BIN_DIR:-}"
ANCHOR_BIN_DIR="${ANCHOR_BIN_DIR:-}"
NODE_BIN="${NODE_BIN:-}"

# Fresh clones do not need a global Solana or Anchor installation. Explicit
# directories remain supported for developers who already have the CLIs.
# shellcheck source=ensure-localnet-tools.sh
. "$SCRIPT_DIR/ensure-localnet-tools.sh"

# Resolve Solana binaries
if [ -x "$SOLANA_BIN_DIR/solana" ]; then
  SOLANA="$SOLANA_BIN_DIR/solana"
  SOLANA_KEYGEN="$SOLANA_BIN_DIR/solana-keygen"
  SOLANA_TEST_VALIDATOR="$SOLANA_BIN_DIR/solana-test-validator"
elif command -v solana >/dev/null 2>&1; then
  SOLANA="$(command -v solana)"
  SOLANA_KEYGEN="$(command -v solana-keygen)"
  SOLANA_TEST_VALIDATOR="$(command -v solana-test-validator)"
else
  echo "Error: solana CLI not found after localnet tool setup." >&2
  exit 1
fi

# Resolve Anchor binary
if [ -x "$ANCHOR_BIN_DIR/anchor" ]; then
  ANCHOR="$ANCHOR_BIN_DIR/anchor"
elif command -v anchor >/dev/null 2>&1; then
  ANCHOR="$(command -v anchor)"
else
  echo "Error: anchor CLI not found after localnet tool setup." >&2
  exit 1
fi

# Resolve Node binary
if [ -n "$NODE_BIN" ] && command -v "$NODE_BIN" >/dev/null 2>&1; then
  NODE="$NODE_BIN"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif command -v node.exe >/dev/null 2>&1; then
  NODE="$(command -v node.exe)"
else
  echo "Error: node not found. Please set NODE_BIN in .env" >&2
  exit 1
fi

# Do not silently reset a validator the user already started.
if "$SOLANA" -u "$RPC_URL" cluster-version >/dev/null 2>&1; then
  echo "Error: A validator is already listening on $RPC_URL. Stop it before running localnet:setup, or use the existing validator with localnet:start plus a manual deploy." >&2
  exit 1
fi

VALIDATOR_PID=""
CLEANED_UP=0

cleanup() {
  local exit_code=$?
  if [ "$CLEANED_UP" -eq 1 ]; then
    return
  fi
  CLEANED_UP=1
  trap - EXIT INT TERM

  if [ -n "${VALIDATOR_PID:-}" ]; then
    echo ""
    echo "Shutting down localnet and cleaning up..."
    if kill -0 "$VALIDATOR_PID" 2>/dev/null; then
      echo "Stopping solana-test-validator (PID: $VALIDATOR_PID)..."
      kill -TERM "$VALIDATOR_PID" 2>/dev/null || true
      for _ in $(seq 1 10); do
        if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
          break
        fi
        sleep 0.5
      done
      if kill -0 "$VALIDATOR_PID" 2>/dev/null; then
        echo "Force stopping solana-test-validator..."
        kill -9 "$VALIDATOR_PID" 2>/dev/null || true
      fi
    fi

    if command -v tmux >/dev/null 2>&1; then
      tmux kill-session -t comfi-validator >/dev/null 2>&1 || true
    fi

    if [ "${KEEP_LEDGER:-false}" != "true" ] && [ -d "$LEDGER" ]; then
      echo "Removing ledger directory: $LEDGER"
      rm -rf "$LEDGER"
    fi

    echo "Localnet stopped and cleaned up."
  fi

  if [ "$exit_code" -eq 130 ] || [ "$exit_code" -eq 0 ]; then
    exit 0
  else
    exit "$exit_code"
  fi
}

trap cleanup EXIT INT TERM

echo "Starting a reset isolated validator with ledger: $LEDGER"
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t comfi-validator >/dev/null 2>&1 || true
fi

"$SOLANA_TEST_VALIDATOR" --reset --ledger "$LEDGER" >/tmp/comfi-validator.log 2>&1 &
VALIDATOR_PID=$!

READY=false
for attempt in $(seq 1 30); do
  if "$SOLANA" -u "$RPC_URL" cluster-version >/dev/null 2>&1; then
    READY=true
    break
  fi
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "Error: solana-test-validator exited while waiting for RPC to become ready." >&2
    if [ -f /tmp/comfi-validator.log ]; then
      tail -n 20 /tmp/comfi-validator.log >&2 || true
    fi
    exit 1
  fi
  sleep 1
done

if [ "$READY" != "true" ]; then
  echo "Error: Local validator did not become ready at $RPC_URL within 30 seconds." >&2
  exit 1
fi

echo "Validator is ready at $RPC_URL (PID: $VALIDATOR_PID)"

# Create payer keypair if it does not exist
if [ ! -f "$PAYER" ]; then
  "$SOLANA_KEYGEN" new --no-bip39-passphrase --silent --outfile "$PAYER"
fi

PAYER_PUBKEY="$("$SOLANA_KEYGEN" pubkey "$PAYER")"
echo "Funding payer account: $PAYER_PUBKEY"
"$SOLANA" -u "$RPC_URL" airdrop 20 "$PAYER_PUBKEY"

echo "Building and deploying Anchor program..."
cd "$WORKSPACE_DIR"
# The pool bootstrapper imports workspace dependencies. Use npm ci for a
# deterministic install on fresh clones; skip it when the required packages
# are already present.
if [ ! -d "$WORKSPACE_DIR/node_modules/@coral-xyz/anchor" ] || [ ! -d "$WORKSPACE_DIR/node_modules/@solana/web3.js" ]; then
  echo "Installing npm workspace dependencies..."
  npm ci
fi
# Anchor otherwise creates a random target/deploy keypair on a clean clone.
# Keep the localnet program address stable and in sync with declare_id!.
mkdir -p "$WORKSPACE_DIR/target/deploy"
install -m 0600 "$WORKSPACE_DIR/programs/comfi/localnet-keypair.json" "$WORKSPACE_DIR/target/deploy/comfi-keypair.json"
# This script is exclusively for the isolated local test environment. The
# pool initializer below requests testing_enabled, so deploy the matching
# feature-gated binary rather than the production binary.
"$ANCHOR" build -- --features testing
"$ANCHOR" deploy --provider.cluster localnet --provider.wallet "$PAYER"

echo "Initializing localnet state and funding test wallet..."
# Pass arguments rather than relying on environment propagation: NODE may be
# node.exe when this script runs under WSL, and custom WSL variables are not
# reliably inherited by Windows processes.
"$NODE" scripts/create-test-pool.mjs --rpc-url="$RPC_URL" --operation=initialize
"$NODE" scripts/create-test-pool.mjs --rpc-url="$RPC_URL" --operation=fund-wallet

echo ""
echo "=========================================================================="
echo "  Localnet is ready: program deployed, deployer initialized, and mock test wallet funded."
echo "  RPC endpoint: $RPC_URL"
echo "  Validator PID: $VALIDATOR_PID"
echo "  Validator logs: /tmp/comfi-validator.log"
echo ""
echo "  Localnet is active. Press Ctrl+C to stop localnet and clean up."
echo "=========================================================================="
echo ""

# Keep running in foreground until Ctrl+C (SIGINT) or validator process exits
wait "$VALIDATOR_PID" 2>/dev/null || true

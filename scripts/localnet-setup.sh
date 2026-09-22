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

if [ -n "$SOLANA_BIN_DIR" ]; then
  export PATH="$SOLANA_BIN_DIR:$PATH"
fi
if [ -n "$ANCHOR_BIN_DIR" ]; then
  export PATH="$ANCHOR_BIN_DIR:$PATH"
fi
if [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# Resolve Solana binaries
if [ -n "$SOLANA_BIN_DIR" ] && [ -x "$SOLANA_BIN_DIR/solana" ]; then
  SOLANA="$SOLANA_BIN_DIR/solana"
  SOLANA_KEYGEN="$SOLANA_BIN_DIR/solana-keygen"
  SOLANA_TEST_VALIDATOR="$SOLANA_BIN_DIR/solana-test-validator"
elif command -v solana >/dev/null 2>&1; then
  SOLANA="$(command -v solana)"
  SOLANA_KEYGEN="$(command -v solana-keygen)"
  SOLANA_TEST_VALIDATOR="$(command -v solana-test-validator)"
elif [ -x "$HOME/.local/share/solana/install/active_release/bin/solana" ]; then
  SOLANA="$HOME/.local/share/solana/install/active_release/bin/solana"
  SOLANA_KEYGEN="$HOME/.local/share/solana/install/active_release/bin/solana-keygen"
  SOLANA_TEST_VALIDATOR="$HOME/.local/share/solana/install/active_release/bin/solana-test-validator"
else
  echo "Error: solana CLI not found. Please set SOLANA_BIN_DIR in .env" >&2
  exit 1
fi

# Resolve Anchor binary
if [ -n "$ANCHOR_BIN_DIR" ] && [ -x "$ANCHOR_BIN_DIR/anchor" ]; then
  ANCHOR="$ANCHOR_BIN_DIR/anchor"
elif command -v anchor >/dev/null 2>&1; then
  ANCHOR="$(command -v anchor)"
elif [ -x "$HOME/.cargo/bin/anchor" ]; then
  ANCHOR="$HOME/.cargo/bin/anchor"
else
  echo "Error: anchor CLI not found. Please set ANCHOR_BIN_DIR in .env" >&2
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

echo "Starting a reset isolated validator with ledger: $LEDGER"
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t comfi-validator >/dev/null 2>&1 || true
  tmux new-session -d -s comfi-validator "$SOLANA_TEST_VALIDATOR" --reset --ledger "$LEDGER"
else
  nohup "$SOLANA_TEST_VALIDATOR" --reset --ledger "$LEDGER" >/tmp/comfi-validator.log 2>&1 &
fi

READY=false
for attempt in $(seq 1 30); do
  sleep 1
  if "$SOLANA" -u "$RPC_URL" cluster-version >/dev/null 2>&1; then
    READY=true
    break
  fi
done

if [ "$READY" != "true" ]; then
  echo "Error: Local validator did not become ready at $RPC_URL." >&2
  exit 1
fi

echo "Validator is ready at $RPC_URL"

# Create payer keypair if it does not exist
if [ ! -f "$PAYER" ]; then
  "$SOLANA_KEYGEN" new --no-bip39-passphrase --silent --outfile "$PAYER"
fi

PAYER_PUBKEY="$("$SOLANA_KEYGEN" pubkey "$PAYER")"
echo "Funding payer account: $PAYER_PUBKEY"
"$SOLANA" -u "$RPC_URL" airdrop 20 "$PAYER_PUBKEY"

echo "Building and deploying Anchor program..."
cd "$WORKSPACE_DIR"
"$ANCHOR" build
"$ANCHOR" deploy --provider.cluster localnet --provider.wallet "$PAYER"

echo "Initializing localnet state and funding test wallet..."
export COMFI_LOCALNET_RPC="$RPC_URL"
export COMFI_POOL_MODE="initialize"
"$NODE" scripts/create-test-pool.mjs

export COMFI_POOL_MODE="fund-wallet"
"$NODE" scripts/create-test-pool.mjs
unset COMFI_POOL_MODE

echo "Localnet is ready: program deployed, deployer initialized, and mock test wallet funded. Start the UI and use Start a pool."

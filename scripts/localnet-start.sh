#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# Load .env if present
if [ -f "$WORKSPACE_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$WORKSPACE_DIR/.env"
  set +a
fi

SOLANA_BIN_DIR="${SOLANA_BIN_DIR:-}"
LEDGER="${LOCALNET_LEDGER_DIR:-/tmp/comfi-localnet-ledger}"

# shellcheck source=ensure-localnet-tools.sh
. "$SCRIPT_DIR/ensure-localnet-tools.sh"

if [ -x "$SOLANA_BIN_DIR/solana-test-validator" ]; then
  VALIDATOR="$SOLANA_BIN_DIR/solana-test-validator"
elif command -v solana-test-validator >/dev/null 2>&1; then
  VALIDATOR="$(command -v solana-test-validator)"
else
  echo "Error: solana-test-validator not found after localnet tool setup." >&2
  exit 1
fi

echo "Starting solana-test-validator with ledger: $LEDGER"
exec "$VALIDATOR" --ledger "$LEDGER" "$@"

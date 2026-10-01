#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
  echo "localnet tool bootstrap test failed: $*" >&2
  exit 1
}

run_bootstrap() {
  env -u CARGO_HOME -u RUSTUP_HOME \
    PATH="$TEMP_DIR/bin:$PATH" \
    COMFI_LOCALNET_TOOLS_DIR="$TEMP_DIR/cache" \
    "$@" \
    bash -c '. "$1"' -- "$SCRIPT_DIR/ensure-localnet-tools.sh"
}

mkdir -p "$TEMP_DIR/bin"
cat > "$TEMP_DIR/bin/cargo" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod +x "$TEMP_DIR/bin/cargo"

if run_bootstrap SOLANA_BIN_DIR="$TEMP_DIR/missing-solana" ANCHOR_BIN_DIR="$TEMP_DIR/missing-anchor" >"$TEMP_DIR/solana-error.log" 2>&1; then
  fail "invalid SOLANA_BIN_DIR unexpectedly succeeded"
fi
grep -F "SOLANA_BIN_DIR does not contain" "$TEMP_DIR/solana-error.log" >/dev/null || fail "missing SOLANA_BIN_DIR error"

mkdir -p "$TEMP_DIR/solana/bin"
for binary in solana solana-keygen solana-test-validator; do
  cat > "$TEMP_DIR/solana/bin/$binary" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
  chmod +x "$TEMP_DIR/solana/bin/$binary"
done

if run_bootstrap SOLANA_BIN_DIR="$TEMP_DIR/solana/bin" ANCHOR_BIN_DIR="$TEMP_DIR/missing-anchor" >"$TEMP_DIR/anchor-error.log" 2>&1; then
  fail "invalid ANCHOR_BIN_DIR unexpectedly succeeded"
fi
grep -F "ANCHOR_BIN_DIR does not contain" "$TEMP_DIR/anchor-error.log" >/dev/null || fail "missing ANCHOR_BIN_DIR error"

cat > "$TEMP_DIR/bin/uname" <<'EOF'
#!/usr/bin/env sh
case "$1" in
  -s) printf '%s\n' FreeBSD ;;
  -m) printf '%s\n' riscv64 ;;
esac
EOF
chmod +x "$TEMP_DIR/bin/uname"

if run_bootstrap >"$TEMP_DIR/platform-error.log" 2>&1; then
  fail "unsupported platform unexpectedly succeeded"
fi
grep -F "automatic localnet tool installation is unsupported" "$TEMP_DIR/platform-error.log" >/dev/null || fail "missing unsupported platform error"

echo "localnet tool bootstrap negative-path tests passed"

#!/usr/bin/env bash
# Download the pinned localnet CLIs into the repository cache when they are not
# already available. This keeps localnet:setup runnable from a fresh clone
# without requiring a global Solana or Anchor installation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

SOLANA_VERSION="3.1.10"
ANCHOR_VERSION="1.1.2"
TOOLS_DIR="${COMFI_LOCALNET_TOOLS_DIR:-$WORKSPACE_DIR/.localnet-tools}"
SOLANA_BIN_DIR_CONFIGURED="${SOLANA_BIN_DIR:-}"
ANCHOR_BIN_DIR_CONFIGURED="${ANCHOR_BIN_DIR:-}"
SOLANA_BIN_DIR="${SOLANA_BIN_DIR_CONFIGURED:-$TOOLS_DIR/solana-$SOLANA_VERSION/bin}"
ANCHOR_BIN_DIR="${ANCHOR_BIN_DIR_CONFIGURED:-$TOOLS_DIR/anchor-$ANCHOR_VERSION/bin}"
LOCAL_RUSTUP_HOME="$TOOLS_DIR/rustup"
LOCAL_CARGO_HOME="$TOOLS_DIR/cargo"

download() {
  local url="$1"
  local destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --retry 3 --retry-delay 1 --silent --show-error "$url" --output "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --tries=3 --output-document="$destination" "$url"
  else
    echo "Error: curl or wget is required to download localnet tools." >&2
    exit 1
  fi
}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64|Linux-arm64) platform="aarch64-unknown-linux-gnu" ;;
  Darwin-x86_64) platform="x86_64-apple-darwin" ;;
  Darwin-arm64) platform="aarch64-apple-darwin" ;;
  *)
    echo "Error: automatic localnet tool installation is unsupported on $(uname -s) $(uname -m). Set SOLANA_BIN_DIR and ANCHOR_BIN_DIR." >&2
    exit 1
    ;;
esac

if [ -n "${CARGO_HOME:-}" ]; then
  export CARGO_HOME
  export RUSTUP_HOME="${RUSTUP_HOME:-$LOCAL_RUSTUP_HOME}"
elif [ -x "$LOCAL_CARGO_HOME/bin/cargo" ] || ! command -v cargo >/dev/null 2>&1; then
  export CARGO_HOME="$LOCAL_CARGO_HOME"
  export RUSTUP_HOME="${RUSTUP_HOME:-$LOCAL_RUSTUP_HOME}"
fi

if [ -n "${CARGO_HOME:-}" ]; then
  export PATH="$CARGO_HOME/bin:$PATH"
fi

if ! command -v cargo >/dev/null 2>&1; then
  mkdir -p "$TOOLS_DIR"
  rustup_installer="$(mktemp "$TOOLS_DIR/rustup-init.XXXXXX.sh")"
  trap 'rm -f "$rustup_installer"' EXIT
  echo "Installing a minimal stable Rust toolchain into $TOOLS_DIR"
  download "https://sh.rustup.rs" "$rustup_installer"
  sh "$rustup_installer" -y --profile minimal --default-toolchain stable --no-modify-path
  rm -f "$rustup_installer"
  trap - EXIT
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: cargo was not available after local Rust toolchain setup." >&2
  exit 1
fi

if [ ! -x "$SOLANA_BIN_DIR/solana" ] || [ ! -x "$SOLANA_BIN_DIR/solana-keygen" ] || [ ! -x "$SOLANA_BIN_DIR/solana-test-validator" ]; then
  if [ -n "$SOLANA_BIN_DIR_CONFIGURED" ]; then
    echo "Error: SOLANA_BIN_DIR does not contain solana, solana-keygen, and solana-test-validator: $SOLANA_BIN_DIR" >&2
    exit 1
  fi
  mkdir -p "$TOOLS_DIR"
  archive="$(mktemp "$TOOLS_DIR/solana.XXXXXX.tar.bz2")"
  staging="$(mktemp -d "$TOOLS_DIR/solana.XXXXXX")"
  trap 'rm -f "$archive"; rm -rf "$staging"' EXIT
  echo "Installing Solana CLI $SOLANA_VERSION into $SOLANA_BIN_DIR"
  download "https://release.anza.xyz/v$SOLANA_VERSION/solana-release-$platform.tar.bz2" "$archive"
  tar -xjf "$archive" -C "$staging"
  mkdir -p "$(dirname "${SOLANA_BIN_DIR%/bin}")"
  mv "$staging/solana-release" "${SOLANA_BIN_DIR%/bin}"
  rm -f "$archive"
  rm -rf "$staging"
  trap - EXIT
fi

if [ ! -x "$ANCHOR_BIN_DIR/anchor" ]; then
  if [ -n "$ANCHOR_BIN_DIR_CONFIGURED" ]; then
    echo "Error: ANCHOR_BIN_DIR does not contain anchor: $ANCHOR_BIN_DIR" >&2
    exit 1
  fi
  mkdir -p "$ANCHOR_BIN_DIR"
  temporary_anchor="$(mktemp "$TOOLS_DIR/anchor.XXXXXX")"
  trap 'rm -f "$temporary_anchor"' EXIT
  echo "Installing Anchor CLI $ANCHOR_VERSION into $ANCHOR_BIN_DIR"
  download "https://github.com/otter-sec/anchor/releases/download/v$ANCHOR_VERSION/anchor-$ANCHOR_VERSION-$platform" "$temporary_anchor"
  install -m 0755 "$temporary_anchor" "$ANCHOR_BIN_DIR/anchor"
  rm -f "$temporary_anchor"
  trap - EXIT
fi

export SOLANA_BIN_DIR
export ANCHOR_BIN_DIR
export PATH="$SOLANA_BIN_DIR:$ANCHOR_BIN_DIR:$PATH"

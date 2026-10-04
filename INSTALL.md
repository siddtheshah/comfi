# ComFi Installation & Environment Setup Guide

This guide walks you through setting up ComFi from scratch on a new machine or environment, from installing system dependencies and toolchains to running the local Solana test validator, compiling Anchor smart contracts, and launching the live web application.

---

## 1. Prerequisites & Toolchain Versions

ComFi requires a small set of pinned toolchains for the on-chain Solana program and the modern web workspace:

| Tool | Version Requirement | Purpose |
| --- | --- | --- |
| **Node.js** | `>= 22.0.0` (LTS recommended) | Web frontend, test runner, bootstrap scripts |
| **npm** | `>= 10.0.0` | Workspace package manager |
| **Rust** | `stable` (`1.75+`) | Compiling the Anchor/Solana smart contract |
| **Solana CLI** | `3.1.10` (or `1.18.x+` test validator) | Isolated localnet validator, keygen, airdrop |
| **Anchor CLI** | `1.1.2` (or compatible `0.31.x`) | IDL generation, contract compilation & deployment |

> [!NOTE]
> **Windows Users**: The Solana CLI and Anchor build tools run best inside **WSL2 (Windows Subsystem for Linux)**, using Ubuntu. You can run Node.js commands from either Windows PowerShell or WSL, provided the `.env` paths point to your WSL toolchain binaries.

---

## 2. Installing Prerequisites

### A. Node.js (v22+)
Using `nvm` (recommended):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node -v # Should report v22.x.x
```

### B. Rust Toolchain
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

### C. Solana CLI
Install the Solana tools:
```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v2.0.14/install)"
# Or using the official install script:
# sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
```
Ensure Solana binaries are available in your `PATH`:
```bash
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version
```

### D. Anchor CLI
Install `avm` (Anchor Version Manager) and the pinned Anchor CLI:
```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 1.1.2
avm use 1.1.2
anchor --version # Should report anchor-cli 1.1.2 (or compatible)
```

---

## 3. Clone Repository & Install Node Dependencies

```bash
git clone https://github.com/siddtheshah/comfi.git
cd comfi
npm install
```

This installs all dependencies across the monorepo workspaces (`apps/web`, `services/sponsor-api`, and root dev dependencies including `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/spl-token`, and Playwright).

---

## 4. Environment Configuration

Copy the example environment file:
```bash
cp .env.example .env
```

Review `.env` only if you want to override the default localnet configuration. `npm run localnet:setup` downloads the pinned Solana and Anchor CLIs into `.localnet-tools` and runs `npm ci` when needed, so it works from a fresh clone without global Solana, Anchor, or Rust installations. You can still set paths to use existing binaries:

```ini
# If 'solana' or 'anchor' are not in standard system PATH, specify their directories:
SOLANA_BIN_DIR=
ANCHOR_BIN_DIR=

# Leave NODE_BIN empty to auto-detect node / node.exe:
NODE_BIN=

# Solana localnet RPC configuration:
COMFI_LOCALNET_RPC=http://127.0.0.1:8899
LOCALNET_LEDGER_DIR=/tmp/comfi-localnet-ledger
LOCALNET_PAYER_KEYPAIR=/tmp/comfi-local-payer.json

# Web UI configuration (read by Vite in apps/web):
VITE_WALLET_MODE=mock
VITE_SOLANA_RPC=http://127.0.0.1:8899
VITE_PROGRAM_ID=3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP
VITE_MOCK_WALLET_PUBLIC_KEY=GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB
```

---

## 5. Build the Anchor Smart Contract

Compile the Solana program and generate the IDL:
```bash
anchor build
```

Verify that the build outputs exist:
- `target/deploy/comfi.so` (Compiled SBF shared object)
- `target/idl/comfi.json` (Anchor Interface Definition Language)
- Program ID matches `3vzvgpB5MWB2cHGPRzWtRmKeQtZVfkffu6uygjoNDDYP`

---

## 6. Bootstrap the Localnet Test Chain

Run the all-in-one localnet setup script:
```bash
npm run localnet:setup
```

The script runs the localnet in the foreground and waits. When you are finished, press **`Ctrl+C`** to gracefully shut down the validator and clean up local ledger resources.

Keep this terminal open while running localnet-dependent checks in another terminal. After setup reports that the deployer is initialized, verify pool creation with:

```bash
npm run localnet:create-test-pool -- --operation=next
```

The command prints the new pool address and `poolMemberCount: 1`.

### What `npm run localnet:setup` does:
1. **Starts an isolated validator**: Launches `solana-test-validator` with a clean ledger in `/tmp/comfi-localnet-ledger` listening on `http://127.0.0.1:8899`.
2. **Generates and funds deployment payer**: Creates `/tmp/comfi-local-payer.json` and airdrops local SOL.
3. **Deploys ComFi**: Deploys `target/deploy/comfi.so` to the local validator.
4. **Initializes Global State**: Calls `initialize_global_config`, creates a 6-decimal test-USDC mint, and configures the protocol treasury.
5. **Funds Development Wallet**: Creates the associated token account for the deterministic mock wallet (`GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB`) and mints 10,000 test USDC and SOL.
6. **Emits Public Metadata**: Writes `localnet.json` containing the deployed public addresses.
7. **Monitors & Cleans Up**: Keeps the localnet alive until you press `Ctrl+C`, which automatically terminates the validator and removes the temporary ledger.

*(Optional)* If you want to manually start the validator without redeploying:
```bash
npm run localnet:start
```

---

## 7. Run the Web Application

Start the Vite development server:
```bash
npm run dev
```

Open your browser to:
```
http://localhost:5173
```

### Exploring the UI:
1. **Mock Wallet**: Automatically connects the funded local test wallet (`GmaD…AEGB`) on `http://127.0.0.1:8899`.
2. **Live On-Chain Pools**: The UI queries the Solana chain backend and displays real pools with an **On-chain** badge and their live USDC vault balances.
3. **Inspect Governance Parameters**: Click any on-chain pool card to inspect its live smart contract parameters:
   - Program PDA address and SPL Vault token account
   - Real vault USDC balance
   - Minimum deposit requirement (e.g. $10.00 USDC)
   - Voting threshold (e.g. 2 affirmative votes)
   - Capacity limits (e.g. 24 member slots)
   - Conferred, non-conferred, settled, and escrowed capital
   - Funded participation, quorum requirements, lock status, and auto-close warnings
   - Admission mode and voting maturation rules
   - Closure accounting snapshots when available

   Legacy account metrics and views awaiting integration are labeled unavailable. No sample activity, member identities, or simulated transaction confirmations are displayed.
4. **Deploy a New Pool**: Click **Start a pool**. The UI deploys an on-chain pool through the local development endpoint, automatically refetches the live chain state, and navigates to the newly created pool.
5. **Refresh**: Click `↻ Refresh` to fetch the latest on-chain block state. Only pools from the selected network appear; an empty network shows an empty state.

### Using the ComFi In-Browser Wallet

1. Start the localnet (`npm run localnet:setup`) and web app (`npm run dev`), then open **⚡ ComFi Wallet** in the top bar.
2. Select **In-Browser Wallet**, then choose **Generate New** or import an existing Base58 or JSON keypair. The wallet is stored in this browser only.
3. Select **Connect Wallet**, then use **Request 1 SOL** to fund transaction fees. The faucet works only against localnet and devnet.
4. Use **Mint 100 USDC** only with the local testing server: it calls the local test faucet and is unavailable as a production funding mechanism.
5. Use **Export Secret Key** only to back up or transfer a development wallet. Treat both exported formats as private keys: anyone who obtains one controls the wallet. Do not use a browser-stored or exported key for mainnet funds.

---

## 8. Running Automated Tests

Run the full validation suite:

```bash
# 1. Run unit tests across workspaces (sponsor quote verification & business logic)
npm run test

# 2. Run TypeScript strict typecheck
npm run typecheck

# 3. Run Playwright end-to-end browser test suite (with on-chain pool assertions)
# Keep `npm run localnet:setup` running in another terminal first.
npm run test:e2e
```

---

## 9. Troubleshooting & Common Issues

### 1. `solana CLI not found` or `anchor CLI not found`
- **Fix**: Make sure Solana and Anchor paths are in your `PATH` or explicitly configured in `.env`:
  ```ini
  SOLANA_BIN_DIR=/path/to/.local/share/solana/install/active_release/bin
  ANCHOR_BIN_DIR=/path/to/.cargo/bin
  ```

### 2. `A validator is already listening on http://127.0.0.1:8899`
- `npm run localnet:setup` will safely refuse to reset a validator that is already running.
- **Fix**: If an active `localnet:setup` session is running in another terminal tab, switch to it and press `Ctrl+C` to cleanly shut it down. If an orphaned session remains in the background:
  ```bash
  # If running in tmux:
  tmux kill-session -t comfi-validator
  # Or terminate by process name:
  pkill -f solana-test-validator
  ```
  Then re-run `npm run localnet:setup`.

### 3. `Initialize the localnet deployer before creating a pool`
- **Fix**: The global configuration PDA has not been initialized. Run `npm run localnet:setup`, or click the **Initialize localnet** button directly in the web UI hero banner.

### 4. Port 5173 already in use
- **Fix**: Vite will automatically select the next available port (e.g. 5174), or you can terminate the existing Node process with `npx kill-port 5173`.

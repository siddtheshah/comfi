# ComFi localnet UI E2E task list

## Current state

- [x] Anchor program builds with the pinned WSL toolchain (Anchor 1.1.2, Solana 3.1.10).
- [x] The program deploys to an isolated local validator.
- [x] Program identity is aligned across `declare_id!`, `Anchor.toml`, deploy keypair, and IDL.
- [x] Persistent localnet bootstrap and setup scripts are configured (`npm run localnet:setup`).
- [x] `GlobalConfig`, test USDC mint, treasury, and demo wallet are initialized and funded.
- [x] The web app connects to the Solana backend, reads on-chain pools, and displays live vault balances.

## 1. Repeatable localnet bootstrap

- [x] Add a `localnet:start` workflow that starts `solana-test-validator` with an isolated ledger outside the repository.
- [x] Add a `localnet:bootstrap` / `localnet:setup` workflow that deploys the program to `http://127.0.0.1:8899`.
- [x] Create dedicated local-only keypairs for the deployer, global administrator, treasury, and demo creator.
- [x] Airdrop local SOL to the accounts that pay fees and rent.
- [x] Create a local six-decimal test-USDC mint, its treasury ATA, and funded creator/member ATAs.
- [x] Call `initialize_global_config` with the local test-USDC mint, treasury ATA, and local quote-authority public key.
- [x] Call `create_pool` with deterministic demo rules and record its public address.
- [x] Write public bootstrap output (RPC URL, program ID, mint, treasury, global PDA, pool PDA, demo wallet public keys) to a generated ignored file (`localnet.json`).
- [x] Ensure every command explicitly selects localnet; never use the WSL CLI default cluster.

## 2. Shared Solana client

- [x] Add a browser-compatible Solana/Anchor RPC client package and binary account decoding (`apps/web/src/solana.ts`).
- [x] Centralize localnet/devnet RPC configuration and program ID selection in `.env`.
- [x] Implement PDA derivation and account decoding for `Pool`, vault token balance, and member metadata.
- [ ] Implement transaction builders for the initial UI slice: `join_pool`, `deposit`, `create_proposal`, `vote`, and `request_withdrawal`.
- [ ] Surface transaction simulation, confirmation, and program errors clearly in the UI.

## 3. Mock wallet for local UI development

- [x] Add React wallet-provider wiring with `http://127.0.0.1:8899` as the localnet endpoint.
- [x] Add a development-only mock-wallet mode (`VITE_WALLET_MODE=mock`) using a test adapter backed by the deterministic local test wallet.
- [x] Reject mock-wallet mode for non-local RPC endpoints and production builds.
- [x] Do not ship private keys in browser bundles.
- [x] For automated browser tests, use a deterministic test-only keypair controlled by the test harness; bootstrap funds its SOL and test-USDC accounts.
- [ ] Add real-wallet adapter support separately, keeping transaction construction independent of wallet choice.

## 4. Connect the UI

- [x] Supplement `apps/web/src/data.ts` demo values with live on-chain account reads in localnet mode.
- [x] Display the connected wallet, its member role, pool balance, membership count, and current-cycle details.
- [x] Wire “Start a pool” to the real create-pool flow on localnet and automatically refresh UI with the new on-chain pool.
- [ ] Wire deposits, payment requests, proposals, and votes to wallet-signed transactions.
- [x] Refresh account state after confirmation and show pending/failed transaction feedback.
- [x] Configure environment variables (.env) for RPC, wallet mode, and program ID across toolchain and web UI.

## 5. Sponsorship (follow-up; not required for core UI E2E)

- [ ] Add an actual HTTP host around `@comfi/sponsor-api`; it currently exports library logic only.
- [ ] Replace the local HMAC development signer with an Ed25519 signer that signs the exact Borsh `SponsorQuote` bytes required by `run_sponsored_set_alias`.
- [ ] Add a localnet-backed policy repository that reads finalized pool/member state.
- [ ] Add an Anchor integration test for the preceding Ed25519 verification instruction and sponsored alias update.

## 6. Verification

- [ ] Add a program integration test that bootstraps localnet and verifies global initialization, pool creation, join/deposit, proposal/vote, and withdrawal-request flows.
- [x] Add browser E2E coverage using the deterministic mock wallet and on-chain pool assertions (`npm run test:e2e`).
- [x] Verify localnet reset/rebootstrap is repeatable and leaves no tracked-file changes.
- [ ] Keep production deployment out of scope until separate wallet, treasury, audit, and integration-test plans are approved.


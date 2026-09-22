# ComFi localnet UI E2E task list

## Current state

- [x] Anchor program builds with the pinned WSL toolchain (Anchor 1.1.2, Solana 3.1.10).
- [x] The program deploys to an isolated local validator.
- [x] Program identity is aligned across `declare_id!`, `Anchor.toml`, deploy keypair, and IDL.
- [ ] No persistent localnet environment is configured.
- [ ] No `GlobalConfig`, test USDC mint, treasury, or `Pool` is initialized by the repository.
- [ ] The web app is static demo data; it has no Solana RPC client, wallet connection, or transaction flows.

## 1. Repeatable localnet bootstrap

- [ ] Add a `localnet:start` workflow that starts `solana-test-validator` with an isolated ledger outside the repository.
- [ ] Add a `localnet:bootstrap` workflow that deploys the program to `http://127.0.0.1:8899`.
- [ ] Create dedicated local-only keypairs for the deployer, global administrator, treasury, demo creator, and demo member.
- [ ] Airdrop local SOL to the accounts that pay fees and rent.
- [ ] Create a local six-decimal test-USDC mint, its treasury ATA, and funded creator/member ATAs.
- [ ] Call `initialize_global_config` with the local test-USDC mint, treasury ATA, and local quote-authority public key.
- [ ] Call `create_pool` with deterministic demo rules and record its public address.
- [ ] Write only public bootstrap output (RPC URL, program ID, mint, treasury, global PDA, pool PDA, demo wallet public keys) to a generated ignored file.
- [ ] Ensure every command explicitly selects localnet; never use the WSL CLI default cluster.

## 2. Shared Solana client

- [ ] Add a browser-compatible Solana/Anchor client package and generate or maintain usable program instruction types.
- [ ] Centralize localnet/devnet RPC configuration and program ID selection.
- [ ] Implement PDA derivation for `global`, `pool`, `member`, vault, proposal, request, and spending-cycle accounts.
- [ ] Implement account reads and decoding for `GlobalConfig`, `Pool`, `Member`, proposals, and withdrawal requests.
- [ ] Implement transaction builders for the initial UI slice: `create_pool`, `join_pool`, `deposit`, `create_proposal`, `vote`, and `request_withdrawal`.
- [ ] Surface transaction simulation, confirmation, and program errors clearly in the UI.

## 3. Mock wallet for local UI development

- [ ] Add React wallet-provider wiring with `http://127.0.0.1:8899` as the localnet endpoint.
- [ ] Add a development-only mock-wallet mode (for example, `VITE_WALLET_MODE=mock`) using a burner adapter or a small test adapter backed by a local keypair.
- [ ] Reject mock-wallet mode for non-local RPC endpoints and production builds.
- [ ] Do not ship a private key in normal or production bundles.
- [ ] For automated browser tests, use a deterministic test-only keypair controlled by the test harness; bootstrap must fund its SOL and test-USDC accounts.
- [ ] Add real-wallet adapter support separately, keeping transaction construction independent of wallet choice.

## 4. Connect the UI

- [ ] Replace `apps/web/src/data.ts` demo values with on-chain account reads in localnet mode.
- [ ] Display the connected wallet, its member role, pool balance, membership count, and current-cycle details.
- [ ] Wire “Start a pool” to the real create-pool flow.
- [ ] Wire deposits, payment requests, proposals, and votes to wallet-signed transactions.
- [ ] Refresh account state after confirmation and show pending/failed transaction feedback.
- [x] Configure environment variables (.env) for RPC, wallet mode, and program ID across toolchain and web UI.

## 5. Sponsorship (follow-up; not required for core UI E2E)

- [ ] Add an actual HTTP host around `@comfi/sponsor-api`; it currently exports library logic only.
- [ ] Replace the local HMAC development signer with an Ed25519 signer that signs the exact Borsh `SponsorQuote` bytes required by `run_sponsored_set_alias`.
- [ ] Add a localnet-backed policy repository that reads finalized pool/member state.
- [ ] Add an Anchor integration test for the preceding Ed25519 verification instruction and sponsored alias update.

## 6. Verification

- [ ] Add a program integration test that bootstraps localnet and verifies global initialization, pool creation, join/deposit, proposal/vote, and withdrawal-request flows.
- [ ] Add browser E2E coverage using the deterministic mock wallet.
- [ ] Verify localnet reset/rebootstrap is repeatable and leaves no tracked-file changes.
- [ ] Keep production deployment out of scope until separate wallet, treasury, audit, and integration-test plans are approved.


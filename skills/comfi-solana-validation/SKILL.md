---
name: comfi-solana-validation
description: Build, validate, and locally deploy the ComFi Anchor/Solana program from WSL. Use when verifying changes to programs/comfi/src/lib.rs, Anchor and Solana version compatibility, generated deployment artifacts, program-ID alignment, or an isolated localnet deployment. Never use this workflow to deploy to Devnet or Mainnet without explicit user approval.
---

# ComFi Solana validation

Run this workflow from the repository root, which contains `programs/comfi`,
`Anchor.toml`, and `target/`. Toolchain paths can be configured in `.env`.

## Validate the toolchain and build

Use a shell environment with Solana and Anchor installed. Confirm the
versions match the repository pins before building:

```shell
anchor --version; solana --version; cargo --version; rustc --version
anchor build
```

The project pins Anchor `1.1.2` and Solana `3.1.10`. Treat a successful
`anchor build` as compile and IDL-generation validation. Record macro-generated
`unexpected cfg` warnings, but do not call them build failures unless the
command exits nonzero.

## Check artifact identity

After the build, confirm the same program ID appears in all four places:

1. `declare_id!` in `programs/comfi/src/lib.rs`.
2. `programs.localnet.comfi` in `Anchor.toml`.
3. The public key derived from `target/deploy/comfi-keypair.json`.
4. `address` in `target/idl/comfi.json`.

Confirm that `target/deploy/comfi.so` exists and is nonempty. The IDL should
list the expected instructions. Note that `target/types/comfi.ts` is currently
empty; do not present it as usable generated TypeScript client output.

## Deploy to an isolated localnet

Use this only for a local validation. Do not rely on the default URL:
it may be `mainnet-beta`. Always pass `localnet` or `http://127.0.0.1:8899`
explicitly, or use `npm run localnet:setup`.

1. Start a temporary validator and confirm it responds:

```shell
solana-test-validator --reset
solana -u http://127.0.0.1:8899 cluster-version
```

2. If the configured WSL signer is unavailable, create a temporary payer under
`/tmp`, fund it only from the local validator, and use it explicitly. Never
create or substitute a mainnet signer.

```bash
solana-keygen new --no-bip39-passphrase --silent --outfile /tmp/comfi-test-payer.json
solana -u http://127.0.0.1:8899 airdrop 20 <TEMP_PAYER_PUBKEY>
```

3. Deploy and query the expected program ID:

```bash
cd <WSL_REPOSITORY_PATH>
anchor deploy --provider.cluster localnet --provider.wallet /tmp/comfi-test-payer.json
solana --url http://127.0.0.1:8899 --keypair /tmp/comfi-test-payer.json program show <PROGRAM_ID>
```

A successful query must show the expected program ID, owner
`BPFLoaderUpgradeab1e11111111111111111111111`, a ProgramData address, and a
nonzero data length matching the deployed `.so`.

Stop the validator and delete only the temporary payer created for this test.
Report explicitly that the test was localnet-only.

## Scope and reporting

`anchor test --skip-build` is not sufficient deployment evidence in this
workspace because it has no integration-test script. A passing localnet deploy
proves that the loader accepts the compiled program; it does not prove business
flows or authorize production deployment.

For Devnet or Mainnet, stop after the build/artifact checks and obtain explicit
user approval before any deployment, airdrop, wallet creation, or configuration
change. Require the intended cluster, deployer wallet, upgrade authority,
official USDC mint, treasury account, and an integration-test plan.

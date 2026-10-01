# ComFi Devnet testing fixtures

This directory documents the public configuration for a deliberately isolated
Devnet test deployment. It is for exercising ComFi's on-chain program with a
test token; it is not a production configuration and must never receive real
USDC or mainnet keys.

## Current deployment

| Item | Value |
| --- | --- |
| Cluster | Solana Devnet (`https://api.devnet.solana.com`) |
| Program ID | `bBVF974y98aLPaj17NcAFzYSoCENZwaN1rAvt3HfXTY` |
| ProgramData account | `6YnjNLg1SE9K4ggWsyT6ejPU1s8XFmozCyrw8232btbm` |
| Upgrade authority | `Cu5th5dsqqZ3hQ1MAfNPjwktgb4ktQ4z7yuD5Yvwu14f` |
| Program binary length | 586,888 bytes |
| GlobalConfig | `BVVfYV2AD4KsGWTF3zge1wfH9sb54he1M83UBWazwrNX` |
| Test mint | `HGwKgUvAsm1tdoujxCF7AViityt7gjPnTcqi4B5d5qtM` |
| Treasury authority | `Cu5th5dsqqZ3hQ1MAfNPjwktgb4ktQ4z7yuD5Yvwu14f` |
| Treasury token account | `5LywXjKyDpBeYwAXz5A9GcPTAjy9GS6wVp7KUb8Q6xAf` |
| Quote authority | `ARUqRS7phiw35GvB3qmFyRhDVv3XSXurFBEbSZkBoZfA` |
| Test pool #0 | `H3hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M` |

[`public.json`](public.json) is the reusable public manifest for this Devnet
fixture set. It contains no key material. The corresponding quote-authority
keypair remains only in the ignored `fixtures/devnet/runtime/` directory.
The listed test pool is a normal (non-testing-feature) pool with a 10 USDC
initial vault balance and a 1 USDC enrollment fee paid to the treasury.

The deployed binary is the normal build. It excludes the development-only
`test_*` instructions. Pool tests can use real, short timing parameters, or the
program may be explicitly upgraded with the `testing` feature for Devnet-only
fast-forward fixtures. Never enable that feature for production.

## Required fixtures before pool testing

1. **Test mint** — a newly created, six-decimal mint under the original SPL
   Token Program (`Tokenkeg...`). This is a Devnet-only test asset, not Circle
   USDC and not Token-2022.
2. **Treasury token account** — the treasury authority's associated token
   account (ATA) for that exact mint. The program sends enrollment fees and
   sponsored-action charges here.
3. **Quote authority** — a separate signing keypair. Its public key is stored
   in `GlobalConfig`; keep its secret key in the sponsor service's private
   configuration.
4. **Test members** — at least two funded Devnet wallets, each with an ATA for
   the test mint. The test-mint authority funds those accounts.

`initialize_global_config` records the administrator, mint, treasury ATA, and
quote-authority public key in the `global` PDA. The mint is effectively pinned
by this initialization: `update_global_config` can change only the treasury
and quote authority. Verify every address before submitting that transaction.

## Public versus private state

Commit only public addresses and transaction signatures. The active Devnet
fixture set is recorded in [`public.json`](public.json); use
[`public.example.json`](public.example.json) only as a schema template for a
separate fixture set. A runtime copy may be written to
`fixtures/devnet/runtime/public.json` during setup, but it is not the canonical
shared manifest.

Do **not** commit or paste any of these:

- deployer, mint-authority, treasury-authority, member, or quote-authority
  keypairs;
- seed phrases or private keys;
- sponsor-service HMAC/signing secrets.

The repository ignores `fixtures/devnet/runtime/` and `*.keypair.json` files in
this directory for that reason.

## Test sequence

1. Confirm the program and its upgrade authority on Devnet.
2. Create the test mint, treasury ATA, quote-authority keypair, and member
   wallets; record their public addresses in the runtime manifest.
3. Initialize `GlobalConfig` exactly once.
4. Mint fixture balances to members, then test `create_pool`, `join_pool`,
   deposits, aliases, pausing, requests, governance, spends, and closure flows.
5. Record transaction signatures and expected account balances in the runtime
   manifest. Treat failed authorization and wrong-mint attempts as negative
   test cases.

Use the isolated localnet workflow for fast iteration. Devnet verifies the
public-cluster deployment and integration behavior; it is not a production
environment.

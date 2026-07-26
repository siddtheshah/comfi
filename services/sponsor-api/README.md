# ComFi sponsor API

Framework-independent TypeScript quote issuer for the ComFi Solana program. It issues short-lived, signed quotes; it does **not** submit transactions, custody a user key, or decide final eligibility. The Anchor program remains authoritative and must re-check every field in the signed quote atomically.

## Contract

`POST /v1/quotes/actions` accepts `{ pool, member, action, actionDigest }` and returns a flattened `sponsored_action` quote: `quoteId`, `pool`, `member`, `action`, `chargeUsdc`, `expiresAt`, and `signature` are all top-level fields (along with the other signed verification fields). `chargeUsdc` is a decimal string in native atomic units. `actionDigest` is the SHA-256 hash of canonical typed instruction arguments; arbitrary serialized transaction data is intentionally excluded. The quote binds the pool, member, action, digest, treasury, exact charge, program ID, authority, and expiry.

`POST /v1/quotes/enrollment` accepts either:

- `{ operation: "join_pool", pool, member, proposedDepositAtomic, createUsdcAta, invitationId? }`
- `{ operation: "increase_member_cap", pool, requestedMemberCap, additionalSponsoredSlots }`

The join quote requires an available sponsored slot plus a qualifying deposit or approved invitation. The capacity quote binds the fee paid by `execute_member_cap_increase`. Both return `{ quote, signature }`; successful responses are `201`, policy/validation failures are `422`, and absent pools are `404`.

All USDC amounts are decimal strings in native six-decimal atomic units. In V0, `set_alias` is the sole allowlisted sponsored action because it is the sole corresponding Anchor instruction. Quotes are canonically serialized with sorted JSON keys before signing. `HmacSha256QuoteSigner` is strictly a local-development adapter: production must supply an Ed25519/Solana-compatible `QuoteSigner` whose public key exactly matches `ComFiDeployer.enrollment_quote_authority` (or its configured successor).

The Anchor program verifies Borsh-serialized `SponsorQuote` bytes in an Ed25519 instruction. Before enabling the production path, the signer adapter must therefore serialize the returned fields to that exact format (including a 32-byte `quoteId`, parsed public keys, atomic `chargeUsdc`, and Unix-second expiry) and sign those bytes rather than this development JSON canonicalization. An Anchor validator integration test is required for that adapter; it cannot run in the current workspace because the Solana toolchain is not installed.

## Run

```sh
npm install
npm test
```

An API host should build a `SponsorQuoteService` with an indexer/finalized-chain-backed `SponsorPolicyRepository`, a production signer, and pricing loaded from the published fee schedule. Re-read finalized pool/member state immediately before issuing; also reconcile issued enrollment sponsorships against confirmed `join_pool` events. Never treat this service's policy snapshot as a substitute for the on-chain checks.

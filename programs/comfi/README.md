# ComFi Anchor program

This is the on-chain enforcement layer for one ComFi pooled-USDC product. It
is deliberately a small, auditable starting point: pool funds sit only in a
PDA-owned native-USDC vault, and every outgoing transfer passes through a typed
withdrawal request and a per-cycle spend limit.

## Prerequisites

- Rust stable and `cargo`
- Solana CLI (use Devnet/localnet during development)
- Anchor CLI compatible with Anchor `1.1.2`
- Node.js is needed only if a workspace-level TypeScript test suite is added

The repository already provides the root `Anchor.toml`, a matching program
keypair, and localnet configuration. Build from the repository root:

```shell
anchor build
```

The current WSL toolchain is Anchor `1.1.2` and Solana CLI `3.1.10`, matching
the workspace pins. `anchor build` produces the deployable SBF artifact and
IDL in `target/`.

`anchor test --skip-build` does not exercise a deployment because this workspace
does not yet define an integration-test script. Use the repository's
`skills/comfi-solana-validation/SKILL.md` workflow for an isolated localnet
deployment check. Do not deploy to Devnet or Mainnet without explicit approval.

## Security boundary

- `GlobalConfig` pins the sole accepted USDC mint and treasury token account.
- `Pool` is the authority of its associated-token vault; neither the global
  administrator nor a creator receives a vault token allowance.
- A `WithdrawalRequest` is immutable after creation. `spend` rechecks its
  amount, recipient, requester role, current `SpenderCycle`, and (when needed)
  a passed governance proposal before signing the token transfer.
- One `VoteReceipt` PDA prevents double voting. Proposal approval is delayed by
  an explicit timelock.

This scaffold is **not audited** and must not manage production funds. The
allowlisted alias-update path verifies sponsor quotes; enrollment-cap quote
payment, member removal, and governance execution for role/action-allowance
changes remain intentionally deferred to reviewed follow-up work instead of
granting an administrator a shortcut around governance.

## Public instruction contract

| Instruction | Signer / key arguments | Result |
| --- | --- | --- |
| `initialize_global_config` | administrator, USDC mint, treasury ATA | Initializes the immutable-mint registry. |
| `update_global_config`, `pause_new_pool_creation` | administrator | Changes registry metadata / stops only future pools. |
| `create_pool` | creator, creator USDC ATA, `CreatePoolArgs` | Pays enrollment fee to treasury, creates PDA vault and funded admin member. |
| `join_pool` | user, user USDC ATA, `JoinPoolArgs` | Adds a funded member and stores alias hash + encryption public key. |
| `deposit` | member, source USDC ATA, amount | Transfers native USDC into that pool vault. |
| `request_withdrawal` | spender/admin member, recipient, amount, hash, proposal flag | Records an immutable request; no funds move. |
| `create_proposal`, `vote`, `finalize_proposal` | eligible member | Creates, votes on, then resolves an action after deadline/timelock. |
| `execute_spender_limit` | any executor + passed `SetSpenderLimit` proposal | Creates/updates the spender's current-cycle cap. |
| `spend` | eligible executor, requester's member/cycle, optional passed proposal | Performs the guarded vault transfer. |
| `set_alias`, `roll_cycle` | member / anyone | Unsponsored alias update / advances a monotonic accounting cycle. |
| `run_sponsored_set_alias` | member + sponsor quote | Verifies a preceding Ed25519 sponsor quote, charges the vault-to-treasury USDC fee, then updates opaque alias metadata atomically. |

Clients should derive accounts from the PDA seeds documented beside each account
type in `src/lib.rs`, fetch the pool's vault ATA from `Pool.vault`, and pass
only the canonical native-USDC mint stored in `GlobalConfig`.

### Sponsored instruction layout

The sponsor API response maps to `SponsorQuote` as follows: `quoteId` is a
32-byte identifier, `pool` and `member` are PDAs, `action` is currently the
allowlisted `SetAlias` enum value, `chargeUsdc` is `u64`, and `expiresAt` is an
`i64` Unix timestamp. `treasuryUsdc` is included in the signed bytes to prevent
redirection. The API's `signature` is not accepted as an ordinary instruction
argument: the client must put it in an Ed25519-program instruction immediately
before `run_sponsored_set_alias`; the program reads that instruction and checks
its signer and exact signed message against `GlobalConfig.quote_authority`. A
`SponsorQuoteReceipt` PDA makes each `quoteId` single-use.

This gives the frontend/API a stable construction order:

1. Ask the sponsor API for `{ quoteId, pool, member, action, chargeUsdc,
   expiresAt, signature }`.
2. Serialize the corresponding `SponsorQuote` using Anchor/Borsh and create
   one Ed25519 verification instruction from its signature.
3. Append `run_sponsored_set_alias(quote, aliasHash, encryptionPublicKey)` in
   the same transaction, directly after that verification instruction.

The program independently checks the signed pool, member, action, expiry,
charge cap, member allowance, treasury, and quote signer before its CPI charge.

## Architecture Decision Records (ADRs)

Key architectural decisions, economic mechanisms, and security invariants are recorded under [`adrs/`](adrs/README.md):
- [ADR 0001: Fair Closure Algorithm](adrs/0001-fair-closure-algorithm.md) — Multi-cycle liquidation waterfall, $O(1)$ cumulative spend-benefit streaming accumulator, and anti-cartel settlement.



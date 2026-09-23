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

## Security Vulnerability & Audit Tracker

> [!WARNING]
> This program has identified security vulnerabilities that allow unauthorized control or extraction of vault funds. The following tracker logs active findings from the adversarial security audit for systematic remediation.

### Vulnerability Status Matrix

| ID | Severity | Status | Title | Affected Area |
| :--- | :--- | :--- | :--- | :--- |
| **VULN-01** | `CRITICAL` | `[ ] Open` | Disproportionate Benefit Socialization via `requires_proposal: false` in `spend` | [`src/pool.rs:L1706-L1730`](src/pool.rs#L1706-L1730) |
| **VULN-02** | `CRITICAL` | `[ ] Open` | Vote Threshold Scale / Basis Point Confusion Enabling Single-Vote DAO Takeover | [`src/pool.rs:L712-L728`](src/pool.rs#L712-L728) |
| **VULN-03** | `CRITICAL` | `[ ] Open` | Timelock Bypass in Cycle Rollover (`process_cycle_proposals`) | [`src/pool.rs:L1149-L1237`](src/pool.rs#L1149-L1237) |
| **VULN-04** | `CRITICAL` | `[ ] Open` | `sync_surplus` Lockout on Closure Enabling Senior Tier Drainage | [`src/pool.rs:L630-L640`](src/pool.rs#L630-L640), [`L1746`](src/pool.rs#L1746) |
| **VULN-05** | `HIGH` | `[ ] Open` | Governance `ApproveWithdrawal` Permanent Deadlock | [`src/pool.rs:L1641-L1667`](src/pool.rs#L1641-L1667) |
| **VULN-06** | `HIGH` | `[ ] Open` | Inline Spender Cycle PDA Derivation Mismatch Bricking Limits | [`src/pool.rs:L1190-L1208`](src/pool.rs#L1190-L1208) |
| **VULN-07** | `HIGH` | `[ ] Open` | Production `testing_enabled` State Tampering & Permissionless Handlers | [`src/deployer.rs:L238`](src/deployer.rs#L238), [`src/pool.rs:L1308-L1340`](src/pool.rs#L1308-L1340) |
| **VULN-08** | `HIGH` | `[ ] Open` | Recurring Member Deposits Diverted to Non-Conferred Surplus | [`src/pool.rs:L941-L953`](src/pool.rs#L941-L953) |

---

### Detailed Findings & Remediation Plan

#### [ ] VULN-01: Disproportionate Benefit Socialization in `spend` (CRITICAL)
- **Location**: [`src/pool.rs:L1706-L1730`](src/pool.rs#L1706-L1730)
- **Impact**: Spender extracts 100% of cash withdrawal into their own wallet, but the protocol assumes it is a "shared operating spend" whenever `requires_proposal == false`. The spender's personal `cumulative_benefit_received` is debited only by their $1/N$ share, while $(N-1)/N$ is socialized to innocent members. On pool closure, the spender claims almost their entire original deposit back, stealing other members' capital.
- **Remediation**:
  1. Forbid unvoted member withdrawals to arbitrary recipient addresses; require that unvoted spends route only to verified vendors or require dedicated governance approval.
  2. If withdrawals are directed to a member's own account, debit 100% of the withdrawal directly from `requester.cumulative_benefit_received`.

#### [ ] VULN-02: Vote Threshold Basis Point Confusion (CRITICAL)
- **Location**: [`src/pool.rs:L712-L728`](src/pool.rs#L712-L728)
- **Impact**: `required_votes_for_pool` treats any `vote_threshold <= 100` as percentage basis points (`threshold * 100`). Setting `vote_threshold = 2` (intended as 2 members) evaluates to 200 bps (2%). In pools with $\le 50$ members, `(50 * 200 + 9999) / 10000 = 1`. A single attacker can pass any proposal alone and drain the vault.
- **Remediation**:
  1. Eliminate ambiguous threshold interpretation. Enforce that vote threshold is strictly an explicit basis point range ($> 100$ and $\le 10{,}000$) or an absolute count enum.
  2. Add validation requiring at least a strict majority ($> 5{,}000$ bps) for critical actions like `SetSpenderLimit` and `ClosePool`.

#### [ ] VULN-03: Timelock Bypass in `process_cycle_proposals` (CRITICAL)
- **Location**: [`src/pool.rs:L1149-L1237`](src/pool.rs#L1149-L1237)
- **Impact**: Proposals processed during `roll_cycle` transition directly to `ProposalState::Executed`, executing configuration changes, spender limits, and pool closures instantly without observing `pool.timelock_seconds`.
- **Remediation**:
  1. Ensure all proposals passing in `process_cycle_proposals` transition to `ProposalState::Executable` with `executable_after = clock.unix_timestamp + pool.timelock_seconds`.
  2. Enforce explicit execution via `execute_*` after timelock expiration.

#### [ ] VULN-04: `sync_surplus` Lockout on Closure (CRITICAL)
- **Location**: [`src/pool.rs:L630-L640`](src/pool.rs#L630-L640), [`src/pool.rs:L1746`](src/pool.rs#L1746)
- **Impact**: `Member::sync_surplus` guards with `!pool.is_closing`. When `claim_closure_refund` runs, `pool.is_closing` is already true, making `sync_surplus` a no-op. Members who paid advance surplus for future cycles can participate in those cycles, consume pool funds, and still withdraw their surplus as senior Priority 1 debt on closure.
- **Remediation**:
  1. Decouple cycle consumption from `!pool.is_closing` so that prepaid cycles elapsed prior to closure are properly recognized as conferred capital.

#### [ ] VULN-05: Governance `ApproveWithdrawal` Deadlock (HIGH)
- **Location**: [`src/pool.rs:L1641-L1667`](src/pool.rs#L1641-L1667)
- **Impact**: `spend` unconditionally requires `ctx.accounts.spender_cycle` where `next_spent <= cycle.cap`. A one-off withdrawal passed and approved by governance fails with `SpendLimitExceeded` or uninitialized account error if the member does not have an active spender limit for that cycle.
- **Remediation**:
  1. Make `spender_cycle` optional or bypass recurring spender cap checks when a valid `ProposalAction::ApproveWithdrawal` is executed.

#### [ ] VULN-06: Inline Spender Cycle PDA Derivation Mismatch (HIGH)
- **Location**: [`src/pool.rs:L1190-L1208`](src/pool.rs#L1190-L1208)
- **Impact**: Passing an existing `SpenderCycle` from an old cycle in `remaining_accounts` mutates `sc.cycle = pool.current_cycle` and sets the proposal to `Executed`, but the PDA address remains tied to the old cycle seed. Subsequent `spend` calls look for the new cycle seed, which does not exist, permanently bricking the limit.
- **Remediation**:
  1. Remove inline mutation of `SpenderCycle` in `process_cycle_proposals`. Require initialization through `execute_spender_limit`.

#### [ ] VULN-07: Production `testing_enabled` State Tampering (HIGH)
- **Location**: [`src/deployer.rs:L238`](src/deployer.rs#L238), [`src/pool.rs:L1308-L1340`](src/pool.rs#L1308-L1340)
- **Impact**: `testing_enabled` can be enabled in production. Test instructions (`test_set_cycle`, `test_advance_cycles`, `test_finalize_proposal`) lack signer checks, allowing any third party to tamper with cycles and proposal states.
- **Remediation**:
  1. Compile-gate all `test_*` instructions behind `#[cfg(feature = "testing")]` so they are not included in release binaries.

#### [ ] VULN-08: Recurring Member Deposits Diverted to Non-Conferred Surplus (HIGH)
- **Location**: [`src/pool.rs:L941-L953`](src/pool.rs#L941-L953)
- **Impact**: For already-funded members, all additional deposits in `deposit` are routed to `surplus_amount` with `delta_conferred = 0`. The pool's `total_conferred_capital` is starved and not updated until a subsequent cycle's `sync_surplus` runs, preventing legitimate operations.
- **Remediation**:
  1. Correctly recognize recurring cycle obligation deposits into `total_conferred_capital` when depositing for current obligations.




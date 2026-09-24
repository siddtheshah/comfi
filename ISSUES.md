# ComFi Security Vulnerability Report: Pool & Governance Attack Vectors

This document details critical and high-severity security vulnerabilities and attack vectors identified in [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs) (and related deployer logic). These issues enable malicious or minority participants to gain control of, drain, or use pool funds without legitimate, majority proposal authorization.

---

## Executive Summary

| Issue ID | Severity | Category | Description | Status |
|---|---|---|---|---|
| **COMFI-SEC-01** | **Critical** | Governance / Access Control | Missing strict majority floor on `ApproveWithdrawal` proposals enables single-voter fund drainage | **Resolved** |
| **COMFI-SEC-02** | **Critical** | Governance / State Mutation | `ConfigurationModification` lacks majority floor and bypasses pending-state cycle staging | **Resolved** |
| **COMFI-SEC-03** | **High** | Accounting / Liquidation | "Ghost Unfunded" exploit on pool closure: depositing 1 unit flips `is_funded` to false, evading spend attribution and draining senior Tier-1 refunds | **Resolved** |
| **COMFI-SEC-04** | **High** | Governance / State Drift | Inactive members retain perpetual funded voting status across infinite future cycles | **Resolved** |
| **COMFI-SEC-05** | **Medium** | Accounting / Governance DoS | Asymmetric `funded_member_count` updates permit counter inflation, diluting shared spend benefit deltas to zero and bricking voting quorums | **Resolved** |
| **COMFI-SEC-06** | **Medium** | Spend Attribution Bypass | Unfunded members can request shared vendor spends without having benefits attributed to their closure basis | **Resolved** |
| **COMFI-SEC-07** | **Medium** | Math / Account Lockout | `deposit` underflow in `total_non_conferred_capital` permanently locks member accounts from re-funding | **Resolved** |
| **COMFI-SEC-08** | **Critical** | Governance / Voter Manipulation | Mid-cycle `join_pool` immediately confers funded status and increments voter count, enabling single-voter proposal hijacking | **Resolved** |
| **COMFI-SEC-10** | **High** | Governance / Scalability | Variable-space vector member storage and omission attack during cycle rollover replaced with singly-linked list registry | **Resolved** |

---

## Detailed Findings

---

### COMFI-SEC-01: Missing Strict Majority Floor on `ApproveWithdrawal` Enables Single-Voter Fund Drainage

- **Severity:** Critical
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L723-L748), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1427-L1455), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1572-L1705)

#### Description
In `Proposal::required_votes_for_pool`, strict majority enforcement (`threshold_bps.max(5001)`) was added for `SetSpenderLimit` and `ClosePool` (under `VULN-02`), but **omitted** for `ProposalAction::ApproveWithdrawal`:

```rust
pub fn required_votes_for_pool(&self, pool: &Pool) -> Result<u32> {
    require!(
        self.vote_threshold >= 100 && self.vote_threshold <= 10_000,
        ComfiError::InvalidVoteThreshold
    );
    let mut threshold_bps = self.vote_threshold as u64;
    if matches!(
        self.action,
        ProposalAction::SetSpenderLimit { .. } | ProposalAction::ClosePool
    ) {
        threshold_bps = threshold_bps.max(5001);
    }
    let active_members = (pool.funded_member_count as u64).max(1);
    let required = active_members
        .checked_mul(threshold_bps)
        .ok_or(ComfiError::MathOverflow)?
        .checked_add(9999)
        .ok_or(ComfiError::MathOverflow)?
        / 10_000;
    Ok((required as u32).max(1))
}
```

#### Attack Scenario
1. `validate_create_pool` allows any `vote_threshold` from 100 bps (1%) to 10,000 bps (100%).
2. In a pool with 10 funded members and `vote_threshold = 1000` (10%), or a 2-member pool with `vote_threshold = 5000` (50%):
   $$\text{required} = \frac{10 \times 1000 + 9999}{10,000} = 1 \text{ vote}$$
3. An attacker becomes a funded member, calls `request_withdrawal` for an amount up to the pool's entire `total_conferred_capital`, specifying their own wallet's token account as `recipient`, with `requires_proposal = true`.
4. The attacker submits an `ApproveWithdrawal` proposal and casts **1 YES vote**.
5. Since `yes_votes (1) >= required (1)` and `yes_votes > no_votes (0)`, `is_passed_for_pool` evaluates to `true`.
6. If `withdrawal_execution_mode == ExecutionMode::ThresholdMet`, `finalize_proposal` can be called immediately.
7. Because `timelock_seconds` can be set to 0 at pool deployment, the proposal immediately becomes executable.
8. The attacker calls `spend` within the same transaction or block, completely draining the pool vault without majority authorization or allowing other members time to cast NO votes.

#### Remediation
Include `ProposalAction::ApproveWithdrawal` in the strict majority floor in `required_votes_for_pool`:
```rust
if matches!(
    self.action,
    ProposalAction::SetSpenderLimit { .. }
        | ProposalAction::ClosePool
        | ProposalAction::ApproveWithdrawal { .. }
) {
    threshold_bps = threshold_bps.max(5001);
}
```

#### Resolution
- Enforced strict majority floor (>= 5001 bps) in `validate_create_pool`, guaranteeing that all pools start with a strong consensus floor.
- Included `ProposalAction::ApproveWithdrawal` in `Proposal::required_votes_for_pool` with `threshold_bps.max(5001)`.
- Verified in unit test `test_comfi_sec_01_approve_withdrawal_strict_majority_floor` that sub-majority approvals fail in both 2-member and 10-member pools.

---

### COMFI-SEC-02: `ConfigurationModification` Lacks Majority Floor and Staging Mechanism

- **Severity:** Critical
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L729-L734), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1501-L1569)

#### Description
1. `ProposalAction::ConfigurationModification` is also omitted from the `threshold_bps.max(5001)` check, allowing minority factions to pass structural governance amendments.
2. In `execute_configuration_modification`, the handler mutates live pool configuration fields immediately instead of storing them into `pending_*` fields and waiting for `apply_pending_config` during `roll_cycle`:

```rust
pool.vote_threshold = vote_threshold;
pool.cycle_duration_seconds = cycle_duration_seconds;
pool.member_obligation_amount = member_obligation_amount;
pool.spender_limit_deadline_cycles = spender_limit_deadline_cycles;
pool.withdrawal_deadline_cycles = withdrawal_deadline_cycles;
pool.config_modification_deadline_cycles = config_modification_deadline_cycles;
pool.spender_limit_execution_mode = spender_limit_execution_mode;
pool.withdrawal_execution_mode = withdrawal_execution_mode;
pool.config_modification_execution_mode = config_modification_execution_mode;
pool.has_pending_config = false;
```

#### Attack Scenario
1. A minority attacker submits a `ConfigurationModification` proposal to lower `vote_threshold` to 100 bps (1%), change `withdrawal_execution_mode` to `ThresholdMet`, and set `cycle_duration_seconds` to 1.
2. The proposal passes with minority support and is executed.
3. The pool's active parameters are immediately modified without any cycle rollover buffer.
4. The attacker proceeds to execute `ApproveWithdrawal` under the newly weakened threshold, extracting unauthorized funds.

#### Remediation
1. Enforce strict majority floor (`threshold_bps.max(5001)`) for `ConfigurationModification`.
2. Stage configuration changes onto `pool.pending_*` fields and set `pool.has_pending_config = true`:
```rust
pool.pending_vote_threshold = vote_threshold;
pool.pending_cycle_duration_seconds = cycle_duration_seconds;
pool.pending_member_obligation_amount = member_obligation_amount;
pool.pending_spender_limit_deadline_cycles = spender_limit_deadline_cycles;
pool.pending_withdrawal_deadline_cycles = withdrawal_deadline_cycles;
pool.pending_config_modification_deadline_cycles = config_modification_deadline_cycles;
pool.pending_spender_limit_execution_mode = spender_limit_execution_mode;
pool.pending_withdrawal_execution_mode = withdrawal_execution_mode;
pool.pending_config_modification_execution_mode = config_modification_execution_mode;
pool.has_pending_config = true;
```

#### Resolution
- Included `ProposalAction::ConfigurationModification` in `Proposal::required_votes_for_pool` with `threshold_bps.max(5001)`.
- Added strict parameter validation (`vote_threshold >= 5001 && vote_threshold <= 10_000`) in both `create_proposal` and `execute_configuration_modification` so any attempt to lower the threshold below the 50% majority floor fails validation immediately.
- Updated `execute_configuration_modification` to stage all modified configuration fields into `pool.pending_*` and set `pool.has_pending_config = true`, deferring live state mutations until `apply_pending_config()` is executed at cycle boundary.
- Verified in unit tests `test_comfi_sec_02_configuration_modification_majority_floor_and_staging`, `test_configuration_modification_below_majority_threshold_rejected`, and `test_configuration_modification_deferred_until_cycle_roll`.

---

### COMFI-SEC-03: Senior Priority Fund Drainage on Pool Closure via `is_funded` Manipulation ("Ghost Unfunded")

- **Severity:** High
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L626-L632), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L653-L667), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L967-L975), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1707-L1765)

#### Description
1. `Member::non_conferred_amount()` returns `self.total_contributions` whenever `!self.is_funded`:
   ```rust
   pub fn non_conferred_amount(&self) -> u64 {
       if !self.is_funded {
           self.total_contributions
       } else {
           self.surplus_amount
       }
   }
   ```
2. In `claim_closure_refund`, `non_conferred_amount()` is treated as Senior Priority 1 capital and is refunded in full without deducting `cumulative_benefit_received`. Only Priority 2 (conferred capital) deducts `cumulative_benefit_received`.
3. In `deposit`, if a member in a new cycle (`member.funded_cycle < pool.current_cycle`) deposits any amount less than `pool.member_obligation_amount` (e.g. 1 unit), the program sets `member.is_funded = false`:
   ```rust
   } else if member.funded_cycle < pool.current_cycle {
       if amount >= current_obligation { ... }
       else {
           (0, false, 0u64, amount as i128)
       }
   }
   ...
   member.is_funded = becomes_funded; // false!
   ```
4. In `sync_benefit`:
   ```rust
   if self.is_funded_for_pool(pool) {
       let accrued = (diff / BENEFIT_SCALE) as u64;
       self.cumulative_benefit_received = self.cumulative_benefit_received
           .checked_add(accrued)?;
   }
   self.last_benefit_index = pool.cumulative_benefit_per_member;
   ```
   If `!self.is_funded`, `sync_benefit` drops all un-synced spend benefits from `cumulative_benefit_received`.

#### Attack Scenario
1. Member A deposits 100 USDC in cycle 0 and is funded.
2. The pool executes 100 USDC of shared spends (e.g., to an off-chain vendor), increasing `pool.cumulative_benefit_per_member`. Member A enjoyed 50 USDC of benefit.
3. In cycle 1, Member A intentionally deposits 1 micro-USDC. Because $1 < \text{obligation}$, `member.is_funded` flips to `false`.
4. The pool later closes via `ClosePool`.
5. Member A calls `claim_closure_refund`:
   - `sync_benefit` sees `!is_funded`, so Member A's `cumulative_benefit_received` is never debited.
   - `non_conferred_amount()` evaluates to `self.total_contributions` (101 USDC).
   - Member A receives 101 USDC in Senior Priority 1 refund.
6. Honest members who remained funded receive nothing because the vault deficit caused by the 100 USDC spend is shifted entirely onto Tier-2 conferred capital.

#### Remediation
- Track non-conferred capital accurately by recording un-conferred deposits explicitly rather than equating `!is_funded` with full lifetime contributions.
- Deduct `cumulative_benefit_received` and `total_withdrawn` against total contributions across all closure tiers.
- In `sync_benefit`, do not discard spend benefit accruals for members who were funded during the cycle when the spend occurred.

#### Resolution
- Enforced that member funded status (`is_funded`) only flips on cycle rollover (`roll_cycle`), never during mid-cycle deposits.
- Mid-cycle deposits accumulate strictly into `surplus_amount` and `total_non_conferred_capital`, preventing an attacker from manipulating `is_funded` or evading spend deductions on pool closure.
- Added `test_funded_status_only_flips_on_cycle_rollover_not_deposit` verifying that depositing mid-cycle does not flip funded status.

---

### COMFI-SEC-04: Inactive Members Retain Perpetual Funded Voting Status

- **Severity:** High
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L622-L624), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1192-L1216)

#### Description
`Member::is_funded_for_pool` is implemented as:
```rust
pub fn is_funded_for_pool(&self, pool: &Pool) -> bool {
    self.is_funded && self.deposited_total >= pool.member_obligation_amount
}
```
`roll_cycle` advances `pool.current_cycle` but does not mutate `Member` state.
Because `is_funded_for_pool` does not check `self.funded_cycle == pool.current_cycle`, any member who paid `member_obligation_amount` once in cycle 0 remains permanently recognized as a "funded voting member" for cycles 1, 2, ..., 100+ without making any recurring contributions.

#### Attack Scenario
- An early participant deposits for cycle 0 only.
- In subsequent cycles, active members deposit new capital into the pool.
- The inactive participant retains full voting rights to approve proposals, allocate spender limits, and vote on withdrawals involving funds they did not help contribute.

#### Remediation
Enforce that a member is only funded for the active cycle or prepaid surplus cycles:
```rust
pub fn is_funded_for_pool(&self, pool: &Pool) -> bool {
    self.is_funded
        && self.funded_cycle == pool.current_cycle
        && self.deposited_total >= pool.member_obligation_amount
}
```

#### Resolution
- Implemented `is_funded_for_pool` requiring `self.funded_cycle == pool.current_cycle`.
- Implemented `process_cycle_members` in `roll_cycle` to transition all member accounts: members with `surplus_amount >= obligation` automatically have their surplus transferred to `total_conferred_capital`, `is_funded = true`, and their `funded_cycle` advanced. Members without sufficient surplus are transitioned to `is_funded = false`, immediately stripping voting rights in the new cycle.
- Enforced `ensure_cycle_current` gatekeeper across all pool operations, blocking operations if cycle time has elapsed until `roll_cycle` is called.
- Verified in unit test `test_inactive_members_lose_voting_status_in_new_cycle` and `test_roll_cycle_updates_members_and_moves_surplus`.

---

### COMFI-SEC-05: Benefit Dilution & Governance DoS via `funded_member_count` Inflation

- **Severity:** Medium
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1000-L1005), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1681-L1695)

#### Description
In `deposit`, `pool.funded_member_count` is incremented when `!was_funded && becomes_funded`:
```rust
if !was_funded && becomes_funded {
    pool.funded_member_count = pool
        .funded_member_count
        .checked_add(1)
        .ok_or(ComfiError::MathOverflow)?;
}
```
However, `pool.funded_member_count` is **never decremented** when `was_funded && !becomes_funded`.
When a funded member deposits less than the cycle obligation in a new cycle, `was_funded` is true and `becomes_funded` is false (`funded_member_count` unchanged). When they deposit again to meet the obligation, `!was_funded && becomes_funded` triggers again, incrementing `funded_member_count`.

#### Impact
1. **Governance DoS:** A member can repeatedly cycle their status to inflate `funded_member_count` arbitrarily high. Because `required_votes_for_pool` multiplies by `pool.funded_member_count`, the required vote count can exceed total physical members, making all future proposals impossible to pass.
2. **Dilution of Benefit Accounting:** In `spend`:
   ```rust
   let benefit_delta = (request.amount as u128)
       .checked_mul(BENEFIT_SCALE)?
       .checked_div(active_funded_members)?;
   ```
   An inflated `funded_member_count` causes integer division to truncate `benefit_delta` to 0. Members accumulate 0 `cumulative_benefit_received`, evading spend deductions on pool closure.

#### Remediation
Decrement `funded_member_count` when a member transitions from funded to unfunded:
```rust
if was_funded && !becomes_funded {
    pool.funded_member_count = pool.funded_member_count.saturating_sub(1);
} else if !was_funded && becomes_funded {
    pool.funded_member_count = pool.funded_member_count.checked_add(1)?;
}
```

#### Resolution
- Updated `deposit` to decrement `funded_member_count` with `saturating_sub(1)` when a member transitions from funded to unfunded, preventing counter inflation.
- In `roll_cycle`'s `process_cycle_members`, `pool.funded_member_count` is updated directly to the count of members that are funded for the new cycle.

---

### COMFI-SEC-06: Unfunded Member Shared Spend Attribution Bypass

- **Severity:** Medium
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1297-L1300), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1583-L1586), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1696)

#### Description
- `request_withdrawal` only requires `ctx.accounts.member.can_request_spend()`, which is true for all members regardless of funded status.
- In `spend`, `requester_member` is also only checked with `can_request_spend()`.
- When a spend is executed to an external vendor (`recipient_usdc.owner != requester.wallet`), line 1696 executes:
  ```rust
  requester.sync_benefit(&ctx.accounts.pool)?;
  ```
- Because `requester` is unfunded, `sync_benefit` ignores the benefit delta (`self.is_funded_for_pool` is false).
- The unfunded requester routes pool funds to their external destination, yet never accumulates any benefit deduction against their own account.

#### Remediation
Require `requester_member.is_funded_for_pool(&ctx.accounts.pool)` in `request_withdrawal` and `spend`, or ensure that vendor spend benefits are debited regardless of current funded status.

#### Resolution
- Added `require!(ctx.accounts.member.is_funded_for_pool(&ctx.accounts.pool), ComfiError::MemberNotFunded)` in `request_withdrawal`.
- Added `require!(ctx.accounts.requester_member.is_funded_for_pool(&ctx.accounts.pool), ComfiError::MemberNotFunded)` in `spend`.
- Verified in unit test `test_comfi_sec_06_unfunded_member_cannot_request_or_spend`.

---

### COMFI-SEC-07: Math Underflow Lockout in `deposit`

- **Severity:** Medium
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L958-L966), [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L1012-L1016)

#### Description
In `deposit`, if a member is unfunded and deposits an amount that satisfies `next_total >= current_obligation`, the handler computes:
```rust
(excess, true, current_obligation, (amount as i128) - (current_obligation as i128))
```
If `amount < current_obligation`, `delta_non_conferred` is negative.
Line 1014 attempts to subtract this negative delta from `pool.total_non_conferred_capital`:
```rust
let neg = (-delta_non_conferred) as u64;
pool.total_non_conferred_capital = pool
    .total_non_conferred_capital
    .checked_sub(neg)
    .ok_or(ComfiError::MathOverflow)?;
```
If `total_non_conferred_capital < neg`, the transaction aborts with `ComfiError::MathOverflow`. Once in this state, the member is permanently prevented from depositing and cannot restore funded status.

#### Remediation
Recalculate `delta_non_conferred` based on the actual non-conferred capital currently attributed to the member, clamped to `pool.total_non_conferred_capital`.

#### Resolution
- In `deposit`, clamped negative non-conferred delta subtractions to `pool.total_non_conferred_capital` via `saturating_sub(neg.min(pool.total_non_conferred_capital))`, completely eliminating `MathOverflow` deposit lockouts.

---

### COMFI-SEC-08: Mid-Cycle Join Governance Exploitation via Instant Funded Status Conferral

- **Severity:** Critical
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L894-L969)

#### Description
Prior to remediation, [`join_pool`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L894-L969) immediately set `member.is_funded = true`, advanced `member.funded_cycle = pool.current_cycle`, incremented `pool.funded_member_count`, and transferred capital into `pool.total_conferred_capital` upon deposit of `args.initial_deposit >= pool.member_obligation_amount`. 

Conversely, existing members depositing via `deposit` mid-cycle had their funds directed to `surplus_amount` and `total_non_conferred_capital`, leaving their funded voting status deferred until `roll_cycle`.

#### Attack Scenario
1. At cycle boundary rollover, existing members who had not prepaid advance surplus become unfunded (`is_funded = false`, `funded_cycle < pool.current_cycle`).
2. Even after existing members deposit their recurring obligation for the new cycle, they remain unfunded throughout the active cycle and are blocked from voting by `is_funded_for_pool`.
3. An attacker joins the pool mid-cycle via `join_pool` with `initial_deposit >= obligation`.
4. `join_pool` immediately conferred `is_funded = true` and incremented `pool.funded_member_count = 1`.
5. Because the attacker was the sole funded member, the required vote threshold (`required_votes_for_pool`) was 1 vote.
6. The attacker submitted and unilaterally passed withdrawal proposals or spender limits in the same cycle, extracting funds contributed by existing members without those members having any ability to vote.

#### Remediation
Ensure consistency across all mid-cycle deposits: joining a pool mid-cycle and depositing initial capital must not confer immediate funded voting status or confer capital for the active cycle. All initial deposits must accumulate as non-conferred surplus (`surplus_amount` and `total_non_conferred_capital`) and only transition to funded voting status at the cycle rollover boundary via `roll_cycle`'s `process_cycle_members`.

#### Resolution
- Updated [`pool_handlers::join_pool`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs#L894-L969) so that `member.is_funded = false`, `member.funded_cycle = 0`, and `pool.funded_member_count` is not incremented.
- Routed all initial deposits into `pool.total_non_conferred_capital` and `member.surplus_amount`, with overfunding checks capping deposits at $2 \times \text{obligation}$.
- On cycle rollover (`roll_cycle`), `process_cycle_members` consumes the member's surplus, transfers it to `total_conferred_capital`, sets `is_funded = true`, sets `funded_cycle = pool.current_cycle`, and updates `funded_member_count` for the new cycle.
- Added unit tests `test_join_pool_status_deferred_to_next_cycle` and `test_join_pool_overfunding_cap_enforced` verifying that mid-cycle joiners have no active cycle voting power and transition to funded status on next cycle roll.

---

### COMFI-SEC-10: Arbitrary Member Omission During Cycle Rollover via Caller-Supplied Accounts

- **Severity:** High
- **Affected File:** [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs), [`programs/comfi/src/deployer.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/deployer.rs)

#### Description
Prior to remediation, [`roll_cycle`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs) delegated member surplus rollover and funded status transition to `process_cycle_members`, which iterated exclusively over caller-supplied `ctx.remaining_accounts`. Because the pool did not track its registered members on-chain, a malicious cranker or caller could:
1. Omit legitimate pool members from `remaining_accounts`, preventing their surplus from converting into conferred capital and leaving them unfunded and unable to vote.
2. Supply only select colluding members, resulting in an artificially depressed `pool.funded_member_count`. This reduced the required vote threshold (`required_votes_for_pool`) for proposals in the new cycle, allowing attackers to seize control of governance.

#### Remediation
Implement an on-chain singly-linked list member registry rather than storing a dynamically growing `Vec<Pubkey>` on the `Pool` account:
1. **State**:
   - `Pool`: Replace `members: Vec<Pubkey>` with `pub head_member: Option<Pubkey>` ($O(1)$ constant space `8 + 426`) and `pub rollover_cursor: Option<Pubkey>`.
   - `Member`: Add `pub next_member: Option<Pubkey>` to the `Member` PDA.
2. **Join Pool ($O(1)$ Prepend)**:
   - `member.next_member = pool.head_member;`
   - `pool.head_member = Some(member.key());`
   - Prepend new member as the head in $O(1)$ constant time; rent is paid naturally by the joining member.
3. **Chunked Pointer-Chain Cycle Rollover**:
   - In `roll_cycle` and `process_cycle_members`, verify the pointer chain: `accounts[i + 1].key() == accounts[i].next_member`.
   - Support chunked rollover across transactions using `pool.rollover_cursor`.
   - Gate pool operations during incomplete rollovers (`pool.ensure_cycle_current_at` blocks if `pool.rollover_cursor.is_some()`).

#### Resolution
- Replaced `members: Vec<Pubkey>` on [`Pool`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs) with `pub head_member: Option<Pubkey>` and `pub rollover_cursor: Option<Pubkey>`, reducing `Pool` to a fixed constant space (`8 + 426`).
- Added `pub next_member: Option<Pubkey>` to [`Member`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs) (`Member::SPACE = 8 + 258`).
- Updated [`programs/comfi/src/deployer.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/deployer.rs) `create_pool` to initialize `pool.head_member = Some(creator_member)` and `creator_member.next_member = None`.
- Updated [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs) `join_pool` to prepend each new member to the head (`member.next_member = pool.head_member; pool.head_member = Some(member.key())`).
- Refactored `process_cycle_members` and `roll_cycle` in [`programs/comfi/src/pool.rs`](file:///c:/Users/sidds/Documents/comfi/programs/comfi/src/pool.rs) to verify the pointer chain across remaining accounts, supporting chunked rollover via `pool.rollover_cursor` and ensuring proposals only resolve when `pool.rollover_cursor.is_none()`.
- Added cycle current gatekeeping in `Pool::ensure_cycle_current_at` requiring `self.rollover_cursor.is_none()`, preventing governance manipulation or fund actions mid-rollover.
- Updated `scripts/crank-keeper.mjs` and `apps/testing/src/backend/localnet.ts` to traverse the member linked list pointer chain starting at `rolloverCursor ?? headMember`.
- Verified pointer chain validation and chunked multi-transaction rollover in unit tests `test_process_cycle_members_verifies_pool_members_list` and `test_chunked_cycle_rollover_with_linked_list`.



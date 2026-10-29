# ComFi and UserAccount backend audit — open issues

Audited 2026-10-29 on **`next-release`**, code baseline **`d7968cc9fc12107e91a5d33c314e83ac69d7dd44`**. The audit claim commit changes only `TASKLIST.md`. This report supersedes the discarded audit of `work`; all retained findings were rechecked against this branch.

Scope: both Anchor programs (`programs/comfi` and `programs/user-account`), their account constraints and authorization, ComFi accounting/governance/member lifecycle, sponsor quotes, account/profile clients, encrypted authenticator storage, wallet signing/confirmation, account-to-pool creation and recovery, and rollover clients.

**Current authority boundary:** UserAccount creation/profile updates are an explicitly localnet-only software-authenticator slice. Ordinary builds reject both operations. The browser checks active UserAccount wallet links before pool setup, but ComFi still authorizes pool operations through wallet-bound Member PDAs. Real WebAuthn, wallet/passkey lifecycle, withdrawal tickets, production cluster/origin policy, and UserAccount-based pool authority are documented follow-up work, not implemented security guarantees. Those deliberate scope limits are not counted as vulnerabilities here.

This tracker contains **open findings only**. Previously resolved entries have been removed. COMFI-SEC-03 and COMFI-SEC-10 are retained with current, narrower reproductions; their previous “Resolved” labels were not sufficient evidence of correctness. This pass records findings and does not change application code. Historical web findings about mandatory mock-wallet deployment/signing have also been removed from `apps/web/ISSUES.md`: browser-wallet localnet setup now exists.

## Findings

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| COMFI-AUD-01 | High | Ending-cycle votes are evaluated against the next cycle's electorate | Native program-helper reproduction |
| COMFI-AUD-02 | High | Rollover loses or retroactively charges shared-spend benefits | Native program-helper reproductions |
| COMFI-AUD-03 | High | Closure payouts depend on claim order and can consume other members' senior reserves | Settlement-formula reproduction |
| COMFI-AUD-04 | High | Eviction can execute after closure and pay an already-refunded member again | Handler/state-transition trace |
| COMFI-SEC-10 | High | Departures break the member registry within and across rollover chunks | Two native program-helper reproductions |
| COMFI-AUD-05 | High | Zero mature voters disables the voting maturation requirement | Eligibility/threshold trace |
| COMFI-AUD-06 | High | Evicting a nonvoter incorrectly reduces the eligible electorate | Native threshold reproduction |
| COMFI-AUD-07 | High | First initializer can seize the singleton global configuration | Account-constraint/initialization trace; deployment-window condition |
| COMFI-AUD-14 | High | Pre-funding a candidate PDA blocks governance admission | Handler trace + local-validator System Program test |
| COMFI-AUD-08 | High | Keeper and console do not correctly crank the current rollover protocol | Executed keeper failure and client-code trace |
| COMFI-SEC-03 | Medium | Cycle-zero creator capital can still be reclassified as non-conferred | Native program-helper reproduction; impact conditions below |
| COMFI-AUD-09 | Medium | Partial creator deposits are omitted from consumable surplus | Native helper reproduction using initialization/deposit accounting |
| COMFI-AUD-10 | Medium | Sponsor service has no working on-chain quote format/signing adapter | Wire-format comparison |
| COMFI-AUD-11 | Medium | Sponsored alias changes bypass inactive-member restrictions | Direct/sponsored handler comparison |
| COMFI-AUD-12 | Medium | Wallet load silently replaces invalid stored key material | Executed wallet/storage reproduction |
| COMFI-AUD-13 | Medium | Wallet reports arbitrary SPL-token balances as USDC | Executed wallet/RPC reproduction |
| UA-AUD-01 | Medium | A disclosed creation ID can be reserved by another authenticator/wallet | Actual UserAccount local-validator reproduction |
| UA-AUD-02 | Medium | Successful pool recovery is blocked by subsequent legitimate Member/Pool changes | Executed recovery-helper reproduction |

### COMFI-AUD-01 — Ending-cycle approvals use the next cycle's voting denominator

**Locations:** [`roll_cycle`](programs/comfi/src/pool.rs#L1830), [`process_cycle_proposals`](programs/comfi/src/pool.rs#L1593), [`required_votes_for_pool`](programs/comfi/src/pool.rs#L1166), [`finalize_proposal`](programs/comfi/src/pool.rs#L2222).

`roll_cycle` increments the cycle, applies pending configuration, and replaces funded/mature-voter counts before resolving proposals for the ending cycle. Proposals retain historical YES/NO totals, but store no electorate snapshot. Manual finalization also uses the live pool counts.

**Reproduction:** Start with five registered members, three funded/mature voters, and an `ApproveWithdrawal` proposal with one YES, zero NO, threshold 5001 bps, and a deadline in the ending cycle. In the next cycle, one old voter remains funded, two old voters stop funding, and two previously unfunded members fund for their first cycle. The new funded quorum is **3/5**, so the pool stays unlocked; the new mature-voter count is **1**. The real helper sequence, including `evaluate_lock_and_auto_close`, changes the proposal from failing (1 YES versus 2 required) to `Executable` (1 required). The historical YES can belong to a member who is no longer eligible. The subsequent timelock delays this incorrect authorization but does not revalidate it.

**Impact:** A minority of the voting electorate can authorize withdrawals; changed cohorts can also invalidate previously sufficient approvals. Proposals spanning several cycles accumulate votes from different cohorts without a consistent denominator.

**Required fix/check:** Define and snapshot the eligible electorate/threshold at the intended voting boundary, bind receipts and multi-cycle eligibility to that policy, and use it in both finalization paths. Add regression tests with changing mature cohorts, satisfied funding quorum, opposing votes, multi-cycle deadlines, and chunked rollovers.

### COMFI-AUD-02 — Benefits are neither settled nor rebased when funded status changes

**Locations:** [`sync_benefit`](programs/comfi/src/pool.rs#L1095), [`process_cycle_members`](programs/comfi/src/pool.rs#L1661), [`roll_cycle`](programs/comfi/src/pool.rs#L1847), [`claim_closure_refund`](programs/comfi/src/pool.rs#L2530).

Rollover overwrites `is_funded`/`funded_cycle` without settling the ending cycle's benefit index. `sync_benefit` decides whether to debit the entire outstanding index using only the member's **current** funded status, and always advances `last_benefit_index`.

**Reproductions against the actual helpers:** (1) A member has 50 units of unsettled benefits while funded in cycle 1. Rollover into cycle 2 without surplus makes them unfunded; the next sync records zero benefit and permanently discards the 50-unit index delta. (2) A previously unfunded member with a stale index becomes funded on rollover; their next sync debits 50 units of shared spending from the period when they were not funded.

**Impact:** Former participants evade closure deductions, while newly funded participants subsidize earlier spending. Leaving members also miss benefits accruing between `leave_pool` and their rollover removal.

**Required fix/check:** Settle against the ending cycle's actual funded cohort before changing the cycle/status; establish a fresh index baseline when funding begins or ends. Preserve fractional accruals. Test funded-to-unfunded, paused, leaving, unfunded-to-funded, and repeated-cycle transitions without intermediate votes/deposits.

### COMFI-AUD-03 — Closure does not reserve outstanding senior claims or normalize junior liabilities

**Locations:** [`spend`](programs/comfi/src/pool.rs#L2469), [`enter_closure`](programs/comfi/src/pool.rs#L918), [`claim_closure_refund`](programs/comfi/src/pool.rs#L2546).

An authorized personal withdrawal can exceed its requester's lifetime conferred contribution. The requester's junior claim then saturates at zero, while other junior claims remain unchanged. Consequently, `total_conferred_capital` (remaining capital after spends) can be smaller than the sum of outstanding nonnegative junior claims. Closure treats that remaining-capital value as the denominator, and caps a junior payout only by the current vault after **that claimant's** senior payout; it does not reserve other members' outstanding senior capital.

**Reproduction using the handler's settlement formulas:** A/B/C each contributed 100 conferred units. An authorized personal withdrawal pays A 150, leaving A's junior claim at zero. D has 100 unconsumed senior units. Closure records vault 250, non-conferred basis 100, conferred basis 150. Claims ordered B/C/D pay **100/100/50**; ordered D/B/C pay **100/100/50** to D/B/C instead. D loses half their protected principal solely by claiming last. No external vault loss or stale benefit index is needed.

**Required fix/check:** Keep aggregate refundable junior liabilities consistent with per-member saturating net claims, or constrain personal withdrawals so that this divergence cannot arise. Always reserve all outstanding senior/escrow liabilities before a junior transfer. Test all claim permutations, personal benefits exceeding contribution, departed members, and senior escrows; verify both equal junior haircuts and senior preservation through actual token transfers.

### COMFI-AUD-04 — Post-closure eviction bypasses refund idempotency

**Locations:** [`execute_evict_member`](programs/comfi/src/pool.rs#L2663), [`ensure_cycle_current`](programs/comfi/src/pool.rs#L892), [`claim_closure_refund`](programs/comfi/src/pool.rs#L2607), [`non_conferred_amount`](programs/comfi/src/pool.rs#L1064).

Unlike other execution handlers, eviction does not call `ensure_not_closing`. Closure clears `is_locked`, and the cycle gate permits operations on closing pools. A closure claim sets `closure_claimed` and clears surplus, but leaves `status == Active` and `total_contributions` unchanged. Eviction checks neither `closure_claimed` nor closure state.

**Trigger:** Have an already-executable eviction for an active, never-funded member with a partial deposit (e.g. 50 units, `funded_cycle == 0`). Execute pool closure, let that member claim their 50-unit senior refund, then execute the eviction. `non_conferred_amount()` returns the same 50-unit lifetime contribution again. Eviction transfers it a second time, or credits a new escrow redeemable through `claim_eviction_refund`. The second payment comes from other members if the vault can cover it.

**Required fix/check:** Reject eviction once closure begins and enforce shared settlement/idempotency across refund paths. Test closure-claim/eviction/escrow permutations, including withheld destination accounts and permissionless execution of previously approved proposals.

### COMFI-SEC-10 — Member departures corrupt or block linked-list rollover

**Locations:** [`process_cycle_members`](programs/comfi/src/pool.rs#L1680), especially [previous-member repair](programs/comfi/src/pool.rs#L1740) and [member serialization](programs/comfi/src/pool.rs#L1800).

The omission checks added previously do not make departure processing correct.

1. **Across chunks:** For `A(active) -> B(leaving) -> C(active)`, process `[A]`, then `[B,C]`. `prev_retained_idx` resets to `None` in the second call. Removing B therefore sets `pool.head_member = C` instead of repairing `A.next_member`. Native execution reproduces an orphaned A, stale `A -> B` link, and `member_count == 2` despite only C being reachable. Future rollover excludes A from funded/voting counts.
2. **Within one chunk:** For `[A(active),B(leaving)]`, serializing A through `&mut *account_info.try_borrow_mut_data()?` advances the `&mut [u8]` stored inside its `AccountInfo` borrow. The later attempt to deserialize A to repair its link reads the remaining tail rather than its discriminator. The native helper returns `AccountDiscriminatorMismatch`; the rollover transaction fails. Several existing tests inspect original backing buffers or manually simulate unlinking, which misses this reuse error.

**Required fix/check:** Persist/validate the retained predecessor across chunk boundaries, distinguish the real head from a chunk head, and serialize through a local slice cursor without advancing the stored account-data view. Test every split of a chain with head/interior/tail and consecutive departures, then run a second complete rollover and compare reachability with member/funded/voting counts.

### COMFI-AUD-05 — A zero-sized mature electorate grants immature members governance rights

**Locations:** [proposal eligibility](programs/comfi/src/pool.rs#L2076), [vote eligibility](programs/comfi/src/pool.rs#L2179), [threshold fallback](programs/comfi/src/pool.rs#L1188).

Both maturation checks are conditional on `pool.voting_member_count > 0`. When the count is zero, all currently funded members can propose/vote immediately, and threshold calculation falls back to `funded_member_count`.

**Trigger:** Existing mature voters stop funding while a sufficient cohort of admitted newcomers funds for its first cycle. For example, two newly funded members in a three-member pool satisfy the default funding quorum but have zero mature voters. Despite `voting_maturation_cycles == 2`, they can vote on queued proposals and create new governance proposals. The founder's explicit initialization exception does not require this general fallback.

**Required fix/check:** Enforce individual maturation regardless of the aggregate count. Keep any bootstrap exception explicit and limited; retain a deliberate recovery/closure path when no eligible electorate remains. Test zero mature voters with a healthy funding quorum, and a sole eligible founder separately.

### COMFI-AUD-06 — Eviction always subtracts a voter even when its target is ineligible

**Locations:** [`required_votes_for_pool`](programs/comfi/src/pool.rs#L1198), [`create_proposal`](programs/comfi/src/pool.rs#L2041), [`vote`](programs/comfi/src/pool.rs#L2157).

The eviction denominator always subtracts one from the mature/funded electorate. The proposal carries only a target key; there is no verified target eligibility snapshot proving that this target was included in the denominator.

**Reproduction:** A healthy three-member pool has two mature funded voters and one unfunded/nonvoting target. With the 6667-bps eviction floor, the real threshold helper requires **one** YES rather than two: it evaluates `ceil((2 - 1) * 6667 / 10000)`. A single eligible voter can remove the third member without the advertised supermajority.

**Required fix/check:** Verify the target account and subtract it only when it belongs to the snapshotted eligible electorate. Reject nonexistent/foreign targets at proposal creation. Test funded mature, funded immature, unfunded, leaving, and invalid targets.

### COMFI-AUD-07 — Singleton global initialization trusts the first arbitrary signer

**Locations:** [`InitializeGlobalConfig`](programs/comfi/src/deployer.rs#L90), [`initialize_global_config`](programs/comfi/src/deployer.rs#L161).

The singleton `["global"]` PDA is initialized by any signer, who becomes its permanent administrator and supplies the mint, treasury, and quote authority. Nothing ties initialization to the intended deployer or program upgrade authority. Later updates correctly require the stored administrator, so an attacker winning initialization cannot be displaced through normal instructions.

**Impact condition:** This is a deployment/bootstrap vulnerability while GlobalConfig is absent, not a claim that an already-initialized deployment has been compromised. An attacker monitoring a fresh deployment can initialize first, choose a counterfeit “USDC” mint and their treasury, and control pool-creation pausing and quote authority. The setup script's fetch-before-initialize is not an authorization boundary.

**Required fix/check:** Authenticate the intended bootstrap authority on-chain, for example against verified program upgrade-authority state or an explicit configured initializer. Test an unauthorized first initializer and the legitimate initializer, and verify deployed global addresses/authorities before accepting user funds.

### COMFI-AUD-14 — Pre-funding a candidate member PDA blocks admission

**Location:** [`execute_admit_member`](programs/comfi/src/pool.rs#L2833).

Admission accepts an empty-data candidate PDA and unconditionally invokes System Program `create_account`. A third party can derive the public candidate address from the admission proposal and transfer enough SOL to make it an existing rent-exempt empty system account before execution. `data_is_empty()` still passes, but ordinary `create_account` rejects a destination with a nonzero lamport balance as already in use. Re-proposing the same wallet derives the same blocked PDA. The program has no recovery/allocation path for it; default gated admission also prevents falling back to direct join.

**Local validation:** On an isolated Solana 3.1.10 validator, pre-funding an empty system account with its 890,880-lamport rent exemption left its data empty, and a subsequent ordinary `create_account` simulation failed with `already in use` (System Program error 0). This verifies the System Program precondition used by the trace; the ComFi admission CPI itself was not deployed/executed.

**Impact:** An outsider can veto a governance-approved admission at low cost without any member vote or signature.

**Required fix/check:** Use initialization that handles pre-funded, empty system-owned PDAs: top up rent, then allocate and assign with PDA seeds, validating owner/data carefully. Test admission with zero balance, a rent-exempt pre-funded balance, an already initialized member, and an invalid owner. Validate the complete admission CPI on a local validator.

### COMFI-AUD-08 — Shipped rollover clients are incompatible with current account fields and chunking

**Locations:** [`processPoolCycleRoll`](scripts/crank-keeper.mjs#L60), [keeper proposal selection](scripts/crank-keeper.mjs#L105), [console production rollover](apps/testing/src/backend/localnet.ts#L688).

The keeper reads `pool.cycleDuration` and `pool.startTime`; current Pool fields are `cycleDurationSeconds` and `cycleStartedAt`. Calling the real exported keeper function with the current account shape throws `Cannot read properties of undefined (reading 'toString')` before any crank. The existing keeper test supplies the obsolete fields, so it passes.

There are additional failures after correcting those names: the next boundary must be `cycleStartedAt + cycleDurationSeconds`, not an original-start formula; a pending rollover cursor needs immediate continuation; the console's production `roll_cycle` passes unsorted `.member.all()` results including departed accounts instead of traversing the pointer chain; both clients submit all accounts in one transaction rather than bounded chunks; and proposal selection compares YES counts directly with basis points such as 5001 instead of calculating the required vote count. Threshold-met proposals are consequently omitted until deadline even when they have passed.

**Impact:** The provided automation cannot maintain current pools. Once a cycle expires, program gates block deposits, spending, voting, joining, and other active operations until someone supplies a correct crank manually.

**Required fix/check:** Share a client implementation for current fields, pointer-chain traversal, bounded chunk submission/resumption, and the actual governance threshold rules. Test real decoded account shapes, at least two cycles, shuffled RPC results, departed accounts, a pool exceeding one transaction's account budget, and early threshold resolution.

### COMFI-SEC-03 — `funded_cycle == 0` still confuses previously conferred capital with unfunded deposits

**Locations:** [`non_conferred_amount`](programs/comfi/src/pool.rs#L1064), [creator initialization](programs/comfi/src/deployer.rs#L195), [`process_cycle_members`](programs/comfi/src/pool.rs#L1793), [`leave_pool`](programs/comfi/src/pool.rs#L2629).

The former ghost-unfunded finding is narrower but not fully resolved. A creator funded at cycle 0 also has `funded_cycle == 0`. After their first unfunded/paused rollover, `non_conferred_amount()` returns **all lifetime contributions**, including capital already conferred in cycle 0; this is the same sentinel used for never-funded members.

**Native reproduction:** Initialize a cycle-zero creator with 100 conferred units and no surplus, then process the first unfunded rollover. The member reports a 100-unit senior claim while `pool.total_non_conferred_capital == 0`. Both leave and closure use this classification, and senior refunds do not deduct prior benefits.

**Impact qualification:** Current default gated admission and cycle delays constrain obtaining other members' deposits before that first rollover; this reproduction alone does not establish an unconditional drain of a default multi-member pool. It does establish inconsistent senior accounting, possible refund lockout after fees/spending, and an over-prioritized claim in pools whose admission/history permits other capital to be present.

**Required fix/check:** Track actual never-conferred principal explicitly; do not infer it from funded status or a valid cycle number. Test the cycle-zero creator after funding loss, pause, sponsored charges, deposits, leave, eviction, and closure.

### COMFI-AUD-09 — Below-obligation creator deposits disappear from usable surplus

**Locations:** [`create_pool`](programs/comfi/src/deployer.rs#L195), [creator member fields](programs/comfi/src/deployer.rs#L310), [`deposit`](programs/comfi/src/pool.rs#L1441), [rollover funding](programs/comfi/src/pool.rs#L1765).

The below-obligation creation branch records the initial deposit as pool non-conferred capital but initializes member surplus to zero. Subsequent deposits add only new amounts to surplus, while rollover funds members exclusively from surplus.

**Reproduction:** With obligation 100 and a minimum permitting an initial deposit of 40, create the pool and deposit another 60. Lifetime deposited/contribution totals are 100, and the pool reserves 100, but usable surplus is only 60. The native rollover helper leaves the creator unfunded. They must supply an extra 40 to become funded, and the original 40 remains outside normal surplus accounting.

**Required fix/check:** Initialize the unfunded creator's surplus with the entire initial deposit, consistently with admitted/direct-join deposits. Test partial initial deposits plus exact top-ups through actual handlers and reconcile aggregate non-conferred capital after rollover and closure.

### COMFI-AUD-10 — Sponsor quotes cannot currently be consumed by the program

**Locations:** [`SponsorQuoteService.sign`](services/sponsor-api/src/service.ts#L105), [`canonicalQuote`](services/sponsor-api/src/canonical.ts#L15), [`SponsorQuote`](programs/comfi/src/pool.rs#L1300), [`verify_preceding_ed25519_quote`](programs/comfi/src/pool.rs#L95).

The service signs sorted JSON strings and ships only an HMAC signer. The program verifies an Ed25519 instruction over Borsh `SponsorQuote` bytes. The schemas also disagree: UUID/string IDs versus `[u8;32]`, ISO expiry versus Unix seconds, string action versus enum, and extra service fields. A simple switch from HMAC to signing the same JSON with Ed25519 still fails the program's byte-for-byte check. There is no production adapter or transaction-level integration test in this checkout. The service README acknowledges this outstanding gap.

Separately, the advertised `actionDigest` and program binding are absent from the on-chain quote, so the verifier cannot enforce the advertised binding to alias/encryption arguments and program domain after an adapter is added.

**Required fix/check:** Define a shared, versioned signing payload with action-argument/domain binding, canonical binary encoding, Ed25519 signing, explicit ID/expiry conversion, and transaction construction. Test one API-issued quote through the real instruction, plus altered arguments, wrong authority/program, expiry, and replay rejection. Keep enrollment/capacity quotes documented as unsupported until corresponding program instructions exist.

### COMFI-AUD-11 — Sponsored alias changes remain available to departed members

**Locations:** [`set_alias`](programs/comfi/src/pool.rs#L1465), [`run_sponsored_set_alias`](programs/comfi/src/pool.rs#L1494), [`RunSponsoredSetAlias`](programs/comfi/src/pool.rs#L242).

The direct alias handler requires `MemberStatus::Active`. Its sponsored equivalent checks quote signature, member/pool binding, expiry, and allowance, but never checks member status. Member PDAs survive departure/eviction, so a Leaving/Exited/Evicted wallet can still mutate its alias and charge pool conferred funds using a valid unused quote. An off-chain policy check does not revoke a quote issued immediately before the status change. This path requires a valid Ed25519 quote; it is not a signature bypass.

**Required fix/check:** Apply the same active-member restriction in both account/handler paths and explicitly define funded eligibility for pool-paid actions. Test a valid quote issued before leave/eviction and submitted afterward; assert no alias, receipt, allowance, or vault mutation on rejection.

### COMFI-AUD-12 — Invalid persisted wallet data is overwritten instead of preserved for recovery

**Location:** [`getOrCreateInBrowserKeypair`](apps/web/src/in-browser-wallet.ts#L193).

If stored key import throws for any reason, loading the wallet silently generates another key and writes over the same storage slot. Startup neither surfaces an error nor retains the original bytes. A format/decoder regression can therefore replace an existing funded wallet's only locally stored recovery material and present the user with a different identity.

**Executed reproduction:** Supply storage whose existing value fails import and count writes. A call to `getOrCreateInBrowserKeypair` completes successfully and performs one write replacing the existing value.

**Required fix/check:** Generate only when no key exists. Preserve invalid material, fail visibly, and require an explicit recovery/replacement action. Test malformed/legacy values and decoder failure with zero storage writes; keep valid-key and missing-key cases separate.

### COMFI-AUD-13 — The displayed USDC balance sums all SPL mints

**Locations:** [`refreshBalances`](apps/web/src/wallet.tsx#L224), [`fetchUsdcBalance`](apps/web/src/in-browser-wallet.ts#L258).

`refreshBalances` omits the optional mint argument. The helper consequently queries every account owned by the SPL Token program, sums token UI amounts across unrelated mints/decimals, and formats the result as dollars. A wallet with no USDC can appear to hold USDC simply by receiving another token.

**Executed reproduction:** Mock a successful token-account response containing 999 units of an unrelated SPL token. The actual helper sends a program-wide filter and returns `$999.00`.

**Required fix/check:** Resolve and require the configured cluster's USDC mint, filter by that mint, and sum its atomic units using its validated decimals. Test mixed mints, multiple USDC accounts, no USDC, and malformed RPC responses.

### UA-AUD-01 — Bootstrap identifiers are not bound to their intended initial authority

**Locations:** [`CreateUser`](programs/user-account/src/lib.rs#L199), [`creation_payload`](programs/user-account/src/lib.rs#L293), [persist-before-submit/retry](apps/web/src/UserAccountPanel.tsx#L49), [`fetchUserAccount`](apps/web/src/user-account.ts#L164).

The UserAccount PDA is derived only from a caller-selected `user_id`. The wallet and authenticator must authorize the contents of their own request, but there is no ownership proof for the identifier itself. A different wallet/authenticator can submit an independently valid bootstrap using the same disclosed ID before the intended creation is included.

**Actual local-validator reproduction:** Prepare a victim credential and bootstrap transaction, then generate another credential with the same `userId` and a different P-256 key/wallet. Both requests derive the same UserAccount but different links. Submit the second request first: it succeeds, sets sequence 1, and links the second wallet/key. The original creation then fails because the UserAccount is already initialized; the victim client's readback fails because its wallet/passkey links are missing. No victim wallet or authenticator signature was used by the second request. The UI persists the original encrypted credential before submission and offers retries using that same ID, so ordinary retry/load cannot recover from the collision.

**Impact/conditions:** This is a targeted denial of signup/recovery once a pending creation ID becomes observable (for example to the submitting RPC or transaction processor). It is **not** a takeover of an already-created identity or a claim of a production passkey exploit; current account operations are test-build-only. Random 256-bit IDs prevent blind guessing, but do not prevent this disclosed-ID race.

**Required fix/check:** Bind initial identifier allocation to an authenticated immutable creation authority/commitment while keeping later wallet rotations independent of that immutable seed. Provide an explicit, safe conflict recovery path that preserves existing encrypted material. Test two independently signed requests for the same disclosed ID and verify the intended authority cannot be displaced by transaction ordering.

### UA-AUD-02 — Recovery verifies mutable live state as though it were the original creation receipt

**Locations:** [`checkPoolSetup`](apps/web/src/pool-setup.ts#L121), [`verifyPoolSetup`](apps/web/src/pool-setup.ts#L107), [pending deployment UI](apps/web/src/PoolAccountSetup.tsx#L42).

A saved deployment with a confirmed successful signature is reconciled by comparing the current Member deposit total/status and current Pool configuration with the original form. These fields can legitimately change after creation. There is no historical transaction verification or reconciliation path distinguishing a valid subsequent change from a failed/mismatched deployment.

**Executed reproduction against the actual helper:** A matching confirmed setup first returns `verified`. Increase the Member's `deposited_total` by one legitimate deposit, leaving creator, pool, wallet link, ownership, and signature unchanged. Checking the same successful receipt now throws `Pool or Member state does not match the approved setup`. The same happens after valid governance configuration changes or a later departure. This matters after an uncertain confirmation/reload while the pool is used through another client.

**Impact:** `PoolAccountSetup` retains the pending record on this error and disables new form input. Every retry re-enters the same failing verification; neither successful recovery nor a deliberate new deployment is available through the form.

**Required fix/check:** Reconcile the recorded successful transaction and its immutable creation identity/arguments separately from current mutable state. Continue to reject substituted accounts and preserve genuinely pending receipts. Test successful creation followed by deposit, governance modification, pause/exit, reload, and recovery, plus a conflicting creator taking the same pool ID.

## Verification and limits

- Baseline: `next-release` at `d7968cc9fc12107e91a5d33c314e83ac69d7dd44`; native probes compile against this checkout's programs and locked dependency versions. The discarded `work` audit commit was removed from local and remote `work` before this review.
- `npm test`: **129 passed** (5 standalone UserAccount client + 9 console + 111 web + 4 sponsor), with no failed/skipped tests. The console now validates arguments without loading an IDL first; the missing-IDL test failure from the discarded branch audit does not apply here.
- `npm run typecheck`: **passed** across all workspaces.
- `cargo test --locked`: **108 passed** (102 ComFi, 6 UserAccount), no failures/ignored tests. Existing Anchor macro-configuration and unused-variable warnings remain.
- Eight additional native probes against the actual ComFi helpers confirmed the two registry failures, both benefit-transition errors, changed-electorate approval with a healthy funded quorum, wrong eviction threshold, cycle-zero reclassification, and partial-creator funding gap. The probes assert observed defects, not successful fixes. They do not execute token-transfer handlers or replace validator integration tests.
- JavaScript probes executed current keeper, maturity eligibility, wallet storage/balance, and pending-deployment recovery code. A separate settlement-formula model demonstrated claim-order dependence; that formula model is not itself a token-transfer test.
- `npm run user-account:test-workflow`: **passed** on an isolated Solana 3.1.10 validator after Anchor 1.1.2 build/deploy. It verified sponsored bootstrap and browser-client profile updates, **17 rejected bootstrap cases** and **9 rejected profile cases**, including invalid signatures, substituted wallet/payer/arguments, missing proofs/signatures, expiry, sequence, and replay. No signature or sequence bypass was found in this supported mock policy.
- Additional local-validator probes executed the creation-ID race in UA-AUD-01 and the System Program pre-funding rejection used in COMFI-AUD-14. The latter validates the System Program precondition, not the full ComFi admission CPI.
- `npm run test:e2e:pool-setup`: **passed**. Both programs built/deployed; the real browser flow created an account, funded its selected wallet, deployed a pool, verified payments, recovered membership after reload, and checked wallet switching. The runner also passed its account/profile negative cases and ordinary ComFi proposal/voting, two real cycle rolls, spender-limit execution, and three rejection/rollback checks.
- Web production build: **passed**, with existing bundle-size/dynamic-import warnings.
- `npm run user-account:test-production`: **passed**. The ordinary UserAccount binary built/deployed and rejected bootstrap with `LocalnetOnly`; all three prospective accounts remained absent. Both handlers also contain the explicit compile-feature gate.
- Independent read-only report review: **APPROVED**. The reviewer independently passed all 129 Node tests and type checks, reran all eight native probes and the JavaScript probes, and checked source/evidence consistency. Approval covers this documentation, not remediation of the open vulnerabilities.
- Current maximum serialized account sizes: Pool **542**, Member **333**, UserAccount **102**, WalletLink **74**, PasskeyLink **107** bytes. No allocation-size defect is claimed.
- No Devnet/Mainnet transaction/deployment or external notification was performed. Production deployments, live authorities, migrations, real WebAuthn ceremonies, and future authority lifecycle/withdrawal-ticket code are outside this verification. All validator tests use temporary local test funds/signers.

# ComFi Task List: Governance Upgrades, Testing App, Web App, Wallet, Invites, and AI Copilot

## 1. Pool Governance Upgrades & Testing App Integration (`apps/testing`)
- [x] Update `types.ts` in `@comfi/testing` to reflect new pool state (`isClosing`, `isLocked`, `admissionMode`, `fundedMemberCount`, `votingMemberCount`, `minQuorumMembers`, `minQuorumBps`, `autoCloseCyclesThreshold`, `totalConferredCapital`, `totalNonConferredCapital`, `totalEscrowedSurplus`), member state (`status`, `surplusAmount`, `claimableSurplusEscrow`, `lineageDepth`, `vouchedBy`, `isMaturedVoter`), and proposal actions (`ClosePool`, `EvictMember`, `AdmitMember`).
- [x] Expand `getSystemStatus()` in `apps/testing/src/backend/localnet.ts` to decode updated Pool, Member, and Proposal accounts with complete governance fields.
- [x] Implement new proposal creation variants in `executeAction('create_proposal')`:
  - [x] `ClosePool` proposal creation
  - [x] `EvictMember` proposal creation (with target member PDA)
  - [x] `AdmitMember` proposal creation (with candidate wallet and inviter member vouch)
- [x] Implement new proposal execution and member lifecycle actions in `executeAction()`:
  - [x] `execute_close_pool` (initiates pool closure, snapshots vault and capital)
  - [x] `execute_evict_member` (unlinks member from list, refunds or escrows surplus)
  - [x] `execute_admit_member` (allocates and initializes candidate Member account via SystemProgram CPI)
  - [x] `claim_closure_refund` (claims member's pro-rata surplus after pool closure)
  - [x] `claim_eviction_refund` (claims escrowed surplus for evicted members)
  - [x] `leave_pool` (stages departure or exits immediately if unfunded)
  - [x] `set_paused` (toggles member rollover pause flag)
- [x] Add unit tests in `apps/testing/test/api.test.ts` for all new governance actions, parameter validation, and escalation on invalid arguments.
- [x] Update testing UI (`apps/testing/src/App.tsx`) with controls for creating, voting on, and executing eviction, admission, and closure proposals.

## 2. Multi-Network Browser Wallet Integration (`apps/web`)
- [ ] Research and integrate browser wallet support for localnet (`http://127.0.0.1:8899`), devnet, and testnet:
  - [x] [Completed: Codex-Phantom] Support Phantom wallet (`window.solana`) with network switching guidance (Settings -> Developer Settings -> Change Network).
  - [ ] [Claimed: Subagent-Backpack-Wallet | Deadline: 2026-10-01T22:00:00Z] Support Backpack wallet (`window.backpack`) with native custom RPC configuration.
  - [x] [Completed: Subagent-Web-Wallet] Implement built-in ComFi In-Browser Web Wallet (persistent browser keypair with 1-click generation, import/export, address copy, SOL/USDC balance display, and localnet/devnet airdrop faucet).
- [ ] Add interactive network switcher in the web app navbar (`Localnet`, `Devnet`, `Testnet`) with connection health indicator and dynamic RPC configuration.
- [ ] Enable wallet provider selector allowing seamless toggle between In-Browser Web Wallet, Phantom, and Backpack.

## 3. Comprehensive Pool Understanding Web App (`apps/web`)
- [ ] Enhance on-chain decoding in `apps/web/src/solana.ts` for complete pool metrics:
  - [ ] Decode financial accounting: vault balance, total conferred capital, total non-conferred capital, surplus, escrowed surplus.
  - [ ] Decode quorum health: participation rates, lock status (`isLocked`), consecutive locked cycles, auto-close thresholds, and warning alerts.
  - [ ] Decode admission mode (`InviteVouched` vs `Open`) and voting maturation cycle rules.
- [ ] Implement Comprehensive Governance & Proposals View:
  - [ ] Proposals list with real-time lifecycle status badges (`Queued`, `Open`, `Executable`, `Executed`, `Rejected`).
  - [ ] Support all 6 proposal types: `SetSpenderLimit`, `ApproveWithdrawal`, `ConfigurationModification`, `ClosePool`, `EvictMember`, `AdmitMember`.
  - [ ] Interactive Voting modal with voting power breakdown (funded status, streak, voter maturation).
  - [ ] 1-Click Proposal Execution for eligible proposals meeting threshold or deadline requirements.
  - [ ] "Create Proposal" dialog supporting all proposal types.
- [ ] Implement Membership & History View:
  - [ ] Member directory showing roles, status (`Active`, `Leaving`, `Exited`, `Evicted`), streak, funded status, and pause status.
  - [ ] Vouch lineage visualizer showing invitation depth and vouched-by chain.
  - [ ] Member actions: Leave Pool, Claim Closure Refund, Claim Eviction Refund, Pause/Unpause Rollover.
  - [ ] Member audit history log tracking deposits, votes, and submitted proposals.
- [ ] Implement Spends & Treasury View:
  - [ ] Active cycle limits and spender authorizations.
  - [ ] Pending withdrawal requests with justification and recipient details.
  - [ ] Historical spend distributions and direct member benefit attribution.

## 4. Member Invitation & Webhook-Like Onboarding Pipeline (`apps/web`)
- [ ] Implement "Create Pool" modal with admission mode selection (`InviteVouched` or `Open`), member obligation, cycle duration, and quorum parameters.
- [ ] Implement "Invite Members" workflow:
  - [ ] Generate invitation payload and sharable link/email message containing pool address and inviter identity.
  - [ ] Provide recipient acceptance view where the invitee connects their wallet or submits their wallet address.
  - [ ] Implement automated webhook-style listener that detects the recipient's wallet submission and dispatches an `AdmitMember` governance proposal on behalf of the inviter.
  - [ ] Notification and tracking card showing pending invite approvals and admission execution status.

## 5. Browser-Based Delegated AI Pool Assistant (ComFi Copilot) (`apps/web`)
- [ ] Design and implement an in-browser AI Assistant panel for autonomous and delegated pool management.
- [ ] Provide user-configurable risk & autonomy settings:
  - [ ] **Tier 1: Advisory Mode (Low Risk / Zero Autonomy)** - Proactively monitors pool metrics, flags quorum drops, highlights executable proposals, and recommends votes without executing transactions.
  - [ ] **Tier 2: Supervised Automation (Medium Risk / Semi-Autonomous)** - Auto-votes on recurring routine proposals matching user rules, auto-rolls overdue cycles, prompts for approval on large spends, evictions, or config modifications.
  - [ ] **Tier 3: Autonomous Delegation (High Risk / Full Autonomy)** - Automatically cranks cycle rolls, executes passed proposals, and auto-vouches verified invited candidate addresses via the webhook pipeline.
- [ ] Add granular capability toggles:
  - [ ] Auto-roll cycle when deadline passes
  - [ ] Auto-execute passed proposals
  - [ ] Auto-vouch invited candidates from webhook responses
  - [ ] Auto-vote YES on vouched candidates in user's lineage
  - [ ] Auto-claim surplus or refund upon pool closure
- [ ] Real-time AI decision and audit log showing rationale, confidence score, and timestamped actions.
- [ ] Interactive conversational interface allowing natural language queries ("What is our quorum status?", "Are there pending proposals to vote on?", "Execute passed proposals").

## 6. Verification & End-to-End Testing
- [ ] Run full workspace unit tests (`npm test`) ensuring all test suites pass without evading failure scenarios.
- [ ] Run typechecks (`npm run typecheck`) across `@comfi/web`, `@comfi/testing`, and `@comfi/sponsor-api`.
- [x] [Completed: Codex-Localnet] Verify localnet compatibility and document instructions for running localnet tests and browser wallet setup.

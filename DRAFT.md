# ComFi Architecture Draft

## Recommended V1 direction

Use **Solana Mainnet** as ComFi's settlement chain and use only Circle-issued,
native **USDC on Solana** for pooled funds. The product should present this as a
"ComFi USDC account," not as a crypto wallet.

Solana is a good fit for ComFi's expected pattern of frequent, small deposits,
votes, and controlled payments. New members do not need to acquire or
understand SOL during the bounded enrollment flow that ComFi sponsors. Each pool
prepays a USDC enrollment fee to the ComFi treasury at deployment, so this
sponsorship is funded by the pool rather than treated as an open-ended free
service. Routine member actions use a separately metered, configurable pool
action allowance, so members do not need to manage SOL for proposals, votes,
withdrawal requests, spending, or alias updates.

## User onboarding

1. A user signs in with email, passkey, or a social provider through Privy.
2. Privy automatically provisions an embedded, self-custodial Solana wallet.
3. The app displays a USDC balance and pool activity; it does not expose wallet
   terminology in the ordinary flow.
4. On the user's first real action (funding or joining a pool), create their
   native-USDC associated token account if it does not already exist.
5. Require a durable recovery method (passkey or verified email) before a
   meaningful deposit. Offer private-key export / external-wallet connection in
   advanced settings only.

Privy can provide login and the identity-to-wallet mapping, so ComFi does not
need a traditional user database merely to support authentication.

## Solana account model

These are separate objects and should be created progressively:

| Object | Created when | Purpose |
| --- | --- | --- |
| ComFi profile | Sign-up | Private display data and notification preferences, if needed |
| Solana wallet | Sign-up | User signing identity |
| USDC associated token account (ATA) | First USDC use | Holds the user's native USDC |
| Pool / member program accounts | Create or join pool | Enforce pool rules and membership |

Do not create a USDC ATA for every visitor. Create it when a user deposits,
receives USDC, or joins a pool. Its one-time SOL rent cost is sponsored only as
part of a real, allowlisted pool-enrollment action.

## Account-creation funding policy

Solana separates the **transaction fee** and **rent deposit** needed to create
an account. Both require SOL, so the ComFi app is the actual SOL sponsor. Pools
fund their expected new-member enrollment cost in USDC when they are deployed.

### Pool enrollment fee

`ComFiDeployer.create_pool` requires an initial `member_cap` and a USDC
`enrollment_fee`. The deployer transfers this initial fee directly to the
ComFi treasury's USDC account; it never comes from the new pool's spendable
USDC vault. The fee schedule should be published before the creator confirms
deployment:

```text
enrollment_fee = base_pool_setup_fee
               + member_cap * per_member_enrollment_allowance
               + safety_margin
```

The per-member allowance covers the expected ATA rent, member-account rent, and
the sponsored network transactions required for a first-time member to join.
ComFi periodically converts or rebalances this treasury revenue into SOL for
the sponsor wallet. ComFi must bootstrap the initial SOL float before the first
pool fee is collected. This enrollment fee does not fund unlimited future pool
transactions. Routine member actions are funded separately through bounded
action charges from the pool vault.

Record `member_cap` and `sponsored_enrollment_slots` in the Pool PDA. The
sponsor endpoint grants free first-time enrollment only when the onchain pool
has a remaining slot and the user is executing a valid `join_pool` transaction.
The program increments membership atomically; the sponsor then reconciles its
allowance against onchain membership events.

### Raising the member cap by proposal

A pool can raise, but never silently bypass, its member cap through a dedicated
`increase_member_cap` proposal. The proposal includes:

- The requested `new_member_cap`, which must be greater than the current cap.
- The number of additional sponsored enrollment slots.
- A ComFi-signed, expiring quote for the incremental USDC enrollment fee.
- The ComFi treasury USDC destination.

After the normal vote threshold and timelock are met, anyone may call
`execute_member_cap_increase`. The program verifies the approved proposal and
quote, transfers the quoted incremental fee from the pool USDC vault to the
ComFi treasury, then atomically updates `member_cap` and
`sponsored_enrollment_slots`. This is an explicit, visible governance expense,
not a spender's discretionary withdrawal.

If the quote has expired before the proposal passes, the increase cannot be
executed. The community must obtain a new quote and approve it, preventing a
stale proposal from charging an unexpected fee. The sponsor must not issue new
enrollment subsidies until the onchain cap increase is finalized.

Only sponsor an ATA as part of an atomic, valid join transaction that also
includes a minimum USDC deposit or an approved invitation. Record that the
member has consumed the pool's enrollment subsidy. The ATA belongs to the user,
who can eventually close an empty ATA and recover its rent, so the subsidy is a
deliberate, capped user-acquisition expense.

### Member action allowance

Each pool configures a default `action_allowance_usdc_per_cycle` for members
and a maximum USDC sponsorship charge for each permitted action type. This is a
small, separate limit used only to pay ComFi for sponsoring permitted Solana
actions; it is not a withdrawal or personal spend limit. The creator sets the
initial defaults, and the community can change the defaults or a single
member's override through a normal governance proposal.

Each `Member` PDA tracks the action allowance used in the current cycle. The
central sponsor supplies a signed, short-lived quote for the exact action kind
and USDC charge. The Pool program accepts it only when the quote names the
correct pool, member, and ComFi treasury; is unexpired; and fits within that
member's remaining action allowance and the pool's maximum charge for that
action type.

For a sponsored action, the user and sponsor sign one atomic transaction. A
typed Pool instruction validates the user action, increments the member's
action-allowance usage, transfers the quoted USDC charge from the pool vault to
the ComFi treasury, and performs the action. The sponsor pays the SOL fee.
If any check or the action itself fails, the USDC charge does not transfer.
The sponsorship charge is accounted separately and never consumes an authorized
spender's ordinary withdrawal limit.

This lets the ComFi service bootstrap and replenish its SOL float from real
pool revenue while preventing it from collecting arbitrary fees or accessing
pool USDC outside an approved, capped member action.

### Advanced pool creation

For a creator-owned pool, expose an **Advanced pool creation** flow. The
creator connects an external Solana wallet containing SOL (for example,
Phantom) as the transaction/setup payer. The creator's ComFi wallet authorizes
the USDC enrollment-fee transfer. These can be the same wallet for an advanced
user, or two signer roles in the same transaction. The SOL payer explicitly
pays for:

1. The deployment transaction and pool-program account creation.
2. The pool USDC vault ATA and required program-account rent.
3. The published USDC enrollment fee sent to the ComFi treasury.

Connecting a creator's SOL wallet funds setup only; it gives that wallet no
special ability to withdraw pool USDC. Pool governance and the ComFi program
remain the authority over pooled funds.

If the pool uses private aliases, the creator's client also initializes the
first encrypted profile group and registers the creator's encryption public
key. This is metadata setup only and does not affect the pool vault or
governance authority.

## Onchain design

Build one Anchor/Rust Solana program with two logical onchain objects. Solana
does not deploy separate contract code per pool; the single program creates
isolated PDA-owned pool instances.

### `ComFiDeployer`

`ComFiDeployer` is the global factory / registry PDA. It contains only
application-wide configuration:

- The pinned official native-USDC mint.
- The ComFi treasury USDC account.
- The enrollment-quote signing authority and fee-schedule version.
- The program's approved sponsor identity, if this is verified onchain.
- The next pool identifier and pool-creation event schema.

Its responsibilities and methods are deliberately narrow:

| `ComFiDeployer` method | Responsibility |
| --- | --- |
| `create_pool` | Validate the creator's initial enrollment fee, send it to treasury, create the pool PDAs and register the pool. |
| `update_global_config` | Governance-controlled update of treasury, quote authority, or fee-schedule metadata. It must not change an existing pool's rules. |
| `pause_new_pool_creation` | Emergency stop for new deployments only. It must not freeze existing pool funds. |

The deployer must have **no method or signing authority** that can transfer an
existing pool's USDC or alter its membership, spending, or vote outcomes after
creation.

### `Pool`

Every pool is an isolated set of accounts derived from its pool identifier:

- A `Pool` PDA for its configuration, governance rules, member cap, and
  sponsored-enrollment allocation, action-allowance defaults, and per-action
  sponsorship-charge caps.
- A native-USDC ATA owned by the `Pool` PDA as the pool vault.
- A `Member` PDA per user and pool for eligibility, funded-member status, an
  alias-ciphertext reference, alias version, public encryption key, and
  per-cycle action-allowance usage. It never stores a readable alias.
- A `SpenderCycle` PDA per approved spender and funding cycle for the current
  spend amount and cap.
- `Proposal` and vote-receipt PDAs for governance.

Pool methods own all community behavior:

| `Pool` method | Responsibility |
| --- | --- |
| `deposit` | Move a member's native USDC into the pool vault and record funding state. |
| `join_pool` | Create member state, record an encrypted alias reference, and add an eligible member subject to the member cap. |
| `set_alias` | Let a member replace their own encrypted per-pool alias reference. It consumes the member's action allowance when sponsored. |
| `create_proposal` | Create a proposal, including spend-limit, action-allowance, role, and member-cap changes. |
| `request_withdrawal` | Record a typed USDC withdrawal request with amount, recipient, and justification hash. |
| `vote` | Record an eligible member's vote. |
| `finalize_proposal` | Apply a passed ordinary governance change after its timelock. |
| `execute_member_cap_increase` | Validate a passed capacity proposal and quote, pay the incremental USDC enrollment fee to treasury, and increase sponsored slots. |
| `spend` | Verify an executable withdrawal request, authorization, cycle limit, and justification hash before transferring USDC from the pool vault. |
| `run_sponsored_action` | Atomically validate a ComFi quote, charge the bounded member action allowance, pay the treasury, and execute a permitted typed action. |

`spend` validates the linked withdrawal request, caller's role, current funding
cycle, approved limit, and justification hash before using the Pool PDA to
transfer USDC from the vault. Do not give authorized spenders a general token
allowance.

Store minimal financial facts and hashes onchain: amount, participants,
timestamp, proposal identifier, and a hash of the justification. Keep receipt
images and explanation text encrypted offchain, with their integrity hash
anchored onchain. A public chain cannot make raw metadata visible only to pool
members.

## Frontend experience

The frontend is the user's ComFi workspace. It uses Privy for sign-in and the
embedded wallet, and reads authoritative pool state and transaction history
from Solana (normally through an indexer for speed). It must never hold a
user's private key or bypass Pool rules.

### Enrollment and private aliases

The enrollment flow lets a signed-in user open a pool invitation or public
enrollment link, review the pool's rules, and join it.

- Show the required first contribution, funding cycle, membership requirements,
  and available sponsored-enrollment slot before the user signs.
- Require the user to select a per-pool alias before joining. The frontend
  encrypts it on the user's device; it must never submit readable alias text to
  Solana or the ComFi service. Before the user has the pool group key, the
  client seals this initial alias separately to every current member's registered
  encryption public key and to the new member's own key.
- Create the user's native-USDC ATA and `Member` PDA only when they confirm a
  valid join transaction. `join_pool` stores only an encrypted alias reference,
  the alias version, and the user's encryption public key in the `Member` PDA.
- Submit the user-signed transaction to the ComFi sponsor when the pool has a
  sponsored-enrollment slot; otherwise clearly request an advanced SOL-wallet
  payment flow.
- Show a confirmed enrollment receipt and take the user directly to the pool.

### My Pools

The home screen lists every pool associated with the signed-in user's wallet.
For each pool, show the member's role and funding status, their current
authorized spend limit and remaining cycle amount, pool balance, upcoming
funding date, open proposal count, and pending withdrawal-request count.

Selecting a pool opens a transparent activity view with:

- Member and role roster.
- Deposits, withdrawals, and justification/receipt links.
- Current rules, member cap, current membership, and remaining sponsored slots.
- Open, passed, rejected, and executed proposals.
- The user's pending requests and voting history.

Every member, proposal, and activity entry uses the member's current per-pool
alias as its human-readable label, with a shortened wallet address and an
explorer link available for verification. Outside the pool, observers see only
wallet addresses, public onchain rules, and opaque encrypted profile
references.

The app keeps the alias directory in end-to-end encrypted group storage. Each
member registers a client-side encryption public key on join. The initial alias
envelope lets current members read the joining member's chosen alias without
giving ComFi the plaintext. An authorized existing member then issues an
encrypted group welcome/key package to the new member. Once processed, clients
use the pool group key for the encrypted alias directory and later alias
updates. ComFi stores and delivers ciphertext packages but cannot decrypt
aliases. Membership additions and removals rotate the group key. A newly
enrolled member can inspect public onchain activity immediately; private roster
labels become available once an authorized participant's welcome package is
processed.

A member may change only their own alias by encrypting a new profile version on
their device and calling `Pool.set_alias` with its ciphertext reference. The
frontend obtains a sponsored-action quote and submits this selector through the
ComFi sponsor. The small USDC charge counts against the member's pool action
allowance rather than requiring the member to acquire SOL. Activity history
joins events through the stable Member PDA and renders the current alias; it
does not need to retain previous aliases after a rename.

Private aliases cannot have onchain uniqueness enforcement: Solana cannot
compare encrypted names. The frontend may warn about duplicates and always
disambiguates a duplicate alias with a shortened wallet address. A former
member cannot decrypt alias updates encrypted after removal, but cannot be
forced to forget aliases they already saw.

### Proposals and voting

Eligible members can create proposals from the pool page. The proposal form
offers typed actions rather than arbitrary transaction data: adjust a spender's
limit, add or remove a role, change a funding rule, or increase the member cap.
For a member-cap increase, show the requested increase, ComFi's signed fee
quote, expiry, and treasury destination before it is submitted.

Members can inspect the proposal's exact onchain effect, vote, and see the
threshold, deadline, and timelock. The frontend enables execution only once
the Pool program reports that the proposal has passed and is executable. Each
member action shows its quoted USDC sponsorship charge and the member's
remaining action allowance before the user signs; the user never needs to
acquire SOL for these actions.

### Withdrawal requests

The frontend provides a dedicated withdrawal-request form for an authorized
spender: recipient, USDC amount, purpose, and optional encrypted receipt or
justification. It calls `Pool.request_withdrawal`; the program records the
request and its justification hash before any funds move.

The UI then follows the request's status:

- **Within a current approved spend limit:** the spender can submit `Pool.spend`
  after reviewing the final amount and recipient.
- **Outside the limit or requiring community approval:** the request becomes a
  typed proposal and follows the normal vote and timelock process.
- **Approved and executable:** any eligible caller can submit the final
  `Pool.spend` transaction; the program rechecks the request, cap, and status.

The frontend never makes a direct SPL-token transfer from a pool vault. Every
withdrawal must pass through the Pool program and produce a visible history
entry.

## Minimal ComFi service

The app can be mostly client + Privy + Solana. A minimal server-side service is
still needed for a normie-friendly fee experience and is funded by enrollment
fees plus bounded, onchain action charges from pools.

The service is a **SOL fee sponsor**, not a custodian:

1. The client builds a transaction for a permitted ComFi program instruction.
2. The user signs it with their Privy wallet.
3. The client sends it to a sponsor endpoint.
4. The endpoint authenticates the request, verifies the exact program,
   instruction, accounts, and cost policy, then co-signs as the SOL fee payer.
5. The transaction is sent to Solana.

The sponsor's key pays SOL fees only. It must not be able to move user or pool
USDC outside the onchain program rules. Never expose its key to the client.

Use the sponsor service to enforce per-user and per-action limits, simulate
transactions before sponsoring them, and reject arbitrary instructions. It must
validate that an enrollment request is backed by the pool's onchain member cap
and unused sponsored-enrollment allocation. For ordinary actions, it must issue
only short-lived quotes that the Pool program can validate against the member's
remaining action allowance. The service should track its SOL float, reconcile
completed enrollment and action charges with chain events, and halt sponsorship
when a pool or member has exhausted the applicable allowance.

## Optional offchain services

Add these only when useful; they must not become the source of truth for money
or permissions. The encrypted profile/key-package store is required when a
pool uses private aliases:

- Event indexer for fast activity feeds and reporting.
- Encrypted profile, alias-envelope, and group-key-package storage.
- Encrypted document / receipt storage.
- Notification delivery.
- Sponsor request rate limits and fraud monitoring.

Solana remains authoritative for pool balances, membership, voting outcomes,
and spend limits.

## Security and rollout

- Pin the exact official native-USDC mint; reject wrapped or lookalike tokens.
- Keep user PII and raw justifications offchain.
- Use separate program accounts for member spending and vote receipts to avoid
  unnecessary contention in active pools.
- Hold program-upgrade authority in a multisig with a timelock; consider making
  mature core logic immutable after audit.
- Start on Solana Devnet, then run a capped real-money pilot before broader
  launch.
- Obtain a smart-contract audit and legal review before handling production
  community funds or integrating fiat on/off-ramps.

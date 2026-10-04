# ADR 0006: Passkey Authorization for User Account Administration and Withdrawal Tickets

## Status

Proposed — 2026-10-04

This ADR specifies a design, not implemented functionality or authorization to
deploy. It amends ADR 0005's authorization policy: a linked wallet alone cannot
administer a User Account or approve a withdrawal. Stable User Account and Pool
Account identities, wallet custody boundaries, SIWS login, and SAS claim semantics
remain as described in ADR 0005.

## Context and Problem Statement

ADR 0005 gives every linked wallet equal account-management permissions. A
compromised wallet could add attacker-controlled wallets, remove legitimate
wallets, and authorize personal withdrawals. Pool rules constrain available
funds but cannot distinguish the attacker from the legitimate wallet holder.

Requiring unanimous wallet signatures prevents single-wallet takeover, but
couples payment wallets to security policy and makes adding wallets burdensome.
Unanimity also prevents removing a lost wallet. An all-but-one removal rule
permits single-wallet takeover when only two wallets remain. Multiple wallet
addresses may share a seed or device and need not be independent factors.

Separate the User Account's authenticators from its payment wallets. Require a
linked wallet signature and an account-associated passkey approval for sensitive
actions. Let users enroll spare passkeys. An approved withdrawal should be
executable later without repeatedly prompting for the passkey, while remaining
bound to the exact approved payment.

There is no central authority responsible for restoring account access. Losing
every passkey without a usable backup means losing administrative and withdrawal
access to the old account, even if its wallets remain accessible.

## Decision Drivers

- A compromised linked wallet alone cannot take over the User Account or drain
  its available pool funds.
- Payment wallet selection is independent of authenticator enrollment.
- Browser-standard passkey interaction with explicit on-chain authorization.
- Spare authenticators without requiring every authenticator for each action.
- Exact, single-use withdrawal authorization separated from later execution.
- No administrator, social-verification, or wallet-only recovery override.
- Preserve pool accounting, governance, admission, and personal-payment rules.
- Make factor independence, transaction consent, and permanent loss risks clear.

## Considered Options

1. **Any linked wallet manages the account.** Simple but compromise of one wallet
   compromises the entire account.
2. **All linked wallets approve management and withdrawals.** Protects against
   one compromised wallet but conflates payment endpoints with authenticators
   and makes lost-wallet removal difficult.
3. **Wallet login plus backend-enforced MFA.** Useful for service access, but a
   malicious client can bypass it unless the program trusts a backend signing
   authority. That introduces an authorization authority outside this policy.
4. **Linked wallet plus any registered passkey, with withdrawal tickets.**
   Separates signing/payment wallets from additional approval, supports spares,
   and gives the program enforceable authorization. Selected approach.

## Decision Outcome

### 1. Authority and Factor Model

The User Account remains a stable program-owned PDA without a private key.
Linked external wallets sign Solana transactions. Passkeys supply an additional
approval for account administration and withdrawal authorization.

| Role | Permission or responsibility |
| --- | --- |
| Linked wallet | Authenticate with SIWS, sign permitted routine pool actions, and provide the wallet signature for protected actions |
| Registered passkey | Provide the additional action-bound approval for administration and withdrawal-ticket issuance |
| Funding wallet | Authorize payments from its token accounts; funding alone grants no account authority |
| Withdrawal destination | Receive the payment explicitly approved in a ticket; linking alone grants no withdrawal permission |
| Fee payer / executor | Pay fees or execute an approved ticket without changing its terms |

The default protected-action rule is **one currently linked wallet signature AND
one valid assertion from any currently registered passkey**. All wallets remain
peers; no primary wallet is introduced. Passkeys are also peers. Spare passkeys
are alternative additional factors, not a quorum requiring all passkeys.

A passkey alone cannot perform a protected action. A linked wallet alone cannot
perform one either. Wallet-provider trust, SIWS sessions, social claims, and
attestation-issuer signatures do not satisfy the passkey requirement.

Support multiple wallets and passkeys through separate bounded link accounts
and explicit implementation limits, not unbounded arrays in UserAccount. Define
an `authority_revision` that changes whenever a wallet, passkey, or authorization
policy changes. Retain ADR 0005's wallet-link revision for its existing bindings.

### 2. Passkey Enrollment and Lifecycle

Use WebAuthn for frontend registration and assertion requests. Browsers handle
supported device authenticators, security keys, password managers, and
cross-device flows. A helper library such as SimpleWebAuthn may handle browser
serialization; it does not establish on-chain authorization by itself.

Passkeys ordinarily produce digital signatures, not zero-knowledge proofs. Some
integrations may use a proof system to verify an assertion on-chain. Such a
system must prove the same required checks and must not substitute a backend's
unverifiable statement that MFA succeeded.

Account creation atomically establishes the initial wallet and initial passkey.
Require the initial wallet's transaction signature, a validated registration,
and an action-bound assertion demonstrating possession of the new passkey.
Neither a credential ID nor a submitted public key alone proves possession.
Bind bootstrap approval to the exact User Account identifier, wallet, passkey
public key, program, cluster, and registration policy before initializing state.

Adding a passkey requires a linked wallet signature, approval by an existing
registered passkey, and registration plus possession proof for the new passkey.
Removing one requires a linked wallet and any currently registered passkey; the
removed passkey need not approve. Reject removing the last passkey. This allows
an accessible spare to replace or remove an unavailable authenticator.

Adding a wallet requires an existing linked wallet signature, a registered
passkey approval, and the new wallet's transaction signature. Removing a wallet
requires a linked wallet signature and passkey approval, but not the target
wallet's signature. Reject removing the last wallet. Wallet unanimity and
all-but-one rules are superseded.

Provider-managed synced passkeys are allowed but must not be described as
necessarily hardware-bound or independent. Encourage at least one spare kept
outside the primary device/provider failure domain. ComFi never collects wallet
or passkey private keys, unlock secrets, or biometric data. Biometrics/PINs unlock
the authenticator locally; they are not submitted to the program.

### 3. Action-Bound Approval and On-Chain Verification

Every protected approval binds a canonical, versioned action payload containing:

- An explicit ComFi authorization domain separator and action type.
- Program ID and cluster binding, User Account address, signing wallet, and
  current authority revision.
- Exact action arguments and all security-relevant account addresses.
- A unique account-scoped request identifier or sequence and an expiry.

Derive the WebAuthn challenge from a cryptographic hash of that payload. Specify
the exact encoding, hash algorithm, integer units, and cluster identifier before
implementation; ambiguous JSON or display strings are not a signing format.
The program reconstructs the payload from actual instruction arguments/accounts.
It cannot rely on a client-provided digest without checking those bindings.

Verification must establish the registered key's signature over WebAuthn
authenticator data and the hash of the exact client-data bytes, the expected
challenge, `webauthn.get` operation type, approved origin and RP ID hash, required
user-presence and user-verification flags, active credential binding, current
authority revision, and expiry. Explicitly validate cross-origin policy and
supported signature algorithms/encodings. Reject malformed or unsupported
assertions. Do not trust arbitrary client-reported authenticator metadata.

Consume each request identifier atomically with its authorized state transition.
WebAuthn signature counters are not the replay mechanism: synced credentials may
not expose a usable monotonic counter. Reusing an assertion, using it for another
action/account/cluster, or substituting a destination must fail.

The program must verify the assertion directly or verify a cryptographic proof
through a supported verifier whose public inputs cover these checks. Backend
verification may provide early feedback but cannot grant authority. Select and
validate the target-cluster verification mechanism before implementation; this
ADR does not claim a particular WebAuthn algorithm or complete verifier is already
available within Solana transaction-size and compute limits.

Show the exact action, amount, source, and destination before requesting approval.
A generic passkey prompt commonly identifies the site rather than displaying
payment terms. A valid assertion proves approval of bound bytes, not that the
authenticator showed or the user understood those terms. A compromised frontend
remains a transaction-consent risk.

### 4. Scope of Protected Administration

Require wallet-plus-passkey approval for all User Account administration:
wallet/passkey enrollment and removal, permissions or authorization-policy
changes, and profile-reference changes. User-directed social association
creation/removal and consent to new verification also require action-bound
wallet-plus-passkey approval at the service boundary. Public validity refreshes
and issuer revocation remain governed by ADR 0005 and grant no account authority.
Service approvals use distinct purposes and cannot be replayed on-chain.

Wallet selection and SIWS login require no administrative state change. Routine
pool actions can retain wallet-only authorization under explicit pool rules.
Internal counters and accounting updates do not independently require a passkey;
they inherit the authorization of the enclosing instruction. Classification is
by capability and effect, not by whether an instruction writes UserAccount.

No routine or delegated capability may enroll authenticators, relax the policy,
authorize a personal withdrawal, or bypass ticket checks. Governance voting and
other wallet-only actions retain their existing compromise exposure; this ADR
does not claim to protect every pool operation from a stolen wallet key.

### 5. Exact, Single-Use Withdrawal Tickets

A withdrawal ticket is a canonical ComFi program-owned account created by a prior
transaction with a linked wallet signature and registered-passkey approval.
Execution reads its verified state; it does not merely accept a transaction hash
as proof of authorization. An existing withdrawal-request account may implement
the ticket contract if its layout and lifecycle enforce every requirement below.

Each ticket records at least:

- Format version, unique ticket ID, owning User Account, and Pool Account.
- Exact withdrawal kind and underlying request/refund entitlement, where present.
- Pool/source vault, token program, accepted mint, exact amount in atomic units,
  destination token account, and expected destination authority.
- Approving wallet/passkey identity, authority revision, approval time, and expiry.
- An irreversible execution/cancellation state and canonical derivation bump.

The initial policy uses exact, single-use tickets, not reusable withdrawal
allowances or arbitrary transaction execution. Linking a recipient wallet does
not itself issue a ticket. Personal destinations must satisfy the pool protocol's
personal-payment restrictions as well as the ticket's exact destination binding.

Ticket issuance records user authorization without transferring funds or
reserving balances. An issuance transaction with invalid factors changes no
state. Ticket execution must:

1. Validate canonical ownership/derivation, User/Pool Account bindings, unused
   state, expiry, and current authority revision.
2. Match the actual source, destination, mint, token program, amount, withdrawal
   kind, and any underlying request to the ticket's immutable terms.
3. Recheck live pool/member status, available entitlement, accounting, locks,
   governance approvals where required, and the existing withdrawal rules.
4. Transfer the exact approved amount, update the underlying accounting/request,
   and consume the ticket atomically. A failed execution consumes neither the
   ticket nor the underlying entitlement.

Execution may be permissionless and sponsored: the executor cannot redirect
funds or alter terms, and needs no new passkey assertion. Executing an already
approved ticket is not creating a new authorization. Duplicate execution and
multiple tickets against the same entitlement must never double-pay; live
accounting and request-consumption checks enforce this even though issuance
does not reserve funds. A changed amount requires a new approval, not partial
execution or silently adjusted payment.

Canceling an unused ticket requires wallet-plus-passkey approval. Wallet,
passkey, or policy changes increment authority revision and invalidate every
unused ticket issued under an earlier revision. Expired, canceled, consumed, or
stale tickets cannot be revived. If accounts are closed for rent reclamation,
preserve replay prevention so closing and recreating a ticket cannot reuse an
old approval or pay an already-consumed entitlement.

### 6. Cover Every Personal Fund-Release Path

Integrate the ticket policy into personal surplus withdrawals, voluntary-exit
payouts, closure refunds, eviction refunds, and any equivalent path that releases
pool-held funds attributable to a User Account. Protect direct transfers,
escrow claims, and combined action/payment instructions equally.

Permissionless governance and lifecycle operations may still close a pool, evict
a member, or calculate an entitlement under the existing rules. If an operation
cannot obtain a valid ticket, record/escrow the personal entitlement rather than
make an unticketed payout. Escrowing funds does not count as approval to release
them. Any resulting layout/flow changes must preserve ADRs 0001–0004's accounting
and surplus-preservation invariants.

Shared-pool governance spending remains separately authorized by pool rules;
these tickets do not authorize arbitrary treasury transfers. Audit any path
that can relabel a personal payout as shared spending or charge a member to
ensure it cannot bypass the intended boundary. Existing fee sponsorship remains
bounded by its own explicit authorization; a ticket executor cannot add an
unapproved deduction to the approved payment.

### 7. Spare Passkeys, Loss, and Replacement Accounts

Users may enroll spare passkeys while an existing passkey and linked wallet are
available. Any usable enrolled spare can approve protected actions and replace
lost authenticators. Provider recovery/synchronization can restore a credential
only when it returns access to an already registered signing key; it does not
authorize enrollment of a different key.

If every registered passkey is unavailable and no backup restores one, no wallet,
service administrator, social verifier, or ancestor claim can reset the policy.
The old account's administrative and new withdrawal-approval capabilities remain
inaccessible. Already issued, valid tickets remain executable on their original
terms; otherwise existing pool funds/entitlements remain subject to the old
account's policy. Losing all linked wallets likewise does not permit passkey-only
reset under this initial model.

The user may create a new User Account with a new passkey and associate wallets
they still control. Wallet links may exist for multiple User Accounts, as in ADR
0005. Creating a replacement does not move the old account's funds, Pool Accounts,
roles, voting history, maturation, or admission lineage.

An optional ancestor reference is an unconfirmed continuity claim, not an
ownership-transfer or recovery capability. Wallet-control evidence may support
the claim but cannot distinguish the legitimate user from an attacker controlling
that wallet. Display its unconfirmed status. No ancestor claim automatically
merges accounts, transfers assets or permissions, proves unique humanity, or
bypasses admission. Authorized migration would require a future explicit design.

### 8. Operation Contract and Rollout

| Operation | Required authorization |
| --- | --- |
| Create User Account | Initial wallet signature, validated first-passkey enrollment/possession, and explicit fee payer |
| Link wallet | Existing linked wallet, any registered passkey, new wallet signature, and fee payer |
| Unlink wallet | Linked wallet, any registered passkey, and fee payer; retain at least one wallet |
| Add passkey | Linked wallet, existing passkey, new-passkey enrollment/possession, and fee payer |
| Remove passkey | Linked wallet, any registered passkey, and fee payer; retain at least one passkey |
| Change account permissions/profile | Linked wallet, any registered passkey, expected applicable revisions, and fee payer |
| Issue/cancel withdrawal ticket | Linked wallet, any registered passkey, exact action bindings, and fee payer |
| Execute withdrawal ticket | Valid current unused ticket, live pool authorization/accounting checks, and fee payer |
| SIWS login / select wallet | Wallet-control proof for login/current link for access; no management permission created |

Same-wallet signing roles need no duplicate transaction signatures. The passkey
assertion is a separate proof and is never inferred from the fee payer's or
wallet's signature. Normal pool/governance rules still apply to every action.

Implement User Account authenticators, revisions, proof validation, tickets, all
personal release paths, service consent, frontend enrollment/approval, and
decoders together. Recreate development fixtures without a production migration
requirement, consistent with ADR 0005. Local disposable test authenticators must
not become a production bypass. This proposal introduces no administrator
override or deployment authorization.

## Threat Model and Attack Mitigations

| Threat | Mitigation or limitation |
| --- | --- |
| One linked wallet compromised | Cannot administer the account or issue a ticket without a registered passkey; routine wallet-only capabilities remain exposed |
| One passkey compromised | Protected actions still require a currently linked wallet signature |
| Wallet and passkey share a compromised device/provider | Two proofs may fail together; encourage independent storage and spares without claiming guaranteed independence |
| Attacker supplies backend MFA success or SIWS signature | Program requires verified action-bound passkey proof; login is not transaction consent |
| Assertion replay or action substitution | Canonical payload bindings, unique consumed request ID, expiry, and authority revision |
| Ticket front-running or substituted recipient | Execution may be public but payment terms are immutable and checked against actual accounts |
| Multiple tickets claim the same funds | Atomic entitlement/accounting updates prevent duplicate payouts |
| Wallet/passkey removed after approval | Authority revision invalidates unused tickets and pending old-revision approvals |
| Exit/refund path bypasses ticket checks | Require tickets for personal release; preserve entitlement in escrow when no ticket exists |
| False ancestor claim | No transfer of authority, membership, funds, or identity guarantees |
| All passkeys lost | No override; replacement account requires rebuilding, without recovery of old rights |
| Malicious frontend misrepresents approval | Bind actual terms and display them; generic authenticator prompts do not provide trusted transaction displays |

## Invariants and Properties

1. User Account and Pool Account identities remain stable across wallet/passkey
   changes; credentials are not membership identities.
2. Every protected action requires both a linked wallet and a registered passkey,
   except bootstrap, which establishes both through verified possession.
3. Any registered spare passkey can supply the additional factor; no wallet or
   passkey has a primary or administrator role.
4. At least one linked wallet and one passkey remain registered.
5. Approval is bound to exact action terms and cannot be reused for another action.
6. A ticket permits at most one exact payment and grants no additional authority.
7. Ticket consumption and fund/accounting changes are atomic.
8. User approval never substitutes for live pool entitlement or governance checks.
9. Every personal fund-release path enforces ticket approval; alternate lifecycle
   paths cannot make unticketed payouts.
10. Authority changes invalidate outstanding old-revision approvals/tickets.
11. Neither backend verification, issuer claims, nor ancestor references recover
    authority or confer permission to move funds.
12. Lost factors are replaceable only using the existing policy; losing every
    passkey without backup provides no exceptional reset path.

## Consequences

**Positive:** A single compromised wallet cannot manage the account or approve
personal withdrawals. Users can add payment wallets without making each one a
required approval factor. Spare passkeys support lost-authenticator replacement.
Tickets permit delayed or sponsored execution with immutable payment terms.
Authority remains enforceable by the program rather than a central operator.

**Trade-offs:** Every administrative action and new withdrawal approval needs
both factors. Complete passkey loss can strand old funds and entitlements.
One compromised passkey plus one compromised linked wallet defeats the policy.
Synced credentials and shared devices may correlate compromise. On-chain
WebAuthn verification requires algorithm, origin, payload, transaction-size, and
compute validation. Lifecycle payouts may require new escrow flows. Generic
passkey prompts do not independently guarantee informed transaction approval.

## Open Implementation Decisions

- Select the target-cluster WebAuthn signature/proof verifier, supported
  algorithms, trust/upgrade assumptions, and transaction-size/compute budget.
  Do not implement protected actions until the required verification is feasible.
- Specify RP ID, accepted production/test origins, registration validation,
  cross-origin policy, and canonical approval encoding/cluster binding.
- Define bounded credential/link layouts, enrollment limits, nonce/sequence
  storage, ticket derivation, expiry limits, and replay-safe rent reclamation.
- Map every existing withdrawal/refund/exit instruction and shared-spend boundary
  to the ticket/escrow contract before implementation.
- Choose whether existing withdrawal requests become tickets or reference separate
  ticket accounts, without duplicating or weakening authorization.
- Select browser helpers and define enrollment, spare-key guidance, transaction
  review, cancellation, and permanent-loss UX.
- Define the optional ancestor claim format and wallet-control evidence without
  implying account recovery or confirmed identity continuity.

## Implementation References

Existing integration points; passkey authorization and tickets are not implemented:

- [ADR 0005: User Accounts, Wallet Selection, and Social Verification](0005-user-accounts-wallet-authority-and-social-verification.md)
- [ADR 0001: Fair Closure Algorithm](0001-fair-closure-algorithm.md)
- [ADR 0003: Member Exit, Eviction, and Surplus Preservation](0003-member-voluntary-exit-and-governance-eviction.md)
- [Pool instructions, payment authorization, and refund handlers](../src/pool.rs)
- [Program entry points](../src/lib.rs)
- [Frontend wallet integration](../../../apps/web/src/wallet.tsx)
- [Sponsor API](../../../services/sponsor-api/src/service.ts)
- [WebAuthn specification](https://www.w3.org/TR/webauthn-3/)
- [SimpleWebAuthn](https://simplewebauthn.dev/)
- [SIWS specification](https://github.com/phantom/sign-in-with-solana)

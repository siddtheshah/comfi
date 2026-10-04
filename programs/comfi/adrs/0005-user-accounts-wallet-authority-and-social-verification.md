# ADR 0005: User Accounts, Wallet Selection, and Social Verification

## Status

Proposed — 2026-10-04

Authorization amendment: [ADR 0006](0006-passkey-user-account-administration-and-withdrawal-tickets.md)
proposes linked-wallet plus registered-passkey approval for User Account
administration and withdrawal-ticket issuance. When implementing that proposal,
its protected-action policy takes precedence over this draft's wallet-only
management rules; stable identities, wallet integration, SIWS, and SAS remain.

This ADR is a design draft. It does not describe implemented functionality or
authorize a deployment. Users link wallets through the UI and select one
for signing and payment. There is no privileged primary wallet or separate
account login provider required by this design.

## Context and Problem Statement

ComFi currently represents a user's participation in a pool with a `Member`
account derived from `["member", pool, wallet]`. The account stores financial
state, roles, and governance history, and instructions authorize its wallet as
the signer. There is no persistent user identity spanning multiple pools.

A User Account should provide a central place to manage wallet associations,
profile information, and verification metadata. Pool Accounts should belong to
that identity, while retaining their own pool-specific financial and governance
state. A wallet change should not create a new membership or discard history.

Users may associate social profiles with their ComFi account. A profile may
publicly name the wallet or link back to the ComFi account as reciprocal
evidence. A unique public challenge is optional; it is unnecessary when the
claim being verified is that the profile publicly identifies the account.

Existing deployments and fixtures are development-only. The new account model
can replace them without supporting migration from the old layouts.

## Decision Drivers

- Stable identity across pools and wallet changes.
- Multiple linked wallets with no privileged primary wallet.
- Explicit transaction authorization and payment sources enforced on-chain.
- Wallet selection handled by the application with minimal user management.
- External wallet custody and signing; ComFi does not generate or manage wallets.
- Reuse wallet authentication and attestation infrastructure.
- Verification labels that describe the actual evidence and its trust source.
- Preserve membership, financial accounting, admission, and voting invariants.
- Keep social verification optional and independent of permission to move funds.
- Support selected platforms reliably rather than promise universal access.

## Considered Options

1. **Continue using wallets as user identities.** Simple, but wallet changes
   change membership addresses and fragment identity across pools.
2. **Use only an off-chain user profile.** Useful for display and login, but
   cannot by itself provide a stable identity for on-chain pool authorization.
3. **Create User Accounts and a bespoke attestation protocol.** Provides the
   required structure but duplicates existing credential lifecycle machinery.
4. **Create User Accounts and use SIWS and SAS.** Keep ComFi-specific account permissions
   and pool ownership in the program; reuse wallet-control proofs and
   attestation mechanisms. Any currently linked wallet may authenticate the user
   and sign permitted actions. This is the proposed approach.

## Decision Outcome

### 1. Stable User Accounts and Pool Accounts

Introduce an on-chain `UserAccount` with a stable address independent of its
selected wallet. Derive it from an immutable identifier, for example
`["user", user_id]`, where `user_id` is a 32-byte creation identifier. Creation
requires the initial wallet signature and an explicit transaction fee payer.
The initial wallet becomes the first linked wallet, with no special permanent
role. The identifier alone conveys no permission and need not correspond to a
wallet key.

Retain `Member` as the pool membership implementation, presented as a **Pool
Account** in the product. Derive it from `["member", pool, user_account]` and
store its owning User Account. Roles, contributions, surplus, allowances,
membership status, and voting maturation remain pool-specific.

There is at most one Pool Account for a given pool and User Account. This is
account uniqueness, not proof that a human has only one User Account.

### 2. Linked Wallets, Selection, and Wallet Trust

A User Account has multiple linked wallets and no privileged primary wallet.
The application provides a selector that requests access from the chosen wallet.
Any currently linked wallet can authenticate the user and sign account or pool
actions, subject to the existing pool rules. Selecting another linked wallet
requires no account ownership transfer or approval from the previously selected
wallet. Membership and history belong to the User Account.

Use explicit terms throughout the implementation:

| Term | Meaning |
| --- | --- |
| Linked wallet | Wallet recorded as authorized to act for the User Account; none is designated the primary owner |
| Selected wallet | Wallet currently chosen in the UI for connection and signing |
| Wallet access / app trust | Wallet-provider permission for the ComFi origin to connect or request signatures; managed by the wallet |
| Transaction signer | Wallet signing an account or pool operation |
| Transaction fee payer | Account paying network fees and specified creation rent; may be a sponsor |
| Funding wallet | Wallet authorizing the USDC source for a payment |
| Attestation issuer | Verifier credential and signing keys that issue SAS claims; cannot manage the User Account |

The user may configure their wallet to trust ComFi. Where the provider supports
it, that trust may remember connections or streamline approval prompts. ComFi
uses standard wallet connection/signing APIs and requests the permissions needed
for the action. It must handle rejected access, locked wallets, disconnects, and
wallet account changes. Connection permission does not necessarily include
silent signing; trust and automatic approval behavior are provider-specific.

#### Wallet integration boundary

In production, ComFi is a wallet client, not a wallet implementation. It does not generate
wallets, derive signing keys, import/export private keys or seed phrases, store
wallet secrets, or manage wallet backup, recovery, or internal account creation.
Users create and maintain their wallets with external providers. ComFi builds
transactions, requests signatures, receives public addresses and signed results,
and submits transactions through supported provider interfaces.

The **ComFi Browser Wallet is testing only**. It is an explicit exception for
localnet/devnet development with disposable keys, including generation,
import/export, and local test-key storage. It is not a production wallet option
and must not accept production wallet secrets or operate on mainnet.

Wallet access can be authorized through either:

- **User-provided access credentials:** the user authenticates or unlocks the
  wallet through the provider's own interface, or supplies a provider-issued
  access credential for its signing API. An access credential means a scoped
  token/session/capability, not a raw private key or seed phrase. Wallet unlock
  passwords and recovery secrets remain with the provider.
- **User-configured wallet policy:** the wallet grants ComFi connection or
  signing access under a policy the user configures, such as per-request
  approval, a remembered trusted-app connection, or supported limits on signing
  operations, amounts, recipients, networks, and duration.

The provider enforces those credentials and policies and performs the signing.
ComFi cannot infer that connection permission authorizes all transactions, nor
broaden a provider's permission. Every operation must satisfy both provider
policy and the on-chain ComFi wallet-link/pool checks. A policy-based request
must still return the actual signature or provider-supported proof required by
the program; a UI setting is not a substitute.

Provider-issued credentials that permit signing are sensitive capabilities even
though they are not wallet keys. Keep their storage and use limited to the
integration's required scope/lifetime, exclude them from logs/public metadata,
and honor expiry/revocation. Prefer provider-managed sessions that avoid passing
credentials through ComFi's backend. Supported remote signing APIs may require
explicit credential handling; that must be documented for the integration.

Expose disconnect/revoke-access controls where the provider supports them and
explain when revocation must happen in its own settings. Provider access
revocation and removal of a ComFi on-chain wallet link are separate operations.
Neither grants ComFi the ability to alter wallet internals.

Wallet-provider trust and ComFi account linking are distinct. The program cannot
read a wallet's local trusted-app list. It verifies the transaction signature
and a current on-chain wallet link to the specified User Account. A wallet
trusting ComFi does not permit it to act for an arbitrary User Account.

Adding a previously unlinked wallet is a UI linking flow, not a primary-wallet
replacement. The proposed initial rule requires proof of the new wallet's
control and approval from **any** already-linked wallet. Both wallets sign the
linking transaction, which is bound to the exact User Account and link revision.
The UI orchestrates the required connections and prompts. The approving wallet
need not be the first wallet or the previously selected wallet. A browser session
or new wallet's signature alone cannot add it to someone else's account.

The proposed first version gives linked wallets equal account-management and
pool-action permissions. Unlinking is approved by any linked wallet and removes
the target wallet's account permissions after confirmation. This avoids a wallet
hierarchy but means compromise of any linked wallet can compromise the User
Account. Users should see what linking permits and be able to remove a wallet.
A wallet connected only to pay is not silently linked or granted account access.

Every transaction explicitly specifies the fee payer. User-funded payments also
specify the funding wallet, source token account, accepted mint, and amount.
The selected linked wallet normally provides the member signature; the funding
wallet and fee payer may differ and must sign for their respective roles. A
sponsor paying fees receives no membership rights or permission to spend USDC.
Selecting a wallet neither automatically debits it nor changes payment recipients.

Personal withdrawal/refund destinations require a linked wallet's explicit
approval and must preserve the protocol's personal-payment restrictions. The
fee payer or executor cannot substitute an arbitrary recipient. Recorded
withdrawal requests keep their exact recipients and terms; switching wallets
cannot retarget them. Incompatible requests fail and must be replaced through
the applicable approval path.

If one wallet becomes unavailable, another linked wallet can continue using the
User Account and link a replacement. If all linked wallets are unavailable,
recovery requires a separately designed mechanism. The initial version rejects
unlinking the last wallet and has no social-claim recovery or administrator
override. ComFi cannot recover assets held in a lost external wallet.

### 3. Wallet Authentication and Access

Use the wallet provider's standard connection/signing APIs for the selector and
**Sign In With Solana (SIWS)** for service authentication. Validate the domain,
wallet, chain, purpose, expiry, and a server-issued single-use nonce. Resolve
account access through the signing wallet's current on-chain links; a wallet may
be linked to multiple User Accounts, so account selection is explicit.

A valid SIWS signature proves wallet control; the current link establishes its
permission to access a particular User Account. SIWS does not replace signatures
on Solana transactions. Service mutations must recheck live link status even
when a session or wallet-provider trust persists. Unlinking invalidates that
wallet's account access, although its provider may still remember trusting ComFi.

Social-linking requests bind the User Account, exact profile, purpose, current
link revision, domain/chain, single-use nonce, and expiry. They are approved by
any currently linked wallet. Replay protection is required even when the social
profile publishes no unique challenge. Mock connections and unsigned public
addresses are not proof of wallet control.

### 4. Social Profile Claims and Evidence

Maintain separate attributes rather than a single universal verified badge:

| Attribute | Meaning | Evidence |
| --- | --- | --- |
| Profile listed | The user claims this profile | Signed request from a currently linked wallet |
| Social account control verified | The verifier established access to the specific social account at the check time | Platform OAuth or a fresh profile/post challenge |
| Public backlink verified | The specific profile publicly identifies this ComFi account or a wallet with a verified association to it at the check time | Public post or profile field, with evidence URL and observation time |

A public post may explicitly name a wallet as the author's own, or link to the
stable ComFi User Account. A bare address in an unrelated post, quote, or
mention is insufficient. Require a currently linked wallet's signed approval claiming
that exact profile as the other side of the association.

Prefer backlinks to the stable User Account, so the reference survives wallet
selection changes. Wallet-only backlinks record the wallet and User Account binding
observed at verification time. Changing the selected wallet does not invalidate
another still-linked wallet's evidence. If a wallet association is revoked,
display its backlink as historical
evidence unless reverified against a current identity binding. Do not use a
previously linked wallet's backlink to establish a different User Account
association.

A unique public challenge may be offered to establish freshness and deliberate
participation. It is not mandatory for a public-backlink claim. Without a fresh
challenge or OAuth, a backlink alone does not establish current control of the
social account or fresh verification intent.

Use platform account IDs where available, along with canonical profile URLs,
because handles can change or be reassigned. OAuth must identify the specific
profile being claimed; a Google login alone does not verify a YouTube channel.

Store the method, subject User Account, platform identity, evidence reference,
observation time, attestation issuer, and expiry. Support explicit unlinking by
any currently linked wallet, and expiry or revocation of verification claims.
Unlinking removes the active association; it cannot erase on-chain history.

### 5. Attestations Through SAS

Use **Solana Attestation Service (SAS)** for portable verification claims rather
than implement a custom credential issuance, expiry, and revocation protocol.
Create distinct, versioned schemas for social-control and public-backlink
claims. Bind each claim explicitly to the stable User Account in its data.
Do not assume a generic SAS nonce proves the identity or consent of its subject.

ComFi's verifier, or an explicitly trusted external verifier, performs the
off-chain checks and issues the corresponding attestation. SAS proves that an
authorized attestation issuer recorded the claim; it does not independently inspect social
profiles or prove the claim's real-world accuracy.

Verification consumers must check the expected SAS program ownership and
canonical account derivation, the exact trusted credential and schema/version,
the subject binding, expiry, and current existence/revocation state. An issuer
name, UI badge, or soulbound token alone is insufficient. Missing or unreadable
current state must not be presented as currently verified.

Issuer trust is explicit: anyone can register a SAS credential. ComFi must pin
accepted issuer credentials and supported schemas, protect issuance keys, and
have a way to stop trusting a compromised issuer. Revocation and issuer trust
changes must invalidate cached verification labels within a defined freshness
window.

Keep OAuth tokens, private platform responses, and sensitive evidence off-chain.
Publish only the minimal attestation data needed for the chosen claim, with
user consent to public cross-account association. Evidence hashes establish
integrity if the evidence is available; they do not establish its truth.

Social verification supplies context for people assessing a member. It does
not grant account access, wallet permissions, spending rights, automatic admission, extra votes,
or proof of unique humanity. Pool admission and governance remain governed by
the existing protocol, including ADR 0004.

### 6. Development Rollout

Replace wallet-based membership derivations and recreate development fixtures.
No legacy account-layout compatibility or financial-state migration is required.

The implementation must update creation/join paths, signer checks, proposals,
vote receipts, spender limits, personal payment checks, sponsor quotes, events,
and frontend decoders together. Admission candidates and vouching lineage must
reference stable user or membership identities rather than changeable wallets.
Preserve historic transaction signers for auditability alongside those identities.

Retain the existing **ComFi Browser Wallet — Testing Only** for localnet/devnet
testing of User Accounts and Pool Accounts. Its generation, secret import/export,
and local key storage are permitted only for disposable test wallets. Enable it
explicitly in development/test builds, label its UI as testing only, and exclude
its implementation from production builds. Enforce the allowed test network
configuration; hiding its UI or relying on a warning alone is insufficient.

External wallet integrations remain the production path and should also be used
in testing to cover real connection/signing prompts, rejection, disconnects, and
account switching. Test fixtures may generate disposable keys independently.

Revoked account or wallet permissions must never survive in a cached
authorization check. Immutable requests and quotes remain bound to their original
terms and are rechecked against current permissions at execution. Wallet
selection or linking must not increase allowances, reset voting maturation,
or enable another vote on the same proposal.

### 7. UserAccount Operations and Method Contract

Solana mutations are program instructions; login and platform checks run in the
service. The selector requests wallet access and signatures through the provider.
There is no `replace_authority` operation or required separate login provider.

#### On-chain account and wallet-link methods

| Method | Required signatures | Behavior and checks |
| --- | --- | --- |
| `create_user_account(user_id, initial_wallet, fee_payer)` | Initial wallet and fee payer | Create the stable User Account and first wallet link atomically. Initialize format version, link revision, linked-wallet count, profile revision, creation time, and bump. Reject an existing identifier. The initial wallet has no privileged role. |
| `link_wallet(user_account, new_wallet, expected_link_revision, fee_payer)` | Any currently linked wallet, new wallet, and fee payer | Validate account/link derivations, existing signer membership, new-wallet control, and expected revision. Create the new link and increment revision/count. Reject duplicate links without changing state. Linking never creates another Pool Account or resets history. |
| `unlink_wallet(user_account, target_wallet, expected_link_revision, fee_payer)` | Any currently linked wallet and fee payer | Validate current link state and expected revision, deactivate/remove the target link, and increment revision/decrement count. Reject removing the last wallet. The target's signature is not required; a linked wallet may remove itself if another remains. |
| `update_profile_reference(expected_profile_revision, metadata_uri, metadata_hash, fee_payer)` | Any currently linked wallet and fee payer | Update a bounded display-metadata reference/hash and increment the profile revision. Reject stale revisions. Clearing is supported. Metadata cannot add wallet permissions or assert verification. |

Multiple signing roles can be filled by the same wallet; duplicate signatures
are unnecessary. Funding a transaction does not by itself create a wallet link.

Keep `UserAccount` bounded: immutable `user_id`, format version, `link_revision`,
linked-wallet count, optional bounded metadata reference/hash, profile revision,
creation time, and bump. Derive separate `UserWalletLink` accounts from
`["user_wallet", user_account, wallet]`; each binds that wallet to that account.
Update links and the account's revision/count atomically. Do not put unbounded
wallet/pool/social lists or private wallet secrets inside the User Account.

Provide a shared internal `require_linked_wallet(user_account, wallet_link,
signer)` check. Validate canonical ComFi ownership and derivations, link/account
binding, current active link state, and signer identity. Member-authorized pool
instructions also retain membership ownership, role, status, funding, and
applicable governance checks. Executors retain the protocol's separate execution
rules and do not impersonate the member requesting an action.

#### UI wallet methods

- `list_available_wallets()` discovers installed/available providers using the
  supported wallet standard. Do not promise discovery of every wallet a user owns.
- `connect_wallet(provider)` asks that provider for access and handles denial,
  locking, disconnects, and account-change events.
- `authorize_wallet_access(provider, access_mode)` uses the provider's
  authentication or user-configured policy flow, accepts only its supported
  access credentials, and records granted capability scope/expiry where exposed.
  It does not create a wallet, collect its unlock secrets, or configure its
  internals independently of the provider.
- `disconnect_wallet(provider)` ends ComFi's connection/session and requests
  access revocation where supported. Show any additional provider-side action
  needed; this method does not remove the on-chain User Account link.
- `select_wallet(wallet)` updates the session selection and asks for access if
  needed. Confirm the selected wallet has an active link for member/account
  actions. Switching among linked wallets has no on-chain mutation.
- `request_wallet_link(wallet)` orchestrates the new wallet's proof and approval
  from any existing linked wallet, submits `link_wallet`, and waits for confirmed
  link state before showing it as authorized.
- `request_wallet_unlink(wallet)` submits `unlink_wallet` through a linked
  wallet and waits for confirmation. Disconnecting a provider locally is not
  the same as removing the on-chain link.
- `sign_and_submit(action, selected_wallet, fee_payer, payment_accounts)` requests
  the necessary signatures using the wallet's access/trust policy. Bind all
  account and payment arguments and show the actual funding source and amount.
  Denial or disconnect must not fall back to another wallet's funds silently.

ComFi does not expose a method that universally enables wallet trust or silent
signing. Users manage trusted-app settings in their wallets; provider-specific
capabilities may improve the UI without changing program authorization.

#### Wallet login and verification service

| Method | Required authorization or proof | Behavior and checks |
| --- | --- | --- |
| `create_sign_in_request()` / `verify_sign_in(response)` | Valid SIWS response to a single-use request | Authenticate the wallet and resolve User Account access through current wallet links. No separate email/passkey login is required. |
| `link_social_profile(platform, profile_identity)` | Purpose-bound request signed by a linked wallet | Normalize the identity and create an active unverified association with a consent record. Repeating the same active link is idempotent; a different profile cannot inherit verification. |
| `unlink_social_profile(link_id, expected_link_revision)` | Purpose-bound request signed by a linked wallet | Deactivate the social link, increment its own revision, clear active labels, and cancel pending checks. Request issuer revocation where available; external SAS claims may remain but are not active ComFi associations. |
| `verify_social_control(link_id, method)` | Linked-wallet consent and successful OAuth or fresh public challenge | Check the specific social account, then have an attestation issuer create the SAS control claim. Backlink-only evidence cannot produce a control claim. |
| `verify_public_backlink(link_id, evidence_url)` | Linked-wallet consent and successful public evidence check | Check profile authorship and identification of the User Account or a currently linked wallet. Record the matched identity/time and issue the SAS backlink claim. No unique public challenge is required. |
| `attach_attestation(link_id, attestation_address)` | Linked-wallet consent or completion of its authorized request | Validate live SAS ownership/derivation, trusted issuer credential, schema/version, exact subject/social identity, and expiry. Store a reference, never a permanent verified boolean. |
| `refresh_verification(link_id)` | Permissionless validity recheck; renewed consent for platform access where needed | Recheck SAS state and issuer trust. Renewing evidence requires another platform check and fresh claim; reading an old claim does not refresh its observation time. |

Signed service mutations bind the User Account, current wallet-link revision,
purpose/arguments, domain/chain, single-use nonce, and expiry. Recheck the signing
wallet's active link before accepting changes and publishing delayed verification
results. Neither a cached session nor provider trust survives on-chain unlinking
as permission to mutate that User Account.

Social links remain separate service records with stable IDs, their own
revisions, platform identities, active state, consent records, and SAS addresses.
Bind jobs to the social-link revision so delayed results cannot reactivate an
unlinked profile. Relinking requires fresh consent and explicit claim validation.
SAS issuance/revocation belongs to the attestation issuer, not a user wallet.

#### Read and pool execution methods

- `get_user_account(address)` returns canonical identity, wallet-link/profile
  revisions, wallet count, and profile reference. Treat fetched metadata as
  untrusted display content and check its hash.
- `list_linked_wallets(user_account)` queries current wallet-link accounts;
  none is labeled primary or owner.
- `find_user_accounts_by_wallet(wallet)` provides discovery through link queries
  or an indexer; recheck live links before authorization.
- `get_pool_account(user_account, pool)` derives stable membership;
  `list_pool_accounts(user_account)` queries membership ownership.
- `list_social_profiles(user_account)` returns active associations and per-claim
  attestation issuer, method, observation/expiry time, evidence, and current,
  historical, expired, revoked, or unavailable status.
- Member-authorized pool actions specify `user_account`, `wallet_link`, signing
  wallet, Pool Account where applicable, and `fee_payer`. User-funded payments
  also specify `funding_wallet`, `source_usdc`, mint, and amount. Withdrawal
  requests bind their exact destination. Each wallet signs for its required role.

`recover_account`, `merge_accounts`, and `close_user_account` remain excluded
initially. Loss of all linked wallets needs a future explicit recovery policy,
not acceptance of an arbitrary wallet or social claim. Profile clearing and
social unlinking do not erase public on-chain history.

## Threat Model and Attack Mitigations

| Threat | Mitigation or limitation |
| --- | --- |
| Attacker selects or connects another wallet | Validate current on-chain link and signer; provider trust or UI selection alone grants no permission |
| Attacker substitutes a User Account or Pool Account | Validate program ownership, derivation, and all subject/ownership bindings |
| Replay of a signed linking request | Domain- and purpose-bound request, single-use nonce, expiry, exact subject/profile binding |
| Old or incidental post mistaken for current social control | Require an explicit ownership statement; label backlink evidence separately from fresh control verification |
| Forged issuer name or counterfeit verification token | Pin exact credential/schema addresses and validate live SAS account state |
| Compromised verifier or social account | Issuer trust management, key protection, expiry, revocation, and rechecking; false claims remain possible |
| Wallet change creates duplicate membership or votes | Stable pool/user derivation and vote receipts bound to stable membership |
| Multiple User Accounts for one person | Not prevented by this design; existing admission and governance defenses still apply |
| Social verifier compromise enables fund theft | Social claims do not authorize transactions, wallet links, or account recovery |

## Invariants and Properties

1. A User Account's address is independent of its selected wallet.
2. Each Pool Account belongs to exactly one pool and one User Account.
3. No linked wallet has a privileged primary/owner role.
4. Selecting an already-linked wallet requires neither an ownership transfer
   nor the previously selected wallet's approval.
5. Linking a new wallet requires its control proof and approval by any existing
   linked wallet; UI connection or provider trust alone cannot create the link.
6. Linking or switching wallets preserves membership, balances, lineage,
   allowances, voting maturation, and vote history.
7. The last linked wallet cannot be unlinked in the initial implementation.
8. Every transaction identifies its fee payer; every user-funded payment binds
   the funding wallet, source token account, mint, and amount.
9. Fees paid by an executor or sponsor grant no account permissions.
10. Verification is scoped to a claim, subject, attestation issuer, method, and time.
11. A public backlink alone proves neither current social control nor unique humanity.
12. Social evidence alone changes neither account access nor financial permissions.
13. Production ComFi never generates wallets or receives raw signing/recovery
    secrets. External providers perform signing under user-authorized access.
    The ComFi Browser Wallet is a testing-only exception, limited to disposable
    keys on localnet/devnet and excluded from production builds.
14. Provider credentials/policies and on-chain ComFi permissions are independently
    enforced; neither bypasses the other.

## Consequences

**Positive:** Users link wallets through a familiar UI and select whichever
linked wallet they want to use. No primary wallet or ownership transfer is
needed. Wallet-provider trust may streamline prompts. Account and pool history
remain stable. SIWS and SAS reduce duplicated infrastructure; verification
labels communicate actual evidence without mandatory public challenges.

**Trade-offs:** Linking a new wallet requires proof and an existing linked
wallet's approval. Equal wallet permissions mean each linked wallet is a possible
account-compromise path. Provider trust behavior varies and cannot replace
on-chain link checks. Losing all linked wallets means losing account access in
the first version. Social verification requires platform access, issuer trust,
refreshing evidence, and consent to public identity links.

## Open Implementation Decisions

- Confirm the proposed equal-permission linking/unlinking rules before
  implementation; granular permissions or recovery would require further design.
- Select supported wallet providers/standard features and handle their connection,
  trust, account-change, and signing behavior without assuming silent approvals.
- Specify supported credential/policy integrations, permission scopes, sensitive
  capability storage, expiry, and provider-side revocation behavior.
- Define funding-wallet defaults and sponsorship, including how users see and
  approve the actual payment source.
- Select initial social platforms and OAuth/public-content checks.
- Define trusted attestation issuer management, SAS schema/version policy, claim
  lifetimes, and cache freshness limits.
- Verify SAS deployment/version, audit coverage, and upgrade authority on the
  target cluster before integration; this ADR is not an audit assessment.
- Decide whether existing verification providers meet the supported claims
  or whether ComFi must operate a verifier.

## Implementation References

Existing integration points; User Accounts and verification are not implemented:

- [Pool accounts and instruction authorization](../src/pool.rs)
- [Pool creation and creator membership](../src/deployer.rs)
- [Program instruction entry points](../src/lib.rs)
- [Frontend wallet state](../../../apps/web/src/wallet.tsx)
- [Frontend account decoding](../../../apps/web/src/solana.ts)
- [Sponsor API](../../../services/sponsor-api/src/service.ts)
- [ADR 0004: Admission and governance defenses](0004-sybil-resistance-and-governance-takeover-defense.md)
- [SIWS specification](https://github.com/phantom/sign-in-with-solana)
- [SAS overview](https://attest.solana.com/)
- [SAS implementation and verification guidance](https://github.com/solana-foundation/solana-attestation-service)

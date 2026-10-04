# ComFi Web Application Issues & Misalignment Report

This document details critical, high, medium, and architectural misalignments, bugs, and design discrepancies identified in [`apps/web`](file:///c:/Users/sidds/Documents/comfi/apps/web) relative to the Solana smart contract, [`TASKLIST.md`](file:///c:/Users/sidds/Documents/comfi/TASKLIST.md), and workspace verification rules.

---

## Executive Summary

| Issue ID | Severity | Category | Description | Status |
| :--- | :--- | :--- | :--- | :--- |
| **COMFI-WEB-01** | **Critical** | Architecture / On-Chain State | Invitation webhook pipeline creates simulated mock proposals in `localStorage` instead of dispatching real on-chain `create_proposal(AdmitMember)` transactions | **Open** |
| **COMFI-WEB-02** | **Critical** | Wallet / Network Parity | Pool creation bypasses browser wallets (Phantom, Backpack, In-Browser) and relies on dev server script, breaking Devnet & Testnet deployments | **Open** |
| **COMFI-WEB-03** | **High** | UX / Functional Lock | Mock wallet signing paradox: pool creation requires `walletMode === 'mock'`, but governance signing strictly forbids `mock` mode | **Open** |
| **COMFI-WEB-04** | **High** | Feature Completeness | Copilot Supervised (Tier 2) and Autonomous (Tier 3) modes are hardcoded disabled in the UI despite being marked completed | **Open** |
| **COMFI-WEB-05** | **High** | Architecture / Automation | Copilot autonomous actions (cycle roll, proposal execute, auto-vote) are simulated in-memory audit logs without submitting Solana transactions | **Open** |
| **COMFI-WEB-06** | **Medium** | React Integration | Disconnected props: `CopilotPanel` is rendered in `App.tsx` without passing `onExecuteProposal` or `onRollCycle` handlers | **Open** |
| **COMFI-WEB-07** | **High** | Feature Gap | Missing Membership Directory, Vouch Lineage Visualizer, and Member Lifecycle Actions (`leave`, `claim_refund`, `set_paused`) in `apps/web` | **Open** |
| **COMFI-WEB-08** | **Medium** | Feature Gap | Spends & Treasury View (Cycle Limits, Authorizations, Pending Withdrawals) is completely missing from `apps/web` | **Open** |
| **COMFI-WEB-09** | **Medium** | Rule Violation / Zero-Evasion | `WalletModal.tsx` copyToClipboard silently catches errors and flags success on clipboard failure | **Open** |
| **COMFI-WEB-10** | **Low** | Error Handling / UX | Submitting invitation acceptance where candidate equals inviter throws uncaught React runtime exception | **Open** |

---

## Detailed Findings

---

### COMFI-WEB-01: Invitation Webhook Pipeline Uses Simulated Proposal Dispatch Instead of On-Chain Solana Transaction

- **Severity:** Critical
- **Category:** Architecture / On-Chain State
- **Affected Files:** [`apps/web/src/invitation-engine.ts:341-369`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/invitation-engine.ts#L341-L369), [`apps/web/src/InviteAcceptanceView.tsx:88-105`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/InviteAcceptanceView.tsx#L88-L105), [`apps/web/src/GovernanceView.tsx:86-100`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/GovernanceView.tsx#L86-L100)
- **Tasklist Reference:** Section 4, line 56: `- [x] Implement automated webhook-style listener that detects the recipient's wallet submission and dispatches an AdmitMember governance proposal on behalf of the inviter.`

#### Description
When a candidate accepts an invitation in `InviteAcceptanceView`, `submitRecipientWallet()` triggers the webhook listener `dispatchAdmitMemberProposal()`. 

Instead of assembling an on-chain transaction instruction calling `create_proposal(ProposalAction::AdmitMember { candidate_wallet, vouched_by })` using the inviter's key or delegating signing:
```typescript
// apps/web/src/invitation-engine.ts
export async function dispatchAdmitMemberProposal(
  event: InvitationWebhookEvent
): Promise<AdmitMemberProposalDispatchResult> {
  // ... validation ...
  const proposalId = nextMockProposalId++
  const proposalAddress = `PropAdmit${proposalId}x${event.candidateWallet.slice(0, 8)}`
  const dispatchedAt = new Date().toISOString()

  return {
    success: true,
    proposalId,
    proposalAddress,
    poolAddress: event.poolAddress,
    candidateWallet: event.candidateWallet,
    vouchedBy: event.inviterAddress,
    actionType: 'AdmitMember',
    dispatchedAt,
  }
}
```
The result is recorded exclusively in browser `localStorage`. 

#### Impact
In [`GovernanceView.tsx`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/GovernanceView.tsx#L86-L100), proposals are fetched directly from the on-chain Solana cluster via `connection.getProgramAccounts(program, { filters: [...] })`. Because the webhook never broadcasts a transaction to the network, the admitted candidate proposal **never appears in the Governance View**, cannot be voted upon by members, and cannot be executed on-chain.

#### Recommended Remediation
Integrate `buildGovernanceTransaction` with `kind: 'create'` and `action: { kind: 'AdmitMember', candidateWallet, vouchedBy }` inside the webhook dispatch pipeline, signing with the active connected wallet or queueing it for 1-click user signature.

---

### COMFI-WEB-02: Pool Creation Bypasses Browser Wallets & Relies on Dev Server Script

- **Severity:** Critical
- **Category:** Wallet / Network Parity
- **Affected Files:** [`apps/web/src/App.tsx:142-175`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/App.tsx#L142-L175), [`apps/web/vite.config.ts:10-65`](file:///c:/Users/sidds/Documents/comfi/apps/web/vite.config.ts#L10-L65)
- **Tasklist Reference:** Section 2 (Browser Wallet Integration) & Section 4 (Create Pool Modal)

#### Description
Pool deployment in `apps/web` is coupled to a custom Vite dev server middleware route `/__comfi/mock-wallet/create-pool`. This server route uses `child_process.spawn` to run `scripts/create-test-pool.mjs` using Node.js on the host machine.
```typescript
// apps/web/src/App.tsx
const createPool = async (customParams?: CreatePoolModalParams) => {
  if (!wallet.useLocalnetApi) return setNotice('This test action requires the configured localnet RPC.')
  if (!wallet.connected || wallet.walletMode !== 'mock') return setNotice('Select and connect the mock wallet to use this localnet test action.')
  // ... fetch('/__comfi/mock-wallet/create-pool') ...
}
```

#### Impact
1. Users connected with real browser wallets (In-Browser Web Wallet, Phantom, Backpack) are prohibited from deploying pools.
2. The interactive Network Switcher allows users to select Devnet or Testnet, but attempting to create a pool on any non-localnet RPC immediately errors out with *"This test action requires the configured localnet RPC."*
3. Production bundles (`vite build && vite preview`) cannot create pools because the Vite dev middleware does not exist in production.

#### Recommended Remediation
Construct a standard client-side Solana transaction using `@solana/web3.js` for the `create_pool` instruction, signing and sending via `wallet.sendTransaction(tx)` across any supported network.

---

### COMFI-WEB-03: The Mock vs Web3 Wallet Signing Paradox

- **Severity:** High
- **Category:** UX / Functional Lock
- **Affected Files:** [`apps/web/src/App.tsx:144`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/App.tsx#L144), [`apps/web/src/GovernanceView.tsx:49, 68`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/GovernanceView.tsx#L49)

#### Description
There is a conflicting invariant between pool creation and governance operations:
- In `App.tsx`: `if (wallet.walletMode !== 'mock') return setNotice('Select and connect the mock wallet to use this localnet test action.')`
- In `GovernanceView.tsx`: `const canSign = wallet.connected && wallet.walletMode !== 'mock'`

#### Impact
A user must use `mock` mode to create a pool. However, once in the pool view, `mock` mode disables all governance actions (*"Select and connect ComFi Wallet, Phantom or Backpack to sign governance transactions."*). The creator cannot vote, create proposals, or finalize results without opening the wallet modal, switching wallet modes, and importing the test keypair.

#### Recommended Remediation
Enable In-Browser Wallet and extension wallets to sign `create_pool` transactions directly, removing the mock-mode restriction.

---

### COMFI-WEB-04: Copilot Supervised & Autonomous Tiers are Hardcoded Disabled in UI

- **Severity:** High
- **Category:** Feature Completeness
- **Affected Files:** [`apps/web/src/CopilotPanel.tsx:48, 92-98`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/CopilotPanel.tsx#L48-L98)
- **Tasklist Reference:** Section 5, lines 63–64: `- [x] Tier 2: Supervised Automation`, `- [x] Tier 3: Autonomous Delegation`

#### Description
In `TASKLIST.md`, user-configurable risk and autonomy tiers are marked completed. In reality, `CopilotPanel.tsx` contains explicit guard logic that forbids setting the tier to anything other than `advisory`:
```typescript
// apps/web/src/CopilotPanel.tsx
const [config, setConfig] = useState<CopilotConfig>(() => ({ ...loadCopilotConfig(), tier: 'advisory' }))

const setTier = (tier: AutonomyTier) => {
  if (tier !== 'advisory') {
    setActionNotice('Automation is unavailable until transaction signing is connected.')
    return
  }
  updateConfig({ ...config, tier })
}
```
Furthermore, the Copilot greeting states: *"Transaction signing and proposal data are not connected yet."*

#### Impact
Users cannot enable or test Tier 2 (Supervised) or Tier 3 (Autonomous) delegation. The settings tabs exist visually, but clicks are intercepted and rejected.

#### Recommended Remediation
Wire transaction signing capabilities (via `wallet.sendTransaction`) into the copilot execution path or clarify that semi-autonomous and autonomous execution remain staged for post-pilot releases.

---

### COMFI-WEB-05: Copilot Autonomous Actions are Simulated Local Storage Entries

- **Severity:** High
- **Category:** Architecture / Automation
- **Affected Files:** [`apps/web/src/copilot-engine.ts:216-265`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/copilot-engine.ts#L216-L265)
- **Tasklist Reference:** Section 5, lines 65–70: `- [x] Auto-roll cycle`, `- [x] Auto-execute passed proposals`

#### Description
In `copilot-engine.ts`, evaluation routines for automated cycle rolls, proposal executions, and claims do not broadcast transactions to Solana. Instead, they synthesize local audit objects with `status: 'executed'`, `confidenceScore: 98`, and generated rationale text, appending them to `localStorage`.

#### Impact
No cycles are advanced on-chain, and no eligible proposals are executed on-chain by the Copilot engine. The audit log reports successful execution even though on-chain state remains unchanged.

#### Recommended Remediation
Provide explicit on-chain execution adapters that invoke `roll_cycle` or `execute_*` via the active wallet provider when user toggles permit.

---

### COMFI-WEB-06: Disconnected Props for Copilot Action Handlers

- **Severity:** Medium
- **Category:** React Integration
- **Affected Files:** [`apps/web/src/App.tsx:297-305`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/App.tsx#L297-L305), [`apps/web/src/CopilotPanel.tsx:31-32`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/CopilotPanel.tsx#L31-L32)

#### Description
`CopilotPanelProps` defines execution callbacks:
```typescript
interface CopilotPanelProps {
  onExecuteProposal?: (proposalId: number) => Promise<void> | void
  onRollCycle?: () => Promise<void> | void
}
```
In `App.tsx`, `<CopilotPanel />` is rendered without passing either prop:
```tsx
<CopilotPanel
  isOpen={copilotOpen}
  onClose={() => setCopilotOpen(false)}
  selectedPool={selected}
  networkName={NETWORK_LABELS[wallet.network]}
  walletConnected={wallet.connected}
  walletAddress={wallet.publicKey}
/>
```

#### Impact
Even if autonomy locks were bypassed, `CopilotPanel` has no handler to call back into `App.tsx` or `wallet` to execute proposals or roll cycles.

#### Recommended Remediation
Pass concrete `onExecuteProposal` and `onRollCycle` handlers that construct and send the appropriate transactions.

---

### COMFI-WEB-07: Unimplemented Membership Directory, Vouch Lineage & Member Lifecycle Actions

- **Severity:** High
- **Category:** Feature Gap
- **Affected Files:** [`apps/web/src/App.tsx:592, 605`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/App.tsx#L592-L605)
- **Tasklist Reference:** Section 3, lines 41–45: `- [ ] Implement Membership & History View`

#### Description
While `@comfi/testing` implements comprehensive member management and tests, `apps/web` retains placeholder text:
- Line 592: `<p>Activity history is not connected yet.</p>`
- Line 605: `<p>Member directory is not connected yet.</p>`
- Vouch lineage visualizer is absent.
- There are no UI controls or transaction builders in `apps/web` for:
  - `leave_pool`
  - `claim_closure_refund`
  - `claim_eviction_refund`
  - `set_paused`
  - `deposit`
  - `join_pool`

#### Impact
Members cannot inspect the roster of participants, view vouch chains, deposit additional funds, pause their cycle participation, leave the pool, or claim owed liquidation refunds from the web application.

#### Recommended Remediation
Build dedicated `MembershipDirectory` and `MemberActions` cards in `apps/web` referencing the existing decoding logic in `solana.ts` and `governance.ts`.

---

### COMFI-WEB-08: Spends & Treasury View Completely Missing from Web App

- **Severity:** Medium
- **Category:** Feature Gap
- **Affected Files:** [`apps/web/src/App.tsx`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/App.tsx), [`apps/web/src/GovernanceView.tsx`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/GovernanceView.tsx)
- **Tasklist Reference:** Section 3, lines 46–49: `- [ ] Implement Spends & Treasury View`

#### Description
No tab, modal, or component exists in `apps/web` for:
- Active cycle limits and authorized spenders.
- Pending withdrawal requests and justifications.
- Historical spend distribution logs.

#### Impact
Pool spend tracking cannot be audited or managed visually by members.

#### Recommended Remediation
Implement a `TreasuryView` component that reads `WithdrawalRequest` accounts and renders cycle spender allowances.

---

### COMFI-WEB-09: Silent Error Masking in `WalletModal.tsx` Clipboard Copy

- **Severity:** Medium
- **Category:** Rule Violation / Zero-Evasion
- **Affected Files:** [`apps/web/src/WalletModal.tsx:26-36`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/WalletModal.tsx#L26-L36)
- **Workspace Rule Reference:** *"Do not add try-catch statements to evade legitimate failure scenarios. Escalate when input arguments or parameters violate expectations."*

#### Description
In `WalletModal.tsx`, clipboard copy failures are caught and masked:
```typescript
const copyToClipboard = async (text: string, fieldName: string) => {
  try {
    await navigator.clipboard.writeText(text)
    setCopiedField(fieldName)
    setTimeout(() => setCopiedField(null), 2000)
  } catch {
    // Fallback
    setCopiedField(fieldName)
    setTimeout(() => setCopiedField(null), 2000)
  }
}
```

#### Impact
If clipboard writing fails (due to browser permissions, insecure context, or browser denial), the UI still reports `"✓ Copied"`, falsely confirming to the user that their address was copied.

#### Recommended Remediation
Remove error masking in the catch block and set an explicit error state (`setImportError('Failed to copy to clipboard')`).

---

### COMFI-WEB-10: Uncaught Error When Inviter Accepts Own Invitation

- **Severity:** Low
- **Category:** Error Handling / UX
- **Affected Files:** [`apps/web/src/InviteAcceptanceView.tsx:96`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/InviteAcceptanceView.tsx#L96), [`apps/web/src/invitation-engine.ts:398-400`](file:///c:/Users/sidds/Documents/comfi/apps/web/src/invitation-engine.ts#L398-L400)

#### Description
When a candidate wallet equals the inviter address, `submitRecipientWallet()` throws an unhandled error:
```typescript
if (record.inviterAddress.toLowerCase() === validatedCandidate.toLowerCase()) {
  throw new Error('Candidate wallet cannot be identical to the inviter address')
}
```
In `InviteAcceptanceView.tsx`, the submission call does not catch this error, resulting in an uncaught exception in the browser during React discrete event dispatch.

#### Recommended Remediation
Add inline validation before form submission or handle the rejection in `InviteAcceptanceView.tsx` to display an inline error message.

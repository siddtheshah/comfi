---
name: comfi-testing
description: Execute unit tests, type checks, backend action simulations, and end-to-end tests across the ComFi monorepo workspaces (@comfi/testing, @comfi/sponsor-api, @comfi/web). Use when adding or updating tests, validating test coverage, diagnosing test failures, running regression checks, or verifying parameter escalation invariants.
---

# ComFi Testing Guide & Skill

This skill documents the testing architecture, execution workflows, and testing invariants for the ComFi monorepo.

---

## 1. Core Testing Invariants

All automated and manual testing in ComFi must strictly adhere to the following rules:

1. **Continuous Execution**: Always run unit tests (`npm test`) after any change to code or configuration.
2. **Zero Failure Evasion**: Never add `try-catch` blocks to suppress or evade legitimate failure scenarios. Escalate when input arguments, RPC responses, or parameters violate contract expectations.
3. **Explicit Failure Assertion**: When writing tests for parameter validation or error handling, assert explicit exceptions with `assert.throws()` or `assert.rejects()` matching the exact error message or error code.

---

## 2. Test Suites & Execution Commands

### A. Workspace Unit Tests
Runs all unit test suites across monorepo packages (`@comfi/testing` and `@comfi/sponsor-api`):

```bash
npm test
```

To run tests for a specific workspace:
```bash
# Test localnet backend actions, governance simulation, and formatting
npm test --workspace=@comfi/testing

# Test sponsor quotes, allowances, and signature verification
npm test --workspace=@comfi/sponsor-api
```

### B. Type Checking
Verifies TypeScript compilation and type definitions across all packages (`apps/web`, `apps/testing`, and `services/sponsor-api`):

```bash
npm run typecheck
```

### C. End-to-End Tests (Playwright)
Executes browser E2E flows validating mock wallet connections, on-chain pool inspection, proposal creation, and payments:

```bash
# Requires localnet validator running (or uses Vite mock mode)
npm run test:e2e
```

---

## 3. Writing Unit Tests

ComFi uses the built-in Node.js test runner (`node:test`) and assertion library (`node:assert/strict`) for speed and zero external dependencies.

### Pattern: Validating Parameter Escalation (Zero Evasion)
Always verify that invalid inputs throw or reject immediately rather than returning null or failing silently:

```typescript
import assert from 'node:assert/strict'
import test from 'node:test'
import { executeAction, formatUsdc } from '../src/backend/localnet.ts'

test('formatUsdc rejects invalid atomic inputs rather than evading failures', () => {
  assert.throws(() => {
    formatUsdc('invalid-amount')
  }, { message: /Invalid atomic amount/ })
})

test('executeAction escalates on missing required poolAddress parameter', async () => {
  await assert.rejects(
    async () => {
      await executeAction('deposit', { walletName: 'creator', amount: 10 })
    },
    { message: /Missing poolAddress/ }
  )
})
```

### Pattern: Testing Governance Actions & Proposals
When adding or testing new governance proposal types (`ClosePool`, `EvictMember`, `AdmitMember`, etc.), verify both creation and execution flows in `apps/testing/test/api.test.ts`:

1. **Creation**: Confirm required arguments (e.g. `candidateWallet`, `targetMemberPda`, `inviterWallet`) are present.
2. **Quorum & Voting**: Validate that threshold calculations observe the basis points minimum floor (`5001` bps for critical proposals).
3. **Execution**: Verify post-timelock execution updates pool and member statuses appropriately.

---

## 4. Localnet & Testing Console Integration

For interactive testing and on-chain verification, use the isolated localnet validator and the dedicated Dev Testing Console.

### Step 1: Start and Bootstrap Localnet
```bash
# Starts validator on http://127.0.0.1:8899, deploys contract, creates USDC mint & test wallets
npm run localnet:setup

# Optional: Seed a test pool with funded members and active cycle
npm run localnet:create-test-pool
```

### Step 2: Start Dev Testing Console
```bash
npm run dev:testing
```
Open `http://localhost:5174` to access the Testing Console:
- Inspect pool state, quorum health, and cycle numbers.
- Switch between test wallets (`creator`, `member2`, `member3`, `spender`).
- Test proposals (`SetSpenderLimit`, `ApproveWithdrawal`, `ClosePool`, `EvictMember`, `AdmitMember`).
- Roll cycles manually or via the keeper script:
  ```bash
  npm run keeper:crank
  ```

---

## 5. Verification Checklist Before Committing

Before creating a completion commit (or Subagent Commit 2):

- [ ] `npm test` passes with 0 failures.
- [ ] `npm run typecheck` passes with 0 errors across all workspaces.
- [ ] Any newly added functions or action handlers include negative escalation tests in `apps/testing/test/api.test.ts` or `services/sponsor-api/test/service.test.ts`.
- [ ] No `try-catch` blocks were added to conceal contract errors or unexpected states.
- [ ] `TASKLIST.md` is updated to reflect the completed task.

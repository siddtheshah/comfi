# ComFi (Community Finance)

ComFi is a decentralized Community Finance protocol on Solana that enables groups, DAOs, and clubs to pool funds, establish recurring funding cycles, and authorize trusted members with transparent spending allowances from a shared community USDC vault.

All transactions and governance actions are verifiably settled on-chain. ComFi provides an open, trusted alternative to opaque group budgeting and expensive SaaS subscription apps.

---

## Key Features

- **Pooled USDC Vaults**: PDA-governed native USDC vaults secured by Anchor smart contracts.
- **Funding Cycles & Obligations**: Configurable cycle durations and member deposit obligations with transparent voting power.
- **Granular Spend Limits & Justifications**: Authorized spenders can draw up to per-cycle caps or submit one-off withdrawal requests accompanied by publicly inspectable justifications.
- **Democratic Governance**: Six distinct proposal types (`SetSpenderLimit`, `ApproveWithdrawal`, `ConfigurationModification`, `ClosePool`, `EvictMember`, `AdmitMember`) with quorum enforcement and execution timelocks.
- **Fair Settlement & Anti-Cartel Settlement**: Mathematical $O(1)$ cumulative spend-benefit tracking and anti-cartel closure waterfall to protect members upon pool wind-down.
- **Subagent Protocol**: Automated development workflow powered by autonomous subagents coordinating via task claims in [`TASKLIST.md`](./TASKLIST.md).

---

## Workspace Structure

This monorepo is organized into the following packages and services:

| Package | Path | Description |
| :--- | :--- | :--- |
| **`@comfi/web`** | [`apps/web`](./apps/web) | Member web application (React, Vite, TypeScript) for pool exploration, multi-wallet connections, governance voting, and treasury management. |
| **`@comfi/testing`** | [`apps/testing`](./apps/testing) | Developer test console and governance action simulator running on localnet and devnet. |
| **`@comfi/sponsor-api`** | [`services/sponsor-api`](./services/sponsor-api) | Bounded, HMAC-signed transaction sponsorship and capacity-enrollment quote microservice. |
| **`comfi`** | [`programs/comfi`](./programs/comfi) | Anchor smart contract guarding USDC vaults, member accounts, cycles, and governance proposals. |

---

## Installation & Setup

For complete, step-by-step setup instructions—including toolchain prerequisites (Node.js 22+, Rust, Solana CLI, Anchor CLI, WSL2), localnet validator setup, and environment configuration—please see the **[Installation Guide](./INSTALL.md)**.

---

## Testing & Verification

Always run test suites before committing changes:

- **Unit Tests**:
  ```shell
  npm test
  ```
  *Executes test suites across `@comfi/testing` and `@comfi/sponsor-api`.*

- **Type Checking**:
  ```shell
  npm run typecheck
  ```
  *Strict TypeScript verification across `@comfi/web`, `@comfi/testing`, and `@comfi/sponsor-api`.*

- **End-to-End Tests**:
  ```shell
  npm run test:e2e
  ```
  *Runs Playwright E2E suites validating wallet connection, pool inspections, proposals, and requests.*

- **Devnet Fixtures**: See [`fixtures/devnet/README.md`](./fixtures/devnet/README.md) for public Devnet deployment details and test fixture configurations.

---

## Subagents & Development Protocol

Autonomous agents contributing to this repository operate under the **Two-Commit Execution Model** defined in **[`AGENTS.md`](./AGENTS.md)**:

1. **Claim Task**: Subagents inspect **[`TASKLIST.md`](./TASKLIST.md)**, assign their identifier and an ISO-8601 deadline, and commit the claim as Commit 1.
2. **Execute & Complete**: Subagents implement the task, ensure `npm test` and `npm run typecheck` pass, update the task to completed (`- [x]`), commit the work as Commit 2, and terminate.

---

## Security & Community Vigilance

- **Audit & Remediation**: See the [Security Vulnerability & Audit Tracker](programs/comfi/README.md#security-vulnerability--audit-tracker) in `programs/comfi` for resolved and tracked findings.
- **On-Chain Transparency**: While all transactions and justifications are immutably recorded on-chain, community members must actively review spending history and exercise their voting rights. ComFi is a transparent financial companion to community chats, not a substitute for human communication.

### Phantom browser wallet

Open **ComFi Wallet → Phantom → Connect Phantom** and approve the extension's
connection request. ComFi uses Phantom's dedicated `window.phantom.solana`
provider when available, falling back to `window.solana` only if `isPhantom` is
true. Account changes and extension disconnects update the app automatically;
rejecting a request displays an error and leaves the wallet disconnected.

Set `VITE_SOLANA_RPC` to `http://127.0.0.1:8899`,
`https://api.devnet.solana.com`, or `https://api.testnet.solana.com` before starting
the web app. In Phantom, use **Settings → Developer Settings → Change Network**
(or **Testnet Mode**, depending on the extension version) to match that network.
For localnet, configure a custom RPC if your Phantom version supports it;
otherwise select the ComFi in-browser wallet. ComFi cannot switch or verify the
extension's selected network. This integration connects your public identity;
the current pool creation and initialization endpoints still require the mock
wallet and use the local development signer.

Provider API references: [Detecting Phantom](https://docs.phantom.com/solana/detecting-the-provider)
and [connection lifecycle](https://docs.phantom.com/solana/establishing-a-connection).

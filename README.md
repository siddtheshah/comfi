# ComFi

ComFi (Com - FI) is a Community Finance decentralized application that enables communities to pool
resources and make payments amongst each other, while authorizing members to have spend limits from
the community pool.

ComFi's priority is ensuring transparent transaction history to all participants in a pool, and enabling
the building of a trusted community without needing an expensive paid app.

## Key Usage

ComFi lets you keep track of your spending pools, which are pushed to blockchain. You can join or create
a pool, which has rules on its funding cycle and what is needed to remain a "funded member". Funded members get permissions and voting rights in regards to sending the spend limits of the authorized spenders.

The authorized spenders may take from the pool up to their spend limit on a given cycle. They are required to give justification by default, which can be scanned by all the members of the community. The community can then vote to raise or lower their spend limit by proposal, after seeing the spenders history of transactions with the justifications.

## Prototype workspace

The first implementation slice is organized as a small workspace:

- `apps/web` — responsive member workspace for viewing live on-chain pools, vault balances, activity, proposals, and payment requests.
- `services/sponsor-api` — bounded, short-lived sponsorship and enrollment quote service.
- `programs/comfi` — Anchor program that guards the pool USDC vault and governance flows. See the [Security Vulnerability & Audit Tracker](programs/comfi/README.md#security-vulnerability--audit-tracker) for actively tracked findings and remediation roadmap.


---

## Installation & Setup

For full installation requirements (Node.js 22+, Rust, Solana CLI, Anchor CLI, and WSL2 instructions), please read the comprehensive **[Installation Guide](file:///c:/Users/sidds/Documents/comfi/INSTALL.md)**.

### Quick Start (from scratch)

1. **Install dependencies**:
   ```shell
   npm install
   ```
2. **Configure environment**:
   ```shell
   cp .env.example .env
   ```
3. **Build the Anchor smart contract**:
   ```shell
   anchor build
   ```
4. **Bootstrap the isolated localnet validator and deployer**:
   ```shell
   npm run localnet:setup
   ```
   *This starts the validator on `http://127.0.0.1:8899`, deploys `programs/comfi`, initializes the USDC mint and treasury, and funds the development mock wallet.*
5. **Start the Web UI**:
   ```shell
   npm run dev
   ```
   *Open `http://localhost:5173` to view live on-chain pools, inspect contract parameters, and deploy new pools with **Start a pool**.*

---

## Validation & Testing

- `npm run test` — runs workspace unit tests (quote generation, member allowances, structured error handling).
- `npm run typecheck` — strict TypeScript verification across `@comfi/web` and `@comfi/sponsor-api`.
- `npm run test:e2e` — Playwright end-to-end tests validating mock wallet connections, on-chain pool inspections, proposals, and payment requests.


## Community Vigilance

As all transactions are persisted to blockchain, all transactions are visible. However, it is still the duty of the community to act on this information, and communicate properly to each other to ensure that
spending is legitimate. ComFi is a companion to group chats and community servers, not a replacement.

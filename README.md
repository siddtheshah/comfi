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

- `apps/web` — responsive member workspace for viewing pools, activity, proposals, and payment requests.
- `services/sponsor-api` — bounded, short-lived sponsorship and enrollment quote service.
- `programs/comfi` — Anchor program scaffold that guards the pool USDC vault and governance flows.

Run the web prototype with Node 22+:

```shell
npm install
npm run dev
```

Run validation with `npm run typecheck`, `npm run test`, and `npm run build`.
The Solana program additionally needs the Rust, Solana, and Anchor toolchains;
see `programs/comfi/README.md` before attempting a deployment.
Configure local toolchain paths by copying `.env.example` to `.env`.

## Localnet demo

For the complete UI-ready test chain, run:

```shell
npm run localnet:setup
```

It starts a reset isolated validator, creates and funds a temporary local deployment payer, builds and deploys ComFi, initializes the deployer, and funds the deterministic mock test wallet with local SOL and test USDC. It intentionally does not create a pool; use **Start a pool** in the UI to test that action. It refuses to reset an already-running validator.

`npm run localnet:start` remains available for manual validator control. The `localnet:create-test-pool` command creates a deterministic demo pool directly. Bootstrap output contains public addresses only and is written to ignored `localnet.json`.

Configuration for both the toolchain and web UI is read from `.env` (`VITE_WALLET_MODE`, `VITE_SOLANA_RPC`, `VITE_PROGRAM_ID`). Copy `.env.example` to `.env` to configure your environment.

Run `npm run test:e2e` to verify the mock-wallet, pool review, proposal, and payment-request journeys.

## Community Vigilance

As all transactions are persisted to blockchain, all transactions are visible. However, it is still the duty of the community to act on this information, and communicate properly to each other to ensure that
spending is legitimate. ComFi is a companion to group chats and community servers, not a replacement.

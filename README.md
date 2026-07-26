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

```powershell
npm install
npm run dev
```

Run validation with `npm run typecheck`, `npm run test`, and `npm run build`.
The Solana program additionally needs the Rust, Solana, and Anchor toolchains;
see `programs/comfi/README.md` before attempting a deployment.

## Community Vigilance

As all transactions are persisted to blockchain, all transactions are visible. However, it is still the duty of the community to act on this information, and communicate properly to each other to ensure that
spending is legitimate. ComFi is a companion to group chats and community servers, not a replacement.

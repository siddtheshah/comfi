# ComFi implementation map

The first vertical slice is intentionally divided into three boundaries:

| Component | Responsibility | Trust boundary |
| --- | --- | --- |
| `apps/web` | Member workspace, transaction construction, and presentation of authoritative state | Never holds user keys or bypasses program rules |
| `services/sponsor-api` | Issues short-lived, bounded, signed quotes for allowlisted actions | Cannot transfer pool funds; the program must verify every quote |
| `programs/comfi` | Enforces membership, governance, and USDC-vault movement | The sole authority over pooled USDC |

## Initial integration contract

The web client requests a quote before a sponsored action. The service returns
`quoteId`, `pool`, `member`, `action`, `chargeUsdc`, `expiresAt`, and a
signature. The client includes that result in the corresponding ComFi program
instruction. The program must independently verify the pool/member/action,
expiry, charge cap, allowance, and quote signer before moving a sponsorship
charge or executing the action.

Pool-fund movement only occurs through `deposit` and a validated
`request_withdrawal` → `spend` flow. The sponsor is deliberately not a signer
on a general pool-vault transfer.

## Local development

Node 22+ is installed in this environment. After package installation:

```powershell
npm install
npm run dev
npm run test
```

The Rust, Solana, and Anchor toolchains are not installed in this workspace,
so the on-chain program is provided as a reviewed scaffold and must be built in
a Solana/Anchor development environment before deployment.

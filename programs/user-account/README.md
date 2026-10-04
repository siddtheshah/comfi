# Standalone UserAccount bootstrap

This implements the **first localnet-only slice** of ADRs [0005](../comfi/adrs/0005-user-accounts-wallet-authority-and-social-verification.md) and [0006](../comfi/adrs/0006-passkey-user-account-administration-and-withdrawal-tickets.md): a separate `user_account` Anchor program that atomically creates a stable identity, its initial wallet link, and its initial passkey link. It neither calls nor deploys the ComFi pool program.

Creation requires the initial wallet's Solana transaction signature, an explicit fee payer's signature, validated ES256 enrollment data, and a P-256 possession assertion. The fee payer may differ from the wallet and gains no account permissions. Sequence zero is consumed by successful creation; an existing UserAccount cannot be recreated. No account-closing or authority-reset instructions exist.

## Run

From the repository root, install Node dependencies with `npm ci`. The scripts bootstrap the pinned Rust, Solana 3.1.10, and Anchor 1.1.2 tools into the existing ignored `.localnet-tools` cache.

```sh
# Fast client, mock, input-validation and signature tests (included in npm test).
npm run test:user-account

# Build, start an isolated validator, deploy just the account creator,
# check artifact identity and query the deployed program.
npm run user-account:test-deploy

# Same deployment plus one successful sponsored account creation and
# explicit failed creations/replay checks with on-chain state assertions.
npm run user-account:test-workflow

# Build without the testing feature and verify creation is rejected atomically.
npm run user-account:test-production
```

Deployment tests use loopback RPC port **18899**, faucet 18900, and validator ports 19000–19030. `USER_ACCOUNT_RPC_PORT` may override the RPC port. They refuse to replace an existing validator, create a temporary ledger/payer, and stop their own validator on exit. Successful tests remove the temporary files; failures retain a validator log and print its path. They do not initialize USDC, pools, or global ComFi configuration. `anchor build --program-name user_account` selects this program explicitly. The existing pool localnet setup selects `comfi` explicitly so adding a second workspace program does not change what that script deploys.

For a separately running local validator with this **testing** binary already deployed:

```sh
npm run user-account:create -- --rpc-url=http://127.0.0.1:8899 --payer=/path/to/localnet-payer.json --negative-tests
```

The payer must already hold local SOL. The workflow generates a disposable unfunded wallet and passkey in memory, prints only public addresses and a transaction signature, and verifies all accounts against the generated input. It does not persist their private keys: the resulting identity is a disposable test fixture, not an account for continued use. Loopback URL validation is a test-script guard, not proof of the remote cluster's genesis.

## Accounts and initial policy

| Account | Seeds | Bootstrap state |
| --- | --- | --- |
| `UserAccount` | `user`, immutable 32-byte creation ID | Version 1; one wallet/passkey; authority and wallet-link revisions 0; next sequence 1; empty profile reference |
| `WalletLink` | `wallet`, UserAccount, wallet public key | Active initial wallet, no primary role |
| `PasskeyLink` | `passkey`, UserAccount, SHA-256(credential ID) | Active compressed P-256 public key |

Links are separate fixed-size accounts; no unbounded credential arrays exist in the UserAccount. Reserved implementation limits are eight wallets and eight passkeys, for the later lifecycle slice. This version only creates one of each. A wallet may bootstrap multiple identities. Identical creation IDs resolve to the same identity regardless of wallet/passkey selection.

The narrow **test enrollment policy v1** uses RP ID `localhost`, origin `http://localhost:5173`, ES256/P-256, `attestation: none` semantics, UV and UP, a 32-byte credential ID, zero AAGUID and registration counter, canonical COSE EC2 encoding, and no extensions/backup flags. The program validates the actual curve point, RP hash, flags, CBOR key type/algorithm/curve, and credential length. This makes no device-provenance or hardware-bound claim. Nonzero registration counters, different credential-ID lengths, synced-credential flags, extensions, and arbitrary browser client-data encodings are deliberately unsupported by this first mock fixture.

Client data must be exactly UTF-8 JSON in this order, without whitespace:

```json
{"type":"webauthn.get","challenge":"<unpadded-base64url-32-byte-hash>","origin":"http://localhost:5173","crossOrigin":false}
```

`webauthn.create` uses the same encoding with a distinct type and enrollment challenge. The program constructs this registration client data itself; the possession assertion commits to its hash and the enrollment authenticator bytes. The mock generates both enrollment data and the corresponding assertion. This is **not a complete browser registration adapter**; a later adapter must supply validated browser registration responses under its own explicit policy rather than accept arbitrary client metadata.

The runtime's native `Secp256r1SigVerify1111111111111111111111111` precompile verifies a low-S, 64-byte P1363 signature over `authenticatorData || SHA-256(clientDataJSON)` using the compressed key. The account program requires an immediately preceding, single-signature, self-contained verification instruction, checks its key/message against the actual enrollment and assertion, and rejects cross-instruction offsets. A backend MFA statement cannot satisfy these checks. The workflow measures the signed serialized transaction against Solana's 1232-byte packet limit and executes on the pinned validator; this validates the initial mock policy's verifier and compute feasibility only.

## Canonical approval encoding

All integers are little-endian, amounts/timestamps use explicit units, and all hashes are SHA-256. Concatenate these fields in order:

1. UTF-8 `comfi:user-account:create:v1` followed by a zero byte.
2. Program public key (32 bytes).
3. Hash of UTF-8 `comfi:standalone:localnet:v1` (32 bytes): an explicit test cluster domain.
4. UserAccount, signing wallet, fee payer public keys (32 bytes each).
5. Immutable user ID (32 bytes), compressed credential key (33 bytes), hash of credential ID (32 bytes).
6. RP ID hash and origin hash (32 bytes each).
7. Enrollment policy version (`u16`, 1), authority revision (`u64`, 0), bootstrap sequence (`u64`, 0), expiry (`i64`, Unix seconds).

The registration challenge is SHA-256 of this payload. The possession challenge is SHA-256 of `comfi:user-account:possession:v1\0 || payload || SHA-256(registrationAuthenticatorData) || SHA-256(registrationClientDataJSON)`. The program reconstructs every field from actual accounts and arguments. The assertion's exact client data contains this challenge. Approval expiry must be strictly future and at most 300 seconds after on-chain time. Signature counters are not used for replay protection.

The fixed test cluster domain is not an on-chain genesis check. **Never deploy the testing binary or public localnet program keypair to a funded/public cluster.** The ordinary build rejects bootstrap with `LocalnetOnly`; production origins, cluster binding and enrollment remain unresolved. There is no runtime switch or mock-success flag that bypasses signature verification.

## Follow-up scope

Wallet/passkey enrollment/removal, revision increments on authority changes, profile updates, SIWS/SAS service consent, browser enrollment, withdrawal-ticket issuance/execution, and pool integration remain unimplemented. No existing pool authorization or payment paths have changed, and this slice does not claim ADR 0006 protection for those paths. The full ADRs remain Proposed. Production policy, broader enrollment support and lifecycle invariants must be implemented and verified before enabling a production account creator.

## Verification

Verified locally on 2026-10-04 with the pinned Solana/Anchor tools: 115 Node tests, five Rust tests, workspace typechecks, isolated deployment, successful sponsored creation, 17 rejected creation/replay cases, and ordinary-build LocalnetOnly rejection. The successful signed transaction was 1114 bytes and consumed 43319 compute units. Anchor emits the existing macro-generated unexpected-configuration warnings; build and IDL generation completed successfully. These results cover the mock enrollment/bootstrap policy only.

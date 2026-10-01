# ComFi localnet UI E2E task list


## 5. Sponsorship (follow-up; not required for core UI E2E)

- [ ] Add an actual HTTP host around `@comfi/sponsor-api`; it currently exports library logic only.
- [ ] Replace the local HMAC development signer with an Ed25519 signer that signs the exact Borsh `SponsorQuote` bytes required by `run_sponsored_set_alias`.
- [ ] Add a localnet-backed policy repository that reads finalized pool/member state.
- [ ] Add an Anchor integration test for the preceding Ed25519 verification instruction and sponsored alias update.

## 6. Verification

- [ ] Add a program integration test that bootstraps localnet and verifies global initialization, pool creation, join/deposit, proposal/vote, and withdrawal-request flows.
- [ ] Keep production deployment out of scope until separate wallet, treasury, audit, and integration-test plans are approved.


import assert from "node:assert/strict";
import test from "node:test";
import { canonicalQuote, createSponsorApi, HmacSha256QuoteSigner, InMemorySponsorPolicyRepository, SponsorQuoteService } from "../src/index.js";

const pool = "11111111111111111111111111111111";
const member = "SysvarRent111111111111111111111111111111111";
const treasury = "So11111111111111111111111111111111111111112";
function setup(actionCharge = "900") {
  const policies = new InMemorySponsorPolicyRepository();
  policies.upsertPool({ pool, treasuryUsdcAccount: treasury, sponsoredEnrollmentSlots: 2, memberCap: 10, currentMemberCount: 3, minimumJoinDepositAtomic: "1000000", actionAllowanceRemainingAtomicByMember: { [member]: "5000" }, actionChargeCapAtomicByKind: { set_alias: "2000" } });
  const signer = new HmacSha256QuoteSigner("test-secret", "ComFiQuoteAuthority");
  const service = new SponsorQuoteService({ programId: pool, signer, policies, actionPricing: { chargeFor: () => actionCharge }, enrollmentPricing: { quoteCapacityIncrease: ({ additionalSponsoredSlots }) => String(additionalSponsoredSlots * 250000) }, now: () => new Date("2026-07-26T12:00:00.000Z"), nextQuoteId: () => "quote-1" });
  return { service, signer, policies };
}

test("issues a bound, signed sponsored-action quote", async () => {
  const { service, signer } = setup();
  const signed = await service.issueActionQuote({ pool, member, action: "set_alias", actionDigest: "a".repeat(64) });
  assert.equal(signed.quote.expiresAt, "2026-07-26T12:01:30.000Z");
  assert.equal(signed.quote.chargeUsdc, "900");
  assert.equal(await signer.verify!(canonicalQuote(signed.quote), signed.signature), true);
});

test("refuses action quotes above the member allowance", async () => {
  const { service } = setup("6000");
  await assert.rejects(() => service.issueActionQuote({ pool, member, action: "set_alias", actionDigest: "b".repeat(64) }), { code: "POLICY_DENIED" });
});

test("issues a capacity-enrollment fee quote and HTTP errors are structured", async () => {
  const { service } = setup();
  const quote = await service.issueEnrollmentQuote({ operation: "increase_member_cap", pool, requestedMemberCap: 14, additionalSponsoredSlots: 4 });
  assert.equal(quote.quote.operation, "increase_member_cap");
  if (quote.quote.operation !== "increase_member_cap") throw new Error("expected a capacity enrollment quote");
  assert.equal(quote.quote.enrollmentFeeAtomic, "1000000");
  const api = createSponsorApi(service);
  const response = await api({ method: "POST", path: "/v1/quotes/actions", body: { pool, member, action: "set_alias", actionDigest: "not-a-digest" } });
  assert.equal(response.status, 422);
});

test("HTTP action response exposes the shared integration fields at top level", async () => {
  const { service } = setup();
  const api = createSponsorApi(service);
  const response = await api({ method: "POST", path: "/v1/quotes/actions", body: { pool, member, action: "set_alias", actionDigest: "c".repeat(64) } });
  assert.equal(response.status, 201);
  const body = response.body as Record<string, unknown>;
  for (const field of ["quoteId", "pool", "member", "action", "chargeUsdc", "expiresAt", "signature"]) assert.ok(field in body);
  assert.equal(body.chargeUsdc, "900");
});

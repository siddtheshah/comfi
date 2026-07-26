import { randomUUID } from "node:crypto";
import { canonicalQuote } from "./canonical.js";
import {
  type ActionQuoteRequest,
  type AtomicUsdc,
  type CapacityEnrollmentQuote,
  type EnrollmentQuoteRequest,
  type JoinEnrollmentQuote,
  type Quote,
  type SignedQuote,
  type SponsorServiceOptions,
  SponsorError,
  type SponsoredActionQuote,
} from "./types.js";

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/i;
const atomic = (value: AtomicUsdc, field: string): bigint => {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new SponsorError("INVALID_REQUEST", `${field} must be an unsigned atomic-USDC integer`);
  return BigInt(value);
};
const address = (value: string, field: string): void => {
  if (!BASE58_ADDRESS.test(value)) throw new SponsorError("INVALID_REQUEST", `${field} must be a Solana base58 address`);
};

export class SponsorQuoteService {
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly nextQuoteId: () => string;

  constructor(private readonly options: SponsorServiceOptions) {
    address(options.programId, "programId");
    this.ttlMs = (options.quoteTtlSeconds ?? 90) * 1_000;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 15 * 60_000) {
      throw new Error("quoteTtlSeconds must be between 1 and 900 seconds");
    }
    this.now = options.now ?? (() => new Date());
    this.nextQuoteId = options.nextQuoteId ?? randomUUID;
  }

  async issueActionQuote(request: ActionQuoteRequest): Promise<SignedQuote<SponsoredActionQuote>> {
    address(request.pool, "pool");
    address(request.member, "member");
    if (!HEX_DIGEST.test(request.actionDigest)) throw new SponsorError("INVALID_REQUEST", "actionDigest must be a SHA-256 hex digest");
    const policy = await this.poolOrThrow(request.pool);
    const cap = policy.actionChargeCapAtomicByKind[request.action];
    const remaining = policy.actionAllowanceRemainingAtomicByMember[request.member];
    if (cap === undefined || remaining === undefined) throw new SponsorError("POLICY_DENIED", "member or action is not eligible for sponsorship");
    const charge = this.options.actionPricing.chargeFor(request.action);
    if (atomic(charge, "charge") > atomic(cap, "action charge cap") || atomic(charge, "charge") > atomic(remaining, "remaining action allowance")) {
      throw new SponsorError("POLICY_DENIED", "quoted charge exceeds the on-chain policy snapshot");
    }
    const quote: SponsoredActionQuote = {
      ...this.base(policy.treasuryUsdcAccount), type: "sponsored_action", pool: request.pool, member: request.member,
      action: request.action, actionDigest: request.actionDigest.toLowerCase(), chargeUsdc: charge,
    };
    return this.sign(quote);
  }

  async issueEnrollmentQuote(request: EnrollmentQuoteRequest): Promise<SignedQuote<JoinEnrollmentQuote | CapacityEnrollmentQuote>> {
    address(request.pool, "pool");
    const policy = await this.poolOrThrow(request.pool);
    if (request.operation === "join_pool") return this.issueJoinQuote(request, policy);
    return this.issueCapacityQuote(request, policy);
  }

  private async issueJoinQuote(request: Extract<EnrollmentQuoteRequest, { operation: "join_pool" }>, policy: Awaited<ReturnType<SponsorQuoteService["poolOrThrow"]>>): Promise<SignedQuote<JoinEnrollmentQuote>> {
    address(request.member, "member");
    if (policy.sponsoredEnrollmentSlots < 1 || policy.currentMemberCount >= policy.memberCap) throw new SponsorError("POLICY_DENIED", "pool has no sponsored enrollment capacity");
    const hasDeposit = atomic(request.proposedDepositAtomic, "proposedDeposit") >= atomic(policy.minimumJoinDepositAtomic, "minimumJoinDeposit");
    const invitationApproved = request.invitationId && this.options.policies.isInvitationApproved
      ? await this.options.policies.isInvitationApproved(request.pool, request.invitationId, request.member)
      : false;
    if (!hasDeposit && !invitationApproved) throw new SponsorError(request.invitationId ? "INVITATION_NOT_APPROVED" : "POLICY_DENIED", "joining requires the minimum deposit or an approved invitation");
    return this.sign({
      ...this.base(policy.treasuryUsdcAccount), type: "enrollment", operation: "join_pool", pool: request.pool,
      member: request.member, createUsdcAta: request.createUsdcAta, minimumDepositAtomic: policy.minimumJoinDepositAtomic,
      ...(invitationApproved && request.invitationId ? { invitationId: request.invitationId } : {}),
    });
  }

  private async issueCapacityQuote(request: Extract<EnrollmentQuoteRequest, { operation: "increase_member_cap" }>, policy: Awaited<ReturnType<SponsorQuoteService["poolOrThrow"]>>): Promise<SignedQuote<CapacityEnrollmentQuote>> {
    if (!Number.isSafeInteger(request.requestedMemberCap) || request.requestedMemberCap <= policy.memberCap) throw new SponsorError("INVALID_REQUEST", "requestedMemberCap must increase the current cap");
    if (!Number.isSafeInteger(request.additionalSponsoredSlots) || request.additionalSponsoredSlots < 1 || request.additionalSponsoredSlots > request.requestedMemberCap - policy.memberCap) throw new SponsorError("INVALID_REQUEST", "additionalSponsoredSlots must fit the capacity increase");
    const enrollmentFeeAtomic = this.options.enrollmentPricing.quoteCapacityIncrease({ currentMemberCap: policy.memberCap, requestedMemberCap: request.requestedMemberCap, additionalSponsoredSlots: request.additionalSponsoredSlots });
    atomic(enrollmentFeeAtomic, "enrollmentFee");
    return this.sign({
      ...this.base(policy.treasuryUsdcAccount), type: "enrollment", operation: "increase_member_cap", pool: request.pool,
      requestedMemberCap: request.requestedMemberCap, additionalSponsoredSlots: request.additionalSponsoredSlots, enrollmentFeeAtomic,
    });
  }

  private async poolOrThrow(pool: string) {
    const policy = await this.options.policies.getPool(pool);
    if (!policy) throw new SponsorError("POOL_NOT_FOUND", "pool policy was not found");
    address(policy.treasuryUsdcAccount, "treasuryUsdcAccount");
    return policy;
  }

  private base(treasuryUsdcAccount: string) {
    const issued = this.now();
    return { quoteId: this.nextQuoteId(), version: 1 as const, chain: "solana" as const, programId: this.options.programId, treasuryUsdcAccount, issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + this.ttlMs).toISOString(), signer: this.options.signer.publicKey };
  }

  private async sign<T extends Quote>(quote: T): Promise<SignedQuote<T>> {
    return { quote, signature: await this.options.signer.sign(canonicalQuote(quote)) };
  }
}

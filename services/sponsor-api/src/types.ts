/** Atomic native-USDC units (six decimal places), represented as a decimal string. */
export type AtomicUsdc = string;

/**
 * V0 allowlist. The Anchor scaffold currently implements only the matching
 * `run_sponsored_set_alias` instruction; add an action here only alongside an
 * on-chain verifier and integration test for it.
 */
export type ActionKind = "set_alias";

export type EnrollmentOperation = "join_pool" | "increase_member_cap";

export interface PoolSponsorPolicy {
  pool: string;
  treasuryUsdcAccount: string;
  /** The Pool PDA's current sponsored-enrollment capacity. */
  sponsoredEnrollmentSlots: number;
  memberCap: number;
  currentMemberCount: number;
  /** Minimum native-USDC deposit needed when no approved invitation is supplied. */
  minimumJoinDepositAtomic: AtomicUsdc;
  actionAllowanceRemainingAtomicByMember: Readonly<Record<string, AtomicUsdc>>;
  actionChargeCapAtomicByKind: Readonly<Partial<Record<ActionKind, AtomicUsdc>>>;
}

export interface ActionQuoteRequest {
  pool: string;
  member: string;
  action: ActionKind;
  /** Hash of the typed action's canonical arguments, never arbitrary transaction bytes. */
  actionDigest: string;
}

export interface JoinEnrollmentQuoteRequest {
  operation: "join_pool";
  pool: string;
  member: string;
  /** A verified invitation identifier, if joining without the minimum deposit. */
  invitationId?: string;
  proposedDepositAtomic: AtomicUsdc;
  createUsdcAta: boolean;
}

export interface CapacityEnrollmentQuoteRequest {
  operation: "increase_member_cap";
  pool: string;
  requestedMemberCap: number;
  additionalSponsoredSlots: number;
}

export type EnrollmentQuoteRequest =
  | JoinEnrollmentQuoteRequest
  | CapacityEnrollmentQuoteRequest;

export interface QuoteBase {
  quoteId: string;
  version: 1;
  chain: "solana";
  programId: string;
  treasuryUsdcAccount: string;
  issuedAt: string;
  expiresAt: string;
  signer: string;
}

export interface SponsoredActionQuote extends QuoteBase {
  type: "sponsored_action";
  pool: string;
  member: string;
  action: ActionKind;
  actionDigest: string;
  /** Native USDC atomic units (six decimal places). */
  chargeUsdc: AtomicUsdc;
}

export interface JoinEnrollmentQuote extends QuoteBase {
  type: "enrollment";
  operation: "join_pool";
  pool: string;
  member: string;
  createUsdcAta: boolean;
  minimumDepositAtomic: AtomicUsdc;
  invitationId?: string;
}

export interface CapacityEnrollmentQuote extends QuoteBase {
  type: "enrollment";
  operation: "increase_member_cap";
  pool: string;
  requestedMemberCap: number;
  additionalSponsoredSlots: number;
  enrollmentFeeAtomic: AtomicUsdc;
}

export type Quote = SponsoredActionQuote | JoinEnrollmentQuote | CapacityEnrollmentQuote;

export interface SignedQuote<T extends Quote = Quote> {
  quote: T;
  /** Detached signature over the canonical quote payload. */
  signature: string;
}

/** Wire shape consumed by `apps/web` and included in `run_sponsored_action`. */
export type SponsoredActionQuoteResponse = SponsoredActionQuote & { signature: string };

export interface QuoteSigner {
  readonly publicKey: string;
  sign(canonicalPayload: string): Promise<string>;
  verify?(canonicalPayload: string, signature: string): Promise<boolean>;
}

export interface SponsorPolicyRepository {
  getPool(pool: string): Promise<PoolSponsorPolicy | undefined>;
  isInvitationApproved?(pool: string, invitationId: string, member: string): Promise<boolean>;
}

export interface ActionPricing {
  chargeFor(action: ActionKind): AtomicUsdc;
}

export interface EnrollmentPricing {
  quoteCapacityIncrease(input: {
    currentMemberCap: number;
    requestedMemberCap: number;
    additionalSponsoredSlots: number;
  }): AtomicUsdc;
}

export interface SponsorServiceOptions {
  programId: string;
  signer: QuoteSigner;
  policies: SponsorPolicyRepository;
  actionPricing: ActionPricing;
  enrollmentPricing: EnrollmentPricing;
  quoteTtlSeconds?: number;
  now?: () => Date;
  nextQuoteId?: () => string;
}

export class SponsorError extends Error {
  constructor(
    public readonly code:
      | "INVALID_REQUEST"
      | "POOL_NOT_FOUND"
      | "POLICY_DENIED"
      | "INVITATION_NOT_APPROVED",
    message: string,
  ) {
    super(message);
    this.name = "SponsorError";
  }
}

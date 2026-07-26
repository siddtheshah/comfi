import type { PoolSponsorPolicy, SponsorPolicyRepository } from "./types.js";

/** Local/test repository. Replace with an indexer-backed, finalized-chain reader in production. */
export class InMemorySponsorPolicyRepository implements SponsorPolicyRepository {
  private readonly pools = new Map<string, PoolSponsorPolicy>();
  private readonly invitations = new Set<string>();

  upsertPool(policy: PoolSponsorPolicy): void { this.pools.set(policy.pool, policy); }
  approveInvitation(pool: string, invitationId: string, member: string): void { this.invitations.add(`${pool}:${invitationId}:${member}`); }
  async getPool(pool: string): Promise<PoolSponsorPolicy | undefined> { return this.pools.get(pool); }
  async isInvitationApproved(pool: string, invitationId: string, member: string): Promise<boolean> { return this.invitations.has(`${pool}:${invitationId}:${member}`); }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearInvitations,
  createInvitation,
  decodeInvitationPayload,
  dispatchAdmitMemberProposal,
  encodeInvitationPayload,
  executeAdmission,
  generateInvitationEmailMessage,
  generateShareUrl,
  getInvitationsForPool,
  onInvitationWebhook,
  revokeInvitation,
  submitRecipientWallet,
  validateSolanaAddress,
} from '../src/invitation-engine.ts'
import type { InvitationPayload } from '../src/invitation-types.ts'

const VALID_POOL_ADDR = 'H3hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M'
const VALID_INVITER_ADDR = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB'
const VALID_CANDIDATE_ADDR = 'BVVfYV2AD4KsGWTF3zge1wfH9sb54he1M83UBWazwrNX'

test('validateSolanaAddress accepts valid Solana Base58 public keys', () => {
  const result1 = validateSolanaAddress(VALID_POOL_ADDR, 'poolAddress')
  assert.equal(result1, VALID_POOL_ADDR)

  const result2 = validateSolanaAddress(VALID_INVITER_ADDR, 'inviterAddress')
  assert.equal(result2, VALID_INVITER_ADDR)
})

test('validateSolanaAddress escalates on empty, missing, or invalid types without evasion', () => {
  assert.throws(
    () => validateSolanaAddress('', 'poolAddress'),
    { message: /Missing or empty poolAddress/ }
  )
  assert.throws(
    () => validateSolanaAddress(null, 'poolAddress'),
    { message: /Missing or empty poolAddress/ }
  )
  assert.throws(
    () => validateSolanaAddress(undefined, 'poolAddress'),
    { message: /Missing or empty poolAddress/ }
  )
})

test('validateSolanaAddress escalates on invalid Base58 characters or illegal lengths', () => {
  // Contains '0' (illegal Base58 character)
  assert.throws(
    () => validateSolanaAddress('03hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M', 'poolAddress'),
    { message: /Invalid poolAddress/ }
  )
  // Contains 'I' (illegal Base58 character)
  assert.throws(
    () => validateSolanaAddress('I3hTVqczBEqDXw4CPNVXnEdeFSNz1jgY7W2oqMVspm9M', 'poolAddress'),
    { message: /Invalid poolAddress/ }
  )
  // Too short
  assert.throws(
    () => validateSolanaAddress('ShortKey123', 'candidateWallet'),
    { message: /Invalid candidateWallet/ }
  )
})

test('encodeInvitationPayload and decodeInvitationPayload correctly round-trip valid payloads', () => {
  const payload: InvitationPayload = {
    inviteId: 'inv_test_100',
    poolAddress: VALID_POOL_ADDR,
    poolName: 'Community Mutual Aid',
    inviterAddress: VALID_INVITER_ADDR,
    inviterName: 'Jordan R.',
    admissionMode: 'InviteVouched',
    memberObligationAmount: '$25.00',
    cycleDurationDays: 30,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    note: 'Welcome to our circle!',
  }

  const token = encodeInvitationPayload(payload)
  assert.equal(typeof token, 'string')
  assert.ok(token.length > 20)

  const decoded = decodeInvitationPayload(token)
  assert.equal(decoded.inviteId, payload.inviteId)
  assert.equal(decoded.poolAddress, payload.poolAddress)
  assert.equal(decoded.poolName, payload.poolName)
  assert.equal(decoded.inviterAddress, payload.inviterAddress)
  assert.equal(decoded.inviterName, payload.inviterName)
  assert.equal(decoded.admissionMode, 'InviteVouched')
  assert.equal(decoded.memberObligationAmount, '$25.00')
  assert.equal(decoded.note, 'Welcome to our circle!')
})

test('encodeInvitationPayload escalates on missing or invalid required payload fields', () => {
  assert.throws(
    () => encodeInvitationPayload(null as any),
    { message: /Missing invitation payload/ }
  )
  assert.throws(
    () => encodeInvitationPayload({
      inviteId: '',
      poolAddress: VALID_POOL_ADDR,
      poolName: 'Pool',
      inviterAddress: VALID_INVITER_ADDR,
      admissionMode: 'InviteVouched',
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    }),
    { message: /inviteId must be a non-empty string/ }
  )
  assert.throws(
    () => encodeInvitationPayload({
      inviteId: 'inv_1',
      poolAddress: 'invalid-pool',
      poolName: 'Pool',
      inviterAddress: VALID_INVITER_ADDR,
      admissionMode: 'InviteVouched',
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    }),
    { message: /Invalid payload.poolAddress/ }
  )
})

test('decodeInvitationPayload escalates on empty token or expired invitation', () => {
  assert.throws(
    () => decodeInvitationPayload(''),
    { message: /token must be a non-empty string/ }
  )

  const expiredPayload: InvitationPayload = {
    inviteId: 'inv_expired',
    poolAddress: VALID_POOL_ADDR,
    poolName: 'Old Pool',
    inviterAddress: VALID_INVITER_ADDR,
    admissionMode: 'InviteVouched',
    createdAt: new Date(Date.now() - 14 * 86400 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 7 * 86400 * 1000).toISOString(),
  }
  const expiredToken = encodeInvitationPayload(expiredPayload)

  assert.throws(
    () => decodeInvitationPayload(expiredToken),
    { message: /Invitation expired/ }
  )
})

test('generateShareUrl creates a clean URL and escalates on empty token', () => {
  assert.throws(
    () => generateShareUrl(''),
    { message: /Invitation token must be a non-empty string/ }
  )

  const url = generateShareUrl('token123', 'http://127.0.0.1:5173')
  assert.equal(url, 'http://127.0.0.1:5173/?invite=token123')
})

test('generateInvitationEmailMessage formats email correctly and escalates on missing fields', () => {
  assert.throws(
    () => generateInvitationEmailMessage({
      poolName: '',
      poolAddress: VALID_POOL_ADDR,
      inviterAddress: VALID_INVITER_ADDR,
      shareUrl: 'http://test/?invite=xyz',
      admissionMode: 'InviteVouched',
    }),
    { message: /Missing poolName/ }
  )

  const message = generateInvitationEmailMessage({
    poolName: 'Mutual Aid Fund',
    poolAddress: VALID_POOL_ADDR,
    inviterAddress: VALID_INVITER_ADDR,
    inviterName: 'Alice',
    shareUrl: 'http://localhost:5173/?invite=abc',
    admissionMode: 'InviteVouched',
    memberObligationAmount: '$50.00',
    cycleDurationDays: 14,
    note: 'Glad to have you join!',
  })

  assert.ok(message.includes("You're invited to join Mutual Aid Fund"))
  assert.ok(message.includes(VALID_POOL_ADDR))
  assert.ok(message.includes('Alice'))
  assert.ok(message.includes('http://localhost:5173/?invite=abc'))
  assert.ok(message.includes('AdmitMember governance proposal'))
})

test('createInvitation generates complete record and persists in storage', () => {
  clearInvitations()

  const record = createInvitation({
    poolAddress: VALID_POOL_ADDR,
    poolName: 'Tech Co-op Fund',
    inviterAddress: VALID_INVITER_ADDR,
    inviterName: 'Creator',
    admissionMode: 'InviteVouched',
    expiresInDays: 7,
    memberObligationAmount: '$10.00',
    cycleDurationDays: 30,
    baseUrl: 'http://localhost:5173',
  })

  assert.ok(record.inviteId.startsWith('inv_'))
  assert.equal(record.status, 'pending_submission')
  assert.equal(record.poolAddress, VALID_POOL_ADDR)
  assert.equal(record.inviterAddress, VALID_INVITER_ADDR)
  assert.ok(record.shareUrl.includes('?invite='))
  assert.ok(record.emailMessage.includes('Tech Co-op Fund'))

  const poolInvites = getInvitationsForPool(VALID_POOL_ADDR)
  assert.equal(poolInvites.length, 1)
  assert.equal(poolInvites[0].inviteId, record.inviteId)
})

test('createInvitation escalates on invalid arguments', () => {
  assert.throws(
    () => createInvitation({
      poolAddress: '',
      poolName: 'Valid Name',
      inviterAddress: VALID_INVITER_ADDR,
    }),
    { message: /Missing or empty poolAddress/ }
  )

  assert.throws(
    () => createInvitation({
      poolAddress: VALID_POOL_ADDR,
      poolName: '',
      inviterAddress: VALID_INVITER_ADDR,
    }),
    { message: /poolName must be a non-empty string/ }
  )

  assert.throws(
    () => createInvitation({
      poolAddress: VALID_POOL_ADDR,
      poolName: 'Pool',
      inviterAddress: VALID_INVITER_ADDR,
      expiresInDays: 0,
    }),
    { message: /expiresInDays must be a positive number/ }
  )
})

test('submitRecipientWallet triggers automated webhook pipeline and dispatches AdmitMember proposal', async () => {
  clearInvitations()

  const invite = createInvitation({
    poolAddress: VALID_POOL_ADDR,
    poolName: 'Neighborhood Savings',
    inviterAddress: VALID_INVITER_ADDR,
    inviterName: 'Bob',
    admissionMode: 'InviteVouched',
  })

  // Register webhook listener to assert automated event emission
  let receivedEvent: any = null
  const unsub = onInvitationWebhook((event) => {
    receivedEvent = event
  })

  const { record, webhookResult } = await submitRecipientWallet(
    invite.inviteId,
    VALID_CANDIDATE_ADDR,
    'Candidate Maya'
  )

  unsub()

  // Verify webhook listener triggered
  assert.ok(receivedEvent)
  assert.equal(receivedEvent.type, 'INVITE_WALLET_SUBMITTED')
  assert.equal(receivedEvent.candidateWallet, VALID_CANDIDATE_ADDR)
  assert.equal(receivedEvent.candidateName, 'Candidate Maya')
  assert.equal(receivedEvent.inviterAddress, VALID_INVITER_ADDR)

  // Verify proposal dispatch result
  assert.equal(webhookResult.success, true)
  assert.equal(webhookResult.actionType, 'AdmitMember')
  assert.equal(webhookResult.candidateWallet, VALID_CANDIDATE_ADDR)
  assert.equal(webhookResult.vouchedBy, VALID_INVITER_ADDR)
  assert.ok(webhookResult.proposalId >= 100)

  // Verify updated invitation record state
  assert.equal(record.status, 'proposal_queued')
  assert.equal(record.candidateWallet, VALID_CANDIDATE_ADDR)
  assert.equal(record.candidateName, 'Candidate Maya')
  assert.equal(record.proposalId, webhookResult.proposalId)
  assert.ok(record.webhookDispatchedAt)
})

test('submitRecipientWallet escalates on non-existent inviteId or invalid candidate wallet', async () => {
  await assert.rejects(
    async () => {
      await submitRecipientWallet('inv_non_existent', VALID_CANDIDATE_ADDR)
    },
    { message: /Invitation not found for ID/ }
  )

  clearInvitations()
  const invite = createInvitation({
    poolAddress: VALID_POOL_ADDR,
    poolName: 'Pool',
    inviterAddress: VALID_INVITER_ADDR,
  })

  await assert.rejects(
    async () => {
      await submitRecipientWallet(invite.inviteId, 'InvalidAddress000')
    },
    { message: /Invalid candidateWallet/ }
  )
})

test('submitRecipientWallet escalates when candidate wallet is identical to inviter', async () => {
  clearInvitations()
  const invite = createInvitation({
    poolAddress: VALID_POOL_ADDR,
    poolName: 'Pool',
    inviterAddress: VALID_INVITER_ADDR,
  })

  await assert.rejects(
    async () => {
      await submitRecipientWallet(invite.inviteId, VALID_INVITER_ADDR)
    },
    { message: /Candidate wallet cannot be identical to the inviter address/ }
  )
})

test('executeAdmission transitions status to admitted and escalates on invalid operations', async () => {
  clearInvitations()
  const invite = createInvitation({
    poolAddress: VALID_POOL_ADDR,
    poolName: 'Pool',
    inviterAddress: VALID_INVITER_ADDR,
  })

  // Cannot admit before wallet is submitted
  await assert.rejects(
    async () => {
      await executeAdmission(invite.inviteId)
    },
    { message: /candidate wallet has not been submitted/ }
  )

  await submitRecipientWallet(invite.inviteId, VALID_CANDIDATE_ADDR)

  // Execute admission
  const admitted = await executeAdmission(invite.inviteId)
  assert.equal(admitted.status, 'admitted')
  assert.ok(admitted.executedAt)

  // Calling again returns already admitted record idempotently
  const idempotent = await executeAdmission(invite.inviteId)
  assert.equal(idempotent.status, 'admitted')

  // Cannot revoke an admitted invitation
  assert.throws(
    () => revokeInvitation(invite.inviteId),
    { message: /Cannot revoke an invitation that has already been admitted/ }
  )
})

test('revokeInvitation marks record as revoked and prevents further submissions', async () => {
  clearInvitations()
  const invite = createInvitation({
    poolAddress: VALID_POOL_ADDR,
    poolName: 'Pool',
    inviterAddress: VALID_INVITER_ADDR,
  })

  const revoked = revokeInvitation(invite.inviteId)
  assert.equal(revoked.status, 'revoked')

  await assert.rejects(
    async () => {
      await submitRecipientWallet(invite.inviteId, VALID_CANDIDATE_ADDR)
    },
    { message: /This invitation has been revoked by the inviter/ }
  )

  await assert.rejects(
    async () => {
      await executeAdmission(invite.inviteId)
    },
    { message: /Cannot execute admission for a revoked invitation/ }
  )
})

test('dispatchAdmitMemberProposal escalates on malformed event kind or missing fields', async () => {
  await assert.rejects(
    async () => {
      await dispatchAdmitMemberProposal({} as any)
    },
    { message: /Invalid webhook event: expected INVITE_WALLET_SUBMITTED/ }
  )

  await assert.rejects(
    async () => {
      await dispatchAdmitMemberProposal({
        type: 'INVITE_WALLET_SUBMITTED',
        inviteId: '',
        poolAddress: VALID_POOL_ADDR,
        candidateWallet: VALID_CANDIDATE_ADDR,
        inviterAddress: VALID_INVITER_ADDR,
        submittedAt: new Date().toISOString(),
      })
    },
    { message: /Missing inviteId in webhook event/ }
  )
})

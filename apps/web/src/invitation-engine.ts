import type {
  AdmissionMode,
  AdmitMemberProposalDispatchResult,
  InvitationPayload,
  InvitationRecord,
  InvitationStatus,
  InvitationWebhookEvent,
} from './invitation-types'

const INVITATIONS_STORAGE_KEY = 'comfi_member_invitations'
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/**
 * Strictly validates a Solana Base58 public key.
 * Escalates immediately on invalid or missing input without evasion.
 */
export function validateSolanaAddress(address: unknown, fieldName: string): string {
  if (typeof address !== 'string' || address.trim().length === 0) {
    throw new Error(`Missing or empty ${fieldName}. Expected a valid 32-44 character Base58 Solana public key.`)
  }
  const trimmed = address.trim()
  if (!BASE58_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: '${address}'. Expected a valid 32-44 character Base58 Solana public key.`)
  }
  return trimmed
}

/**
 * Storage helpers for browser localStorage with in-memory fallback for test environments.
 */
let memoryStorage: Record<string, InvitationRecord> = {}

type ChangeListener = () => void
const changeListeners = new Set<ChangeListener>()

/**
 * Registers a callback whenever invitations are updated or saved.
 * Returns an unregister function. Escalates if listener is not a function.
 */
export function onInvitationsChange(listener: ChangeListener): () => void {
  if (typeof listener !== 'function') {
    throw new Error('listener must be a function')
  }
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function loadInvitations(): Record<string, InvitationRecord> {
  if (typeof window !== 'undefined' && window.localStorage) {
    const raw = window.localStorage.getItem(INVITATIONS_STORAGE_KEY)
    if (raw) {
      return JSON.parse(raw) as Record<string, InvitationRecord>
    }
    return {}
  }
  return { ...memoryStorage }
}

export function saveInvitations(records: Record<string, InvitationRecord>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(INVITATIONS_STORAGE_KEY, JSON.stringify(records))
  }
  memoryStorage = { ...records }
  for (const listener of changeListeners) {
    listener()
  }
}

export function clearInvitations(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(INVITATIONS_STORAGE_KEY)
  }
  memoryStorage = {}
  for (const listener of changeListeners) {
    listener()
  }
}

export function getInvitationsForPool(poolAddress: string): InvitationRecord[] {
  const validatedPool = validateSolanaAddress(poolAddress, 'poolAddress')
  const all = loadInvitations()
  return Object.values(all)
    .filter(inv => inv.poolAddress === validatedPool)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i])
  }
  const b64 = btoa(bin)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(b64url: string): string {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) {
    b64 += '='
  }
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Encodes an invitation payload into a URL-safe Base64 token.
 */
export function encodeInvitationPayload(payload: InvitationPayload): string {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing invitation payload')
  }
  validateSolanaAddress(payload.poolAddress, 'payload.poolAddress')
  validateSolanaAddress(payload.inviterAddress, 'payload.inviterAddress')
  if (!payload.inviteId || typeof payload.inviteId !== 'string') {
    throw new Error('payload.inviteId must be a non-empty string')
  }
  if (!payload.poolName || typeof payload.poolName !== 'string') {
    throw new Error('payload.poolName must be a non-empty string')
  }

  const jsonString = JSON.stringify(payload)
  return toBase64Url(jsonString)
}

/**
 * Decodes and validates a URL-safe Base64 invitation token.
 * Escalates on corrupted, malformed, or expired tokens.
 */
export function decodeInvitationPayload(token: string): InvitationPayload {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('Invitation token must be a non-empty string')
  }

  const jsonString = fromBase64Url(token)
  const parsed = JSON.parse(jsonString)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid invitation payload: not an object')
  }

  validateSolanaAddress(parsed.poolAddress, 'payload.poolAddress')
  validateSolanaAddress(parsed.inviterAddress, 'payload.inviterAddress')
  if (!parsed.inviteId || typeof parsed.inviteId !== 'string') {
    throw new Error('Decoded payload is missing inviteId')
  }
  if (!parsed.poolName || typeof parsed.poolName !== 'string') {
    throw new Error('Decoded payload is missing poolName')
  }
  if (!parsed.createdAt || typeof parsed.createdAt !== 'string') {
    throw new Error('Decoded payload is missing createdAt')
  }
  if (!parsed.expiresAt || typeof parsed.expiresAt !== 'string') {
    throw new Error('Decoded payload is missing expiresAt')
  }

  const expiresTime = new Date(parsed.expiresAt).getTime()
  if (isNaN(expiresTime)) {
    throw new Error(`Decoded payload has invalid expiresAt: ${parsed.expiresAt}`)
  }

  if (Date.now() > expiresTime) {
    throw new Error(`Invitation expired on ${new Date(expiresTime).toISOString()}`)
  }

  return parsed as InvitationPayload
}

/**
 * Generates the sharable link for an invitation token.
 */
export function generateShareUrl(token: string, baseUrl?: string): string {
  if (!token || typeof token !== 'string') {
    throw new Error('Invitation token must be a non-empty string')
  }
  let origin = baseUrl
  if (!origin) {
    if (typeof window !== 'undefined' && window.location?.origin) {
      origin = window.location.origin
    } else {
      origin = 'http://localhost:5173'
    }
  }
  return `${origin.replace(/\/$/, '')}/?invite=${encodeURIComponent(token)}`
}

/**
 * Generates a structured email/message template for inviting candidates.
 */
export function generateInvitationEmailMessage(params: {
  poolName: string
  poolAddress: string
  inviterAddress: string
  inviterName?: string
  candidateName?: string
  shareUrl: string
  admissionMode: AdmissionMode
  memberObligationAmount?: string
  cycleDurationDays?: number
  note?: string
}): string {
  validateSolanaAddress(params.poolAddress, 'poolAddress')
  validateSolanaAddress(params.inviterAddress, 'inviterAddress')
  if (!params.poolName) throw new Error('Missing poolName for invitation message')
  if (!params.shareUrl) throw new Error('Missing shareUrl for invitation message')

  const inviterDesc = params.inviterName ? `${params.inviterName} (${params.inviterAddress})` : params.inviterAddress
  const admissionDesc = params.admissionMode === 'InviteVouched'
    ? 'Invite & Vouched by Community (governance proposal will be created automatically)'
    : 'Open Admission'

  const greeting = params.candidateName ? `Hello ${params.candidateName}!` : 'Hello!'

  return `Subject: You're invited to join ${params.poolName} on ComFi!

${greeting}

You have been invited to join the community financial pool "${params.poolName}" on ComFi.

Pool Details:
• Pool Name: ${params.poolName}
• Pool Address: ${params.poolAddress}
• Invited & Vouched by: ${inviterDesc}
• Admission Mode: ${admissionDesc}
${params.memberObligationAmount ? `• Member Obligation: ${params.memberObligationAmount} per cycle\n` : ''}${params.cycleDurationDays ? `• Cycle Duration: ${params.cycleDurationDays} days\n` : ''}${params.note ? `• Note from inviter: "${params.note}"\n` : ''}
To accept this invitation and connect your Solana wallet, open the link below:
${params.shareUrl}

Once you submit your wallet address, our automated onboarding pipeline will immediately dispatch an AdmitMember governance proposal on your behalf.

Welcome to ComFi!`
}

/**
 * Creates a new invitation record, generates its payload, share URL, and email message.
 */
export function createInvitation(params: {
  poolAddress: string
  poolName: string
  inviterAddress: string
  inviterName?: string
  candidateName?: string
  admissionMode?: AdmissionMode
  expiresInDays?: number
  note?: string
  baseUrl?: string
  memberObligationAmount?: string
  cycleDurationDays?: number
}): InvitationRecord {
  const poolAddress = validateSolanaAddress(params.poolAddress, 'poolAddress')
  const inviterAddress = validateSolanaAddress(params.inviterAddress, 'inviterAddress')
  if (!params.poolName || params.poolName.trim().length === 0) {
    throw new Error('poolName must be a non-empty string')
  }

  const expiresInDays = params.expiresInDays ?? 7
  if (expiresInDays <= 0) {
    throw new Error(`expiresInDays must be a positive number, got: ${expiresInDays}`)
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
  const inviteId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const admissionMode = params.admissionMode ?? 'InviteVouched'

  const payload: InvitationPayload = {
    inviteId,
    poolAddress,
    poolName: params.poolName.trim(),
    inviterAddress,
    inviterName: params.inviterName?.trim(),
    admissionMode,
    memberObligationAmount: params.memberObligationAmount,
    cycleDurationDays: params.cycleDurationDays,
    createdAt: now.toISOString(),
    expiresAt,
    note: params.note?.trim(),
  }

  const token = encodeInvitationPayload(payload)
  const shareUrl = generateShareUrl(token, params.baseUrl)
  const emailMessage = generateInvitationEmailMessage({
    poolName: payload.poolName,
    poolAddress,
    inviterAddress,
    inviterName: payload.inviterName,
    candidateName: params.candidateName?.trim(),
    shareUrl,
    admissionMode,
    memberObligationAmount: payload.memberObligationAmount,
    cycleDurationDays: payload.cycleDurationDays,
    note: payload.note,
  })

  const record: InvitationRecord = {
    ...payload,
    candidateName: params.candidateName?.trim(),
    status: 'pending_submission',
    shareUrl,
    emailMessage,
  }

  const all = loadInvitations()
  all[inviteId] = record
  saveInvitations(all)

  return record
}

/**
 * In-memory webhook event listener subscribers.
 */
type WebhookListener = (event: InvitationWebhookEvent) => void
const webhookListeners = new Set<WebhookListener>()

/**
 * Registers an automated webhook listener for invitation events.
 * Returns an unregister cleanup function.
 */
export function onInvitationWebhook(listener: WebhookListener): () => void {
  if (typeof listener !== 'function') {
    throw new Error('listener must be a function')
  }
  webhookListeners.add(listener)
  return () => {
    webhookListeners.delete(listener)
  }
}

let nextMockProposalId = 100

/**
 * Automated webhook dispatcher that dispatches an AdmitMember governance proposal
 * upon recipient wallet submission on behalf of the inviter.
 */
export async function dispatchAdmitMemberProposal(
  event: InvitationWebhookEvent
): Promise<AdmitMemberProposalDispatchResult> {
  if (!event || event.type !== 'INVITE_WALLET_SUBMITTED') {
    throw new Error('Invalid webhook event: expected INVITE_WALLET_SUBMITTED')
  }
  validateSolanaAddress(event.poolAddress, 'event.poolAddress')
  validateSolanaAddress(event.candidateWallet, 'event.candidateWallet')
  validateSolanaAddress(event.inviterAddress, 'event.inviterAddress')
  if (!event.inviteId) {
    throw new Error('Missing inviteId in webhook event')
  }

  // Generate unique proposal id and address
  const proposalId = nextMockProposalId++
  const proposalAddress = `PropAdmit${proposalId}x${event.candidateWallet.slice(0, 8)}`
  const dispatchedAt = new Date().toISOString()

  return {
    success: true,
    proposalId,
    proposalAddress,
    poolAddress: event.poolAddress,
    candidateWallet: event.candidateWallet,
    vouchedBy: event.inviterAddress,
    actionType: 'AdmitMember',
    dispatchedAt,
  }
}

/**
 * Invitee submits their wallet address to accept an invitation.
 * Triggers the automated webhook pipeline and dispatches an AdmitMember proposal.
 */
export async function submitRecipientWallet(
  inviteId: string,
  candidateWallet: string,
  candidateName?: string
): Promise<{ record: InvitationRecord; webhookResult: AdmitMemberProposalDispatchResult }> {
  if (!inviteId || typeof inviteId !== 'string') {
    throw new Error('inviteId must be a non-empty string')
  }
  const validatedCandidate = validateSolanaAddress(candidateWallet, 'candidateWallet')

  const all = loadInvitations()
  const record = all[inviteId]
  if (!record) {
    throw new Error(`Invitation not found for ID: '${inviteId}'`)
  }

  if (record.status === 'revoked') {
    throw new Error('This invitation has been revoked by the inviter')
  }
  if (record.status === 'admitted') {
    throw new Error('This candidate has already been admitted to the pool')
  }

  if (record.inviterAddress.toLowerCase() === validatedCandidate.toLowerCase()) {
    throw new Error('Candidate wallet cannot be identical to the inviter address')
  }

  const now = new Date()
  if (now.getTime() > new Date(record.expiresAt).getTime()) {
    record.status = 'expired'
    all[inviteId] = record
    saveInvitations(all)
    throw new Error('This invitation has expired')
  }

  // Update record with candidate wallet
  record.candidateWallet = validatedCandidate
  record.candidateName = candidateName?.trim()
  record.submittedAt = now.toISOString()
  record.status = 'wallet_submitted'

  // Construct webhook event
  const webhookEvent: InvitationWebhookEvent = {
    type: 'INVITE_WALLET_SUBMITTED',
    inviteId,
    poolAddress: record.poolAddress,
    candidateWallet: validatedCandidate,
    candidateName: record.candidateName,
    inviterAddress: record.inviterAddress,
    submittedAt: record.submittedAt,
  }

  // Notify registered webhook listeners
  webhookListeners.forEach(listener => {
    listener(webhookEvent)
  })

  // Dispatch AdmitMember governance proposal on behalf of inviter
  const webhookResult = await dispatchAdmitMemberProposal(webhookEvent)

  // Update record with proposal dispatch information
  record.proposalId = webhookResult.proposalId
  record.proposalAddress = webhookResult.proposalAddress
  record.status = 'proposal_queued'
  record.webhookDispatchedAt = webhookResult.dispatchedAt
  record.webhookAuditId = `wh_audit_${Date.now()}`

  all[inviteId] = record
  saveInvitations(all)

  return { record, webhookResult }
}

/**
 * Executes admission once an AdmitMember proposal is passed/executable.
 */
export async function executeAdmission(inviteId: string): Promise<InvitationRecord> {
  if (!inviteId || typeof inviteId !== 'string') {
    throw new Error('inviteId must be a non-empty string')
  }

  const all = loadInvitations()
  const record = all[inviteId]
  if (!record) {
    throw new Error(`Invitation not found for ID: '${inviteId}'`)
  }

  if (record.status === 'admitted') {
    return record
  }

  if (record.status === 'revoked') {
    throw new Error('Cannot execute admission for a revoked invitation')
  }

  if (record.status === 'expired') {
    throw new Error('Cannot execute admission for an expired invitation')
  }

  if (!record.candidateWallet) {
    throw new Error('Cannot execute admission: candidate wallet has not been submitted')
  }

  record.status = 'admitted'
  record.executedAt = new Date().toISOString()
  all[inviteId] = record
  saveInvitations(all)

  return record
}

/**
 * Revokes an existing invitation.
 */
export function revokeInvitation(inviteId: string): InvitationRecord {
  if (!inviteId || typeof inviteId !== 'string') {
    throw new Error('inviteId must be a non-empty string')
  }

  const all = loadInvitations()
  const record = all[inviteId]
  if (!record) {
    throw new Error(`Invitation not found for ID: '${inviteId}'`)
  }

  if (record.status === 'admitted') {
    throw new Error('Cannot revoke an invitation that has already been admitted')
  }

  record.status = 'revoked'
  all[inviteId] = record
  saveInvitations(all)

  return record
}

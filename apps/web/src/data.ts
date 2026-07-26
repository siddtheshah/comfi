export type Activity = { initials: string; who: string; action: string; detail: string; amount?: string; time: string; tone: 'in' | 'out' | 'note' }

/** Development-only shape returned by the sponsor service before a member action. */
export const mockSponsorResponse = {
  quoteId: 'b4c4638a59ef2ed2f25caaee8aeb8be7175b8db1e082e81e3ff2266d277f3f95',
  pool: '11111111111111111111111111111111',
  member: 'SysvarRent111111111111111111111111111',
  action: 'set_alias',
  chargeUsdc: '20000',
  expiresAt: '2026-07-26T17:10:00.000Z',
  signature: 'demo_signature_replace_with_sponsor_signature',
} as const

export const pools = [
  { id: 'neighbors', icon: '✦', name: 'Maple Street Mutual Aid', role: 'Member', status: 'Up to date', balance: '$4,860.20', funds: '18 of 24', nextDate: 'Aug 1', proposals: 2, requests: 1, cap: 24, slots: 6, accent: 'coral' },
  { id: 'garden', icon: '♣', name: 'Eastside Community Garden', role: 'Coordinator', status: 'Up to date', balance: '$1,273.80', funds: '12 of 16', nextDate: 'Aug 5', proposals: 1, requests: 0, cap: 16, slots: 4, accent: 'lime' },
  { id: 'parents', icon: '☻', name: 'Room 204 Family Fund', role: 'Member', status: 'Contribution due', balance: '$892.00', funds: '9 of 15', nextDate: 'Today', proposals: 0, requests: 0, cap: 15, slots: 2, accent: 'sky' },
]

export const activity: Activity[] = [
  { initials: 'JR', who: 'Jordan R.', action: 'added to the fund', detail: 'August contribution', amount: '+ $25.00', time: 'Today, 9:42 AM', tone: 'in' },
  { initials: 'MS', who: 'Maya S.', action: 'requested a payment', detail: 'Food pantry supplies', amount: '$148.52', time: 'Yesterday', tone: 'out' },
  { initials: 'AC', who: 'Avery C.', action: 'opened a proposal', detail: 'Increase garden supply limit', time: 'Jul 23', tone: 'note' },
  { initials: 'KL', who: 'Kai L.', action: 'added to the fund', detail: 'August contribution', amount: '+ $25.00', time: 'Jul 20', tone: 'in' },
]

export const members = [
  ['MS', 'Maya S.', 'Treasurer'], ['JR', 'Jordan R.', 'Member'], ['KL', 'Kai L.', 'Member'], ['AC', 'Avery C.', 'Member'], ['YT', 'You', 'Member'],
]

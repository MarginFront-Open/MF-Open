/**
 * key-role-display.ts — pure, node-testable view model for the role-mirrored
 * API-key mint dialog and key list. Shared by the mint sheet
 * (create-key-pair-sheet.tsx) and the Build tab's key list
 * (api-keys-tab.tsx) so the badge colors, teaching copy, and
 * demotion-review rule can't drift.
 *
 * The mint flow must teach the difference at mint time: one plain-language
 * line per key kind, and grayed-out roles must say WHY they're unavailable.
 * KEY_ROLE_TEACHING_COPY and unavailableRoleReason() below are that copy,
 * not polish.
 */

import type { KeyRole } from '@marginfront/db'

// Client-safe port of packages/db/src/lib/org-roles.ts MINTABLE_KEY_ROLES /
// mintableKeyRoles (a value import of @marginfront/db would drag Prisma + node:fs
// into the browser bundle), kept honest by key-role-display-parity.test.ts.
const MINTABLE_KEY_ROLES: Record<string, readonly string[]> = {
  owner: [
    'ingest',
    'member',
    'developer',
    'finance',
    'legal',
    'admin',
    'owner',
  ],
  admin: ['ingest', 'member', 'developer', 'finance', 'legal', 'admin'],
  developer: ['ingest', 'member', 'developer'], // build lane, no money, no law
  finance: ['ingest', 'member', 'finance'], // money lane, no build, no law
  member: [], // members mint nothing
}

export function mintableKeyRoles(minterRole: string): readonly string[] {
  return MINTABLE_KEY_ROLES[minterRole] ?? []
}

export const KEY_ROLE_ORDER: readonly KeyRole[] = [
  'ingest',
  'member',
  'developer',
  'finance',
  'legal',
  'admin',
  'owner',
]

export const KEY_ROLE_LABELS: Record<KeyRole, string> = {
  ingest: 'Ingest-only',
  member: 'Member (read)',
  developer: 'Developer',
  finance: 'Finance',
  legal: 'Legal',
  admin: 'Admin',
  owner: 'Owner',
}

/**
 * The one-line, plain-language explanation of what a key of this role can do,
 * shown next to every option in the mint dialog, not only the one you
 * picked, so a minter can compare roles before choosing.
 *
 * ONE LINE IS THE CONTRACT, not a style note. All six render at once, at
 * text-xs, inside radio-option labels. Anything that needs more than a line
 * belongs in KEY_ROLE_DETAIL_LINES below, which renders for the selected role
 * only.
 */
export const KEY_ROLE_TEACHING_COPY: Record<KeyRole, string> = {
  ingest:
    "Sends usage events and reads your spend controls, including your organization's AI spend and a named teammate's spend. Recording usage is its only write.",
  member:
    'Read-only. Can fetch pricing, config, and invoices, but cannot change anything.',
  developer:
    'Can create customers, agents, and usage meters. Can never touch invoices, pricing, or payouts.',
  finance:
    'Can generate invoices, edit pricing, and manage subscriptions. Can never create customers or agents.',
  legal:
    'Manages legal matters, routing rules, and the matter audit export. Outside the Law surface it can only send usage and read spend controls.',
  admin:
    'Everything a Developer key and a Finance key can do, combined. Cannot delete the organization or change ownership.',
  owner:
    'Same access as Admin. Exists so audit logs can show a key was minted with owner-level trust.',
}

/**
 * The consequences that don't fit on an option's single line, shown under the
 * role group for the SELECTED role only (create-key-pair-sheet.tsx).
 *
 * Ingest-only is the sole entry: it is the default selection every minter sees
 * first (defaultMintRole), its one-line label stops at what the key reads and
 * writes, and a one-liner would promise a scope the server doesn't enforce. A
 * minter deciding how carefully to guard this key needs the write's blast
 * radius and the leak consequence, not only the read list.
 */
export const KEY_ROLE_DETAIL_LINES: Partial<
  Record<KeyRole, readonly string[]>
> = {
  ingest: [
    "Recording usage creates what it names: the first event mentioning a customer, agent, or signal that doesn't exist yet creates that record, and the usage lands on your invoices.",
    'If it leaks, someone can push fake usage into your billing data and read those spend numbers, so rotate it.',
    "It still can't read or change invoices, customers, revenue, analytics, or payouts.",
  ],
}

/** Filters + orders a set of mintable roles into the canonical floor-to-ceiling order. */
export function orderKeyRoles(roles: readonly string[]): KeyRole[] {
  return KEY_ROLE_ORDER.filter((role) => roles.includes(role))
}

/**
 * The mint dialog's default selection: the least-privilege role the minter
 * is allowed to stamp (least privilege by default). 'ingest' whenever
 * it's on the table, which it always is for anyone who can reach the mint
 * door at all — every MINT_KEY_ROLES role can mint 'ingest'.
 */
export function defaultMintRole(mintable: readonly string[]): KeyRole | null {
  if (mintable.includes('ingest')) return 'ingest'
  return orderKeyRoles(mintable)[0] ?? null
}

/**
 * Why a role is grayed out for this minter, or null if it's available.
 * Reads the SAME ceiling the server enforces (mintableKeyRoles), so this
 * text can never promise something the mint action will then refuse.
 */
export function unavailableRoleReason(
  role: KeyRole,
  minterRole: string | undefined
): string | null {
  const mintable = mintableKeyRoles(minterRole ?? '')
  if (mintable.includes(role)) return null

  const you = minterRole
    ? `You're ${KEY_ROLE_LABELS[minterRole as KeyRole] ?? minterRole}`
    : "You're not signed in to this org"

  if (role === 'admin' || role === 'owner') {
    return `${you}: only an owner or admin can mint an ${KEY_ROLE_LABELS[role]} key.`
  }
  if (role === 'developer') {
    return `${you}: you can't mint build-lane keys.`
  }
  if (role === 'finance') {
    return `${you}: you can't mint money-lane keys.`
  }
  if (role === 'legal') {
    return `${you}: only an owner or admin can mint a Legal key.`
  }
  return `${you}: you can't mint this key role.`
}

/** Money-capable roles for the "which keys can touch money" filter. */
export function touchesMoney(role: KeyRole): boolean {
  return role === 'finance' || role === 'admin' || role === 'owner'
}

const ROLE_BADGE_CLASSNAMES: Record<KeyRole, string> = {
  ingest:
    'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  member: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  developer:
    'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  finance: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  legal:
    'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  admin:
    'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  owner: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
}

export function keyRoleBadgeClassName(role: KeyRole): string {
  return ROLE_BADGE_CLASSNAMES[role]
}

/**
 * True when the person who minted this key no longer holds a role that could
 * mint one this powerful. Does NOT weaken the key (a
 * demoted minter's existing keys keep working) — only flags it for review.
 * Only meaningful when minterUserId is set.
 */
export function needsMinterReview(
  keyRole: KeyRole,
  minterCurrentRole: string | null | undefined
): boolean {
  return !mintableKeyRoles(minterCurrentRole ?? '').includes(keyRole)
}

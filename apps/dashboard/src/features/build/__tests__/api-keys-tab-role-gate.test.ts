/**
 * Write affordances on the Build keys surface must never show to a role the
 * server would refuse. Source-assertion (this repo's jest is node-only, no
 * RTL): canMintKeys() must gate the create button AND the per-row revoke
 * button on api-keys-tab.tsx, where full key CRUD lives.
 * Cosmetic only: assertKeyMinter stays the real enforcer.
 *
 * The gate is canMintKeys, not canManageBuild: finance may reach the
 * mint/revoke door too, which canManageBuild would wrongly hide.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(
  join(__dirname, '..', 'components', 'api-keys-tab.tsx'),
  'utf8'
)

describe('api-keys-tab.tsx — write controls gated by canMintKeys', () => {
  it('imports canMintKeys and reads the role via useCurrentOrganization', () => {
    expect(src).toMatch(/import \{ canMintKeys \} from '@\/lib\/permissions'/)
    expect(src).toMatch(
      /import \{ useCurrentOrganization \} from '@\/hooks\/use-auth'/
    )
    expect(src).toMatch(/canMintKeys\(organization\?\.role\)/)
  })

  it('gates the "＋ Create key pair" button behind canManage', () => {
    const returnIndex = src.indexOf('return (')
    const createButtonIndex = src.indexOf('＋ Create key pair', returnIndex)
    const precedingGateIndex = src.lastIndexOf(
      'canManage && (',
      createButtonIndex
    )
    expect(createButtonIndex).toBeGreaterThan(-1)
    expect(precedingGateIndex).toBeGreaterThan(-1)
    const between = src.slice(precedingGateIndex, createButtonIndex)
    expect(between).not.toMatch(/canManage &&.*canManage &&/s)
  })

  it('gates the per-row Revoke button behind canManage (and active status)', () => {
    expect(src).toMatch(
      /\{canManage && isActiveKey && \(\s*<button[\s\S]*?setRevokeTarget\(key\)[\s\S]*?Revoke[\s\S]*?<\/button>\s*\)\}/
    )
  })

  it('read affordances (reveal/copy) are NOT role-gated — every role may see its masked keys', () => {
    const revealIndex = src.indexOf('setRevealedKeyId(')
    expect(revealIndex).toBeGreaterThan(-1)
    const gateBefore = src.lastIndexOf('canManage && (', revealIndex)
    const gateClose = src.indexOf(')}', gateBefore)
    expect(gateBefore === -1 || gateClose < revealIndex).toBe(true)
  })
})

describe('api-keys-tab.tsx — role-mirrored key-list badges', () => {
  it('imports the shared key-role-display helpers', () => {
    expect(src).toMatch(
      /import \{\s*KEY_ROLE_LABELS,\s*keyRoleBadgeClassName,\s*needsMinterReview,\s*touchesMoney,\s*\} from '@\/features\/developer-zone\/api-keys\/key-role-display'/
    )
  })

  it('renders a role badge and a legacy flag, not role-gated (every role may see them)', () => {
    expect(src).toMatch(/keyRoleBadgeClassName\(key\.role\)/)
    expect(src).toMatch(/KEY_ROLE_LABELS\[key\.role\]/)
    expect(src).toMatch(/key\.legacy && \(/)
  })

  it('flags backfilled keys with the "Full access (legacy)" badge and a rotate nudge', () => {
    expect(src).toMatch(/Full access \(legacy\)/)
    expect(src).toMatch(/Rotate to a scoped key/)
  })

  it('gates the rotate nudge like every other mint affordance (it opens the create sheet)', () => {
    expect(src).toMatch(
      /\{key\.legacy && isActiveKey && canManage && \(\s*<button[\s\S]*?setCreateOpen\(true\)[\s\S]*?Rotate to a scoped key[\s\S]*?<\/button>\s*\)\}/
    )
  })
})

describe('api-keys-tab.tsx — demoted-minter review + money filter', () => {
  it('compares each key against the current org roster via useTeamMembers', () => {
    expect(src).toMatch(
      /import \{ useTeamMembers \} from '@\/services\/organization-members-service'/
    )
    expect(src).toMatch(/useTeamMembers\(\)/)
  })

  it('computes keysNeedingReview from needsMinterReview and renders a review banner', () => {
    expect(src).toMatch(
      /needsMinterReview\(key\.role, currentMinterRole\(key\.minterUserId\)\)/
    )
    expect(src).toMatch(/keysNeedingReview\.length > 0/)
    expect(src).toMatch(/need review/)
  })

  it('excludes legacy keys from the demotion-review set — they get their own badge instead', () => {
    expect(src).toMatch(/!key\.legacy &&\s*key\.minterUserId !== null/)
  })

  it('tags each flagged row with a Review chip, not role-gated', () => {
    expect(src).toMatch(/reviewKeyIds\.has\(key\.id\)/)
    expect(src).toMatch(/>\s*Review\s*<\/span>/)
  })

  it('drives the "which keys can touch money" filter off touchesMoney(key.role)', () => {
    expect(src).toMatch(/touchesMoney\(key\.role\)/)
    expect(src).toMatch(/setMoneyOnly/)
    expect(src).toMatch(/Show only keys that can touch money/)
  })
})

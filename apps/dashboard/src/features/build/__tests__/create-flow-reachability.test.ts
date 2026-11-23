/**
 * "+ New agent" and "+ Create key" on Build must reach REAL, working create
 * flows: the create bodies are the live /agents/new signals wizard and the
 * one-time-reveal key flow in place on Build's keys tab via the SHARED
 * CreateKeyPairSheet, never a modal copy. This file pins the end-to-end
 * path so a refactor can't quietly break it: the reachable entry point, AND
 * that it is backed by a real mutation hook calling a real, DB-writing,
 * gated server action (not a stub). The masked key list is pinned by
 * api-key-display.test.ts.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const agentsTableSrc = readFileSync(
  join(__dirname, '..', 'components', 'agents-table.tsx'),
  'utf8'
)
const apiKeysTabSrc = readFileSync(
  join(__dirname, '..', 'components', 'api-keys-tab.tsx'),
  'utf8'
)
const newAgentPageSrc = readFileSync(
  join(__dirname, '..', '..', 'agents', 'new-agent.tsx'),
  'utf8'
)
const createKeySheetSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'developer-zone',
    'api-keys',
    'create-key-pair-sheet.tsx'
  ),
  'utf8'
)
const agentsActionsSrc = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'app', 'actions', 'agents.ts'),
  'utf8'
)
const apiKeysActionsSrc = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'app', 'actions', 'api-keys.ts'),
  'utf8'
)

describe('"+ New agent" reaches a real, working create flow', () => {
  it('the Build button links to /agents/new (no modal)', () => {
    expect(agentsTableSrc).toMatch(/href='\/agents\/new'/)
  })

  it('/agents/new renders a real form (name/description/agentCode) that submits via useCreateAgent', () => {
    expect(newAgentPageSrc).toMatch(/useCreateAgent/)
    expect(newAgentPageSrc).toMatch(
      /createAgentMutation\.mutateAsync\(payload\)/
    )
    expect(newAgentPageSrc).toMatch(/name: values\.name/)
    expect(newAgentPageSrc).toMatch(/agentCode: values\.agentCode/)
  })

  it('successful create navigates on to the signals wizard, not a dead end', () => {
    expect(newAgentPageSrc).toMatch(
      /router\.push\(`\/agents\/\$\{createdAgent\.id\}\/signals`\)/
    )
  })

  it('createAgent is a real, gated, DB-writing server action — not a stub', () => {
    expect(agentsActionsSrc).toMatch(/export async function createAgent\(/)
    expect(agentsActionsSrc).toMatch(/assertBuildManager\(\)/)
    expect(agentsActionsSrc).toMatch(/db\.agents\.create\(/)
  })
})

describe('"+ Create key" reaches a real, working create flow', () => {
  it('Build opens the SHARED CreateKeyPairSheet in place, with no link out to the developer zone', () => {
    expect(apiKeysTabSrc).toMatch(/<CreateKeyPairSheet/)
    expect(apiKeysTabSrc).toMatch(/setCreateOpen\(true\)/)
    expect(apiKeysTabSrc).not.toMatch(/href='\/developer-zone\/api-keys'/)
  })

  it('the create body is the SHARED CreateKeyPairSheet, imported from its dev-zone home — no inline fork', () => {
    expect(apiKeysTabSrc).toMatch(
      /import \{ CreateKeyPairSheet \} from '@\/features\/developer-zone\/api-keys\/create-key-pair-sheet'/
    )
    expect(apiKeysTabSrc).not.toMatch(/ONE-TIME REVEAL/)
  })

  it('the sheet offers a name (required) + description (optional) create form, no scopes field', () => {
    expect(createKeySheetSrc).toMatch(/Key Name/)
    expect(createKeySheetSrc).toMatch(/Description \(optional\)/)
    expect(createKeySheetSrc).not.toMatch(/scopes?/i)
  })

  it('the sheet submits via useCreateApiKeyPair, gated on a non-empty name AND a selected role', () => {
    expect(createKeySheetSrc).toMatch(/useCreateApiKeyPair/)
    expect(createKeySheetSrc).toMatch(
      /createKeyPairMutation\.mutate\(\s*\{ \.\.\.newKeyPair, role: selectedRole \}/
    )
    expect(createKeySheetSrc).toMatch(/!newKeyPair\.name\.trim\(\)/)
    // The mint ceiling means "no role selected" (an empty
    // ceiling, e.g. a member who slipped past the canMintKeys UI gate) must
    // also block the button — not just an empty name.
    expect(createKeySheetSrc).toMatch(/!selectedRole/)
  })

  it('createApiKeyPair is a real, gated, DB-writing server action — not a stub', () => {
    expect(apiKeysActionsSrc).toMatch(
      /export async function createApiKeyPair\(/
    )
    // assertKeyMinter, not assertBuildManager:
    // finance may reach the mint door too.
    expect(apiKeysActionsSrc).toMatch(/assertKeyMinter\(\)/)
    expect(apiKeysActionsSrc).toMatch(/db\.api_keys\.create\(/)
  })

  it('the create response is revealed once, never re-fetchable in plaintext for secret keys', () => {
    expect(createKeySheetSrc).toMatch(/ONE-TIME REVEAL/)
    expect(createKeySheetSrc).toMatch(
      /closing the sheet clears the revealed pair/
    )
    // The list-side half (secret keys render only the server's masked stub)
    // is pinned by api-key-display.test.ts against keyCellModel.
  })
})

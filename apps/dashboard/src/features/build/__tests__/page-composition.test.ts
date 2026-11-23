/**
 * Build page-composition facts, source-
 * asserted (dashboard jest is node-only, no RTL; the page imports @dnd-kit
 * through TileGrid so it can't be imported here). Modeled on finops
 * page-composition.test.ts + money no-direct-resolver.test.ts. Each
 * assertion pins a contract a later refactor could silently break.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const FEATURE_DIR = join(__dirname, '..')

const RESOLVE_METRICS_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\bresolveMetrics\b[^}]*\}\s*from/
const RESOLVE_METRICS_CALL = /\bresolveMetrics\s*\(/

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const featureFiles = walkTsFiles(FEATURE_DIR)
const indexSrc = readFileSync(join(FEATURE_DIR, 'index.tsx'), 'utf8')
const agentsTableSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'agents-table.tsx'),
  'utf8'
)
const agentDetailSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'agent-detail.tsx'),
  'utf8'
)
const statusDialogSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'agent-status-dialog.tsx'),
  'utf8'
)
const eventStreamSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'event-stream.tsx'),
  'utf8'
)
const apiKeysTabSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'api-keys-tab.tsx'),
  'utf8'
)
const apiKeysServiceSrc = readFileSync(
  join(FEATURE_DIR, '..', '..', 'services', 'api-keys-service.ts'),
  'utf8'
)

/** Every '@/app/actions/<module>' this file references, deduped. */
function actionModules(src: string): string[] {
  return [
    ...new Set(
      [...src.matchAll(/from '@\/app\/actions\/([^']+)'/g)].map((m) => m[1])
    ),
  ].sort()
}

describe('single-data-path invariant', () => {
  it('has files to check (guards against a silently-empty suite)', () => {
    expect(featureFiles.length).toBeGreaterThan(0)
  })

  it.each(featureFiles.map((f) => f.slice(FEATURE_DIR.length + 1)))(
    '%s never imports or calls the metrics resolver',
    (relPath) => {
      const src = readFileSync(join(FEATURE_DIR, relPath), 'utf8')
      expect(src).not.toMatch(RESOLVE_METRICS_IMPORT)
      expect(src).not.toMatch(RESOLVE_METRICS_CALL)
    }
  )
})

describe('index.tsx — the ONE DimensionedSection invocation, HEADLESS', () => {
  it('invokes DimensionedSection exactly once', () => {
    expect(indexSrc.match(/<DimensionedSection/g)).toHaveLength(1)
  })

  it("passes scope={PAGE} where PAGE is 'build'", () => {
    expect(indexSrc).toMatch(/const PAGE = 'build' as const/)
    expect(indexSrc).toMatch(/scope=\{PAGE\}/)
  })

  it('turns EVERY chrome flag off: Build shows no donut or breakdown table, and the mount is only the KPI data source', () => {
    expect(indexSrc).toMatch(/showChart=\{false\}/)
    expect(indexSrc).toMatch(/showDonut=\{false\}/)
    expect(indexSrc).toMatch(/showTable=\{false\}/)
    expect(indexSrc).toMatch(/showDimensionPicker=\{false\}/)
  })

  it("keeps a fixed 'model' dimension — the resolver input requires one even headless", () => {
    expect(indexSrc).toMatch(/initialDimension='model'/)
  })

  it('still bridges the KPI tiles + add-panel series from the SAME response', () => {
    const start = indexSrc.indexOf('<DimensionedSection')
    expect(start).toBeGreaterThan(-1)
    const section = indexSrc.slice(start, indexSrc.indexOf('/>', start))
    expect(section).toMatch(/renderKpiRow/)
    expect(section).toMatch(/<KpiRowBridge/)
  })

  it('passes no title/chartTitle/resolveLabel — nothing visible may come back from this mount', () => {
    const start = indexSrc.indexOf('<DimensionedSection')
    expect(start).toBeGreaterThan(-1)
    const end = indexSrc.indexOf('renderKpiRow', start)
    expect(end).toBeGreaterThan(start)
    const props = indexSrc.slice(start, end)
    expect(props).not.toMatch(/\btitle=/)
    expect(props).not.toMatch(/\bchartTitle=/)
    expect(props).not.toMatch(/\bresolveLabel=/)
  })
})

describe('index.tsx — drill-in state lives in ?agent=', () => {
  it('reads the drilled agent from the URL, same idiom as ?tab=', () => {
    expect(indexSrc).toMatch(/searchParams\.get\('agent'\)/)
  })

  it('drill-in PUSHES (browser Back returns to the table); the Back button deletes the param', () => {
    expect(indexSrc).toMatch(/nextParams\.set\('agent', agentId\)/)
    expect(indexSrc).toMatch(/nextParams\.delete\('agent'\)/)
  })

  it('the detail gets the refresh hook so its status toggle re-fetches the table', () => {
    const detailAt = indexSrc.indexOf('<AgentDetail')
    expect(detailAt).toBeGreaterThan(-1)
    const detailProps = indexSrc.slice(
      detailAt,
      indexSrc.indexOf('/>', detailAt)
    )
    expect(detailProps).toMatch(/onChanged=\{handleAgentsChanged\}/)
    expect(detailProps).toMatch(/onBack=\{handleDrillOut\}/)
  })
})

describe('index.tsx — composition order', () => {
  it('renders AgentsTable before TileGrid before DimensionedSection', () => {
    const tableAt = indexSrc.indexOf('<AgentsTable')
    const gridAt = indexSrc.indexOf('<TileGrid')
    const sectionAt = indexSrc.indexOf('<DimensionedSection')
    expect(tableAt).toBeGreaterThan(-1)
    expect(gridAt).toBeGreaterThan(tableAt)
    expect(sectionAt).toBeGreaterThan(gridAt)
  })

  it('EventStream sits in the agents area — after the table, before the grid', () => {
    const streamAt = indexSrc.indexOf('<EventStream')
    expect(streamAt).toBeGreaterThan(indexSrc.indexOf('<AgentsTable'))
    expect(streamAt).toBeLessThan(indexSrc.indexOf('<TileGrid'))
  })

  it('drill-in replaces only the agents area — AgentDetail renders in the same slot', () => {
    const detailAt = indexSrc.indexOf('<AgentDetail')
    expect(detailAt).toBeGreaterThan(-1)
    expect(detailAt).toBeLessThan(indexSrc.indexOf('<TileGrid'))
  })

  it('ApiKeysTab mounts on its own keys tab, not on the Agents tab', () => {
    expect(indexSrc).not.toMatch(/ApiKeysSection/)
    const keysTabAt = indexSrc.indexOf("<TabsContent value='keys'>")
    const tabMountAt = indexSrc.indexOf('<ApiKeysTab />')
    expect(keysTabAt).toBeGreaterThan(-1)
    expect(tabMountAt).toBeGreaterThan(keysTabAt)
  })
})

describe('index.tsx — Getting Started nudge sits above the tabs, on every tab', () => {
  it('imports GettingStartedNudge from its own component file', () => {
    expect(indexSrc).toMatch(
      /import\s*\{\s*GettingStartedNudge\s*\}\s*from\s*'\.\/components\/getting-started-nudge'/
    )
  })

  it('renders before the Tabs root, not nested inside a single TabsContent', () => {
    const nudgeAt = indexSrc.indexOf('<GettingStartedNudge')
    expect(nudgeAt).toBeGreaterThan(-1)
    expect(nudgeAt).toBeLessThan(indexSrc.indexOf('<Tabs '))
    expect(nudgeAt).toBeLessThan(
      indexSrc.indexOf("<TabsContent value='agents'")
    )
    expect(nudgeAt).toBeLessThan(
      indexSrc.indexOf("<TabsContent value='simulator'")
    )
  })
})

describe('index.tsx — alert tile is the backfill item ALONE', () => {
  it('renders via costBackfillItem', () => {
    expect(indexSrc).toMatch(/costBackfillItem/)
  })

  it('never references getMismatchedSignalCount (that item belongs to FinOps)', () => {
    expect(indexSrc).not.toMatch(/getMismatchedSignalCount/)
  })

  it('never composes the two-item Overview list (doc mentions are fine; imports/calls are not)', () => {
    expect(indexSrc).not.toMatch(
      /import\s*\{[^}]*\b(?:composeNeedsAttention|mismatchedSignalsItem)\b[^}]*\}/
    )
    expect(indexSrc).not.toMatch(/\bcomposeNeedsAttention\s*\(/)
    expect(indexSrc).not.toMatch(/\bmismatchedSignalsItem\s*\(/)
  })
})

describe('agents-table.tsx — writes reuse the gated actions, nothing else', () => {
  it('imports ONLY deleteAgent — pause/resume delegates to the shared AgentStatusDialog', () => {
    expect(agentsTableSrc).toMatch(
      /import\s*\{\s*deleteAgent\s*\}\s*from\s*'@\/app\/actions\/agents'/
    )
    expect(agentsTableSrc).not.toMatch(/import\s*\{[^}]*\bupdateAgent\b[^}]*\}/)
    expect(agentsTableSrc).not.toMatch(/\bupdateAgent\s*\(/)
    expect(agentsTableSrc).toMatch(/<AgentStatusDialog/)
  })

  it('the shared status dialog owns the gated write AND the honesty line, once, for both hosts', () => {
    expect(statusDialogSrc).toMatch(
      /import \{ updateAgent \} from '@\/app\/actions\/agents'/
    )
    expect(statusDialogSrc).toMatch(/does not stop usage recording or billing/)
    expect(agentsTableSrc).not.toMatch(
      /does not stop usage recording or billing/
    )
  })

  it('references no other action module (build-agents-overview is a type-only row import)', () => {
    expect(actionModules(agentsTableSrc)).toEqual([
      'agents',
      'build-agents-overview',
    ])
    expect(agentsTableSrc).toMatch(
      /import type \{ BuildAgentRow \} from '@\/app\/actions\/build-agents-overview'/
    )
  })

  it('never touches create or api-key actions', () => {
    for (const name of [
      'createAgent',
      'createApiKey',
      'createApiKeyPair',
      'revokeApiKey',
      'deleteApiKey',
    ]) {
      expect(agentsTableSrc).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('New agent is a link to the wizard page, not a modal', () => {
    expect(agentsTableSrc).toMatch(/href='\/agents\/new'/)
    expect(agentsTableSrc).not.toMatch(/from '@\/features\/agents/)
  })

  it('Edit agent drills into the detail view, never the /agents/[agentId] route', () => {
    expect(agentsTableSrc).not.toMatch(
      /href=\{`\/agents\/\$\{row\.agentId\}`\}/
    )
    expect(agentsTableSrc).toMatch(
      /onSelect=\{\(\)\s*=>\s*row\.agentId && onDrillIn\(row\.agentId\)\s*\}/
    )
  })

  it('delete dialog carries the soft-delete + re-provision caveats', () => {
    expect(agentsTableSrc).toMatch(/Deleted agents/)
    expect(agentsTableSrc).toMatch(/re-created automatically on the next event/)
  })
})

describe('agent-detail.tsx: the agent overview inside Build', () => {
  it('fetches recent events via getSignalEvents, agent-filtered, limit 8', () => {
    expect(agentDetailSrc).toMatch(
      /import\s*\{[^}]*\bgetSignalEvents\b[^}]*\}\s*from\s*'@\/app\/actions\/signal-events'/
    )
    expect(agentDetailSrc).toMatch(/const RECENT_EVENTS_LIMIT = 8/)
    expect(agentDetailSrc).toMatch(/agentId,/)
  })

  it('ALWAYS sends concrete window bounds via parseWindowFilter — never raw period passthrough', () => {
    expect(agentDetailSrc).toMatch(
      /import \{ parseWindowFilter \} from '@\/app\/actions\/_shared\/parse-window-filter'/
    )
    expect(agentDetailSrc).toMatch(
      /parseWindowFilter\(\{\s*startDate,\s*endDate,?\s*\}\)/
    )
    const callAt = agentDetailSrc.indexOf('getSignalEvents(')
    expect(callAt).toBeGreaterThan(-1)
    const call = agentDetailSrc.slice(
      callAt,
      agentDetailSrc.indexOf('})', callAt)
    )
    expect(call).toMatch(/agentId,/)
    expect(call).toMatch(/startDate: windowStart\.toISOString\(\)/)
    expect(call).toMatch(/endDate: windowEnd\.toISOString\(\)/)
    // A revert to shorthand passthrough hands the action undefined in
    // rolling mode; getSignalEvents then SKIPS its usageDate predicate
    // and the "this window" count becomes all-time.
    expect(call).not.toMatch(/^\s*(?:startDate|endDate),\s*$/m)
  })

  it('references only the signal-events action module (plus the shared window parser and type-only imports)', () => {
    expect(actionModules(agentDetailSrc)).toEqual([
      '_shared/parse-window-filter',
      'build-agents-overview',
      'signal-events',
    ])
    expect(agentDetailSrc).toMatch(
      /import type \{ BuildAgentRow \} from '@\/app\/actions\/build-agents-overview'/
    )
  })

  it('reuses the existing service hooks and the shared earnings module', () => {
    expect(agentDetailSrc).toMatch(/useAgent\(/)
    expect(agentDetailSrc).toMatch(/useAgentSignals\(/)
    expect(agentDetailSrc).toMatch(/useSubscriptions\(/)
    expect(agentDetailSrc).toMatch(
      /from '@\/features\/agents\/agent-earnings-chart'/
    )
    expect(agentDetailSrc).toMatch(/useAgentEarningsBreakdown\(/)
    expect(agentDetailSrc).toMatch(/<AgentEarningsChartBody/)
  })

  it("the chart keeps the canon contract: usageRevenue tooltip + the honest 'Last 30 days' window label (L1)", () => {
    expect(agentDetailSrc).toMatch(/tooltipDefinitions\.usageRevenue/)
    expect(agentDetailSrc).toMatch(/Usage cost & revenue/)
    expect(agentDetailSrc).toMatch(/Last 30 days ·/)
  })

  it('writes go only through the shared dialogs (status switch + edit) — never raw agent actions', () => {
    expect(agentDetailSrc).toMatch(/<Switch/)
    expect(agentDetailSrc).toMatch(/<AgentStatusDialog/)
    for (const name of ['updateAgent', 'deleteAgent', 'createAgent']) {
      expect(agentDetailSrc).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('links out to the per-agent pages (pricing plans, revenue simulator, metrics editor, subscriptions)', () => {
    expect(agentDetailSrc).toMatch(
      /href=\{`\/agents\/\$\{agentId\}\/pricing-plans`\}/
    )
    expect(agentDetailSrc).toMatch(
      /href=\{`\/agents\/\$\{agentId\}\/revenue-simulator`\}/
    )
    expect(agentDetailSrc).toMatch(
      /href=\{`\/agents\/\$\{agentId\}\/signals`\}/
    )
    expect(agentDetailSrc).toMatch(/href='\/subscriptions'/)
  })

  it('the Edit-agent seam is wired: EditAgentDialog mounts in place, remount-keyed on open', () => {
    expect(agentDetailSrc).toMatch(
      /import \{ EditAgentDialog \} from '@\/features\/agents\/components\/edit-agent-dialog'/
    )
    expect(agentDetailSrc).toMatch(
      /<EditAgentDialog\s+key=\{String\(showEditDialog\)\}/
    )
    expect(agentDetailSrc).toMatch(/initialName=\{agent\.name\}/)
    expect(agentDetailSrc).toMatch(
      /initialDescription=\{agent\.description \|\| ''\}/
    )
    expect(agentDetailSrc).toMatch(/open=\{showEditDialog\}/)
    expect(agentDetailSrc).toMatch(/onOpenChange=\{setShowEditDialog\}/)
    // The /agents/[agentId] route only redirects, so nothing may link to it.
    expect(agentDetailSrc).not.toMatch(/href=\{`\/agents\/\$\{agentId\}`\}/)
  })

  it('names the honest empty-margin subtext', () => {
    expect(agentDetailSrc).toMatch(/No billed activity yet/)
    expect(agentDetailSrc).toMatch(/\(earned − cost\) ÷ earned/)
  })

  it("margin tile overrides the registry's org-wide copy with the earned-basis entry", () => {
    expect(agentDetailSrc).toMatch(/tooltipKey='agentEarnedMargin'/)
    expect(agentDetailSrc).toMatch(/label='Earned margin'/)
  })
})

describe('event-stream.tsx: the EventStream wrapper', () => {
  const streamBody = eventStreamSrc.slice(
    eventStreamSrc.indexOf('export function EventStream')
  )

  it('exists in the same file as EventsTable', () => {
    expect(eventStreamSrc).toMatch(/export function EventStream\(/)
  })

  it('fetches via getSignalEvents, limit-bound to 8', () => {
    expect(eventStreamSrc).toMatch(
      /import\s*\{\s*getSignalEvents,\s*type SignalEvent\s*\}\s*from\s*'@\/app\/actions\/signal-events'/
    )
    expect(eventStreamSrc).toMatch(/const EVENT_STREAM_LIMIT = 8/)
    expect(streamBody).toMatch(/limit: EVENT_STREAM_LIMIT,/)
  })

  it('ALWAYS sends concrete window bounds via parseWindowFilter — never raw period passthrough', () => {
    expect(eventStreamSrc).toMatch(
      /import \{ parseWindowFilter \} from '@\/app\/actions\/_shared\/parse-window-filter'/
    )
    expect(streamBody).toMatch(
      /parseWindowFilter\(\{\s*startDate,\s*endDate,?\s*\}\)/
    )

    const callAt = streamBody.indexOf('getSignalEvents(')
    expect(callAt).toBeGreaterThan(-1)
    const call = streamBody.slice(callAt, streamBody.indexOf('})', callAt))
    expect(call).toMatch(/startDate: windowStart\.toISOString\(\)/)
    expect(call).toMatch(/endDate: windowEnd\.toISOString\(\)/)
    // A revert to shorthand passthrough hands the action undefined in
    // rolling mode; getSignalEvents then SKIPS its usageDate predicate
    // and totalResults becomes an all-time,
    // unindexed count under a "this window" header.
    expect(call).not.toMatch(/^\s*(?:startDate|endDate),\s*$/m)
  })

  it('header states the honest count — last N of the window TOTAL, not a fake completeness', () => {
    expect(streamBody).toMatch(
      /Last \{events\.length\} of \{totalResults\.toLocaleString\(\)\} this\s+window/
    )
  })

  it('REUSES EventsTable — the wrapper renders the shared component and forks no table markup', () => {
    expect(streamBody).toMatch(/<EventsTable/)
    expect(streamBody).not.toMatch(/<table/)
    expect(eventStreamSrc.match(/<table/g)).toHaveLength(1)
  })

  it('View-all footer deep-links to the full raw-events surface', () => {
    expect(streamBody).toMatch(/href='\/metrics-events\/raw-events'/)
    expect(streamBody).toMatch(/View all →/)
  })
})

describe('event-stream.tsx — honest statuses + the protected deep link', () => {
  it('row click rides the /metrics-events/raw-events?eventId= contract', () => {
    expect(eventStreamSrc).toMatch(/\/metrics-events\/raw-events\?eventId=/)
  })

  it('renders status chips from the total status map, no inline labels', () => {
    expect(eventStreamSrc).toMatch(
      /EVENT_STATUS_CHIPS\[event\.eventProcessed\]/
    )
  })

  it.each(featureFiles.map((f) => f.slice(FEATURE_DIR.length + 1)))(
    "%s never RENDERS a 'Billed' label because there is no Billed event status (doc mentions are fine)",
    (relPath) => {
      const src = readFileSync(join(FEATURE_DIR, relPath), 'utf8')
      expect(src).not.toMatch(/label:\s*['"`]Billed/)
      expect(src).not.toMatch(/>\s*Billed\s*</)
    }
  )
})

describe('api-keys-tab.tsx — full CRUD in place, key masking intact', () => {
  it('reads and writes ONLY through the api-keys-service hooks — no direct action imports', () => {
    expect(actionModules(apiKeysTabSrc)).toEqual([])
    expect(apiKeysTabSrc).toMatch(
      /import\s*\{\s*useApiKeys,\s*useRevokeApiKey,\s*type ApiKey,?\s*\}\s*from\s*'@\/services\/api-keys-service'/
    )
  })

  it('never touches raw key actions or agent writes', () => {
    for (const name of [
      'createApiKey',
      'deleteApiKey',
      'updateAgent',
      'deleteAgent',
    ]) {
      expect(apiKeysTabSrc).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('has NO full-key readback path: masked stub via keyCellModel, reveal/copy only for LIVE publishable keys', () => {
    expect(apiKeysTabSrc).not.toMatch(/apiKeyHash|apiKeyLookupHash/)
    expect(apiKeysTabSrc).not.toMatch(/apiKeyPlaintext[^\n]*\.slice\(/)
    expect(apiKeysTabSrc).toMatch(/keyCellModel/)
    expect(apiKeysTabSrc).toMatch(/cell\.full && isActiveKey/)
  })

  it('creation happens IN PLACE via the shared CreateKeyPairSheet', () => {
    expect(apiKeysTabSrc).toMatch(
      /import \{ CreateKeyPairSheet \} from '@\/features\/developer-zone\/api-keys\/create-key-pair-sheet'/
    )
    expect(apiKeysTabSrc).toMatch(/<CreateKeyPairSheet/)
    expect(apiKeysTabSrc).not.toMatch(/href='\/developer-zone\/api-keys'/)
  })

  it('active keys by default, revoked visible on demand — parity with the dev-zone page', () => {
    expect(apiKeysTabSrc).toMatch(/status === 'active'/)
    expect(apiKeysTabSrc).toMatch(/Show revoked keys/)
  })

  it('renders the honest Type mapping and null lastUsedAt copy through the pure model', () => {
    expect(apiKeysTabSrc).toMatch(/keyTypeLabel\(key\.keyType\)/)
    expect(apiKeysTabSrc).toMatch(/lastUsedLabel\(key\.lastUsedAt\)/)
  })

  it('revoke toasts (success + failure) live in the shared hook the tab rides', () => {
    expect(apiKeysTabSrc).toMatch(/useRevokeApiKey/)
    expect(apiKeysServiceSrc).toMatch(/title: 'API key revoked'/)
    expect(apiKeysServiceSrc).toMatch(/title: 'Error revoking API key'/)
  })
})

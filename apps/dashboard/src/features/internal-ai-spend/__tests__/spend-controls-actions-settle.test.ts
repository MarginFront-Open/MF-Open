import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * An awaited server action that pends or rejects without the client hearing
 * back makes a button (e.g. Remove on a cap) silently do nothing.
 *
 * The invariant pinned is SETTLEMENT — an action must not be able to strand
 * its caller on any path:
 *   1. no upstream fetch without a deadline,
 *   2. no exported action whose DATABASE work runs outside a deadline (the
 *      fetch signal bounds the forward only; a wedged pooler or a suspended
 *      database compute pends before the forward is ever reached),
 *   3. no exported action that can throw (a throw is a bare rejection the
 *      handlers' res.success branching never sees),
 *   4. no forward skipping the shared header helper,
 *   5. no busy flag without a finally,
 *   6. no .then on an action without a .catch beside it.
 * Source-assertion, same as the sibling tests: dashboard jest is node-only.
 *
 * The counting assertions carry negative controls. A count that only ever runs
 * against the real file proves nothing about what it would reject. For example,
 * a count keyed on `await fetch(` would miss a request written
 * `await globalThis.fetch(...)` with no deadline and no shared headers.
 */

const actionSrc = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'app',
    'actions',
    'spend-controls.ts'
  ),
  'utf8'
)
const tabSrc = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')
const sectionSrc = readFileSync(
  join(__dirname, '..', 'components', 'repo-spend-section.tsx'),
  'utf8'
)

/** Any call shape, not only `await fetch(` — `globalThis.fetch(` counts too. */
const ANY_FETCH = /\bfetch\(/

function occurrences(src: string, pattern: RegExp): number {
  return (src.match(new RegExp(pattern.source, 'g')) ?? []).length
}

/** Each exported action's full source, keyed by name, sliced export-to-export. */
function exportedActions(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const marker = 'export async function '
  let at = src.indexOf(marker)
  while (at !== -1) {
    const nameEnd = src.indexOf('(', at)
    const name = src.slice(at + marker.length, nameEnd).trim()
    const next = src.indexOf(marker, at + 1)
    out.set(name, src.slice(at, next === -1 ? undefined : next))
    at = next
  }
  return out
}

/** Exported actions whose first await is NOT the deadline race, i.e. whose
 * database work can pend outside any bound. */
function unboundedActions(src: string): string[] {
  // Tolerates an explicit type argument (withDeadline<CapActionResult>), which
  // the actions carry so the returned literals keep their discriminants.
  const BOUNDED_FIRST_AWAIT = /^await withDeadline[^(]*\(/
  const unbounded: string[] = []
  for (const [name, body] of exportedActions(src)) {
    const firstAwait = body.indexOf('await ')
    if (
      firstAwait === -1 ||
      !BOUNDED_FIRST_AWAIT.test(body.slice(firstAwait))
    ) {
      unbounded.push(name)
    }
  }
  return unbounded
}

/** A deliberately bad action: real database work, no
 * deadline. Appended to the real source to prove the checks above reject it. */
const UNBOUNDED_MUTANT = `
export async function mutantCap(id: string): Promise<CapActionResult> {
  try {
    const guard = await guardCapWrite()
    if (!guard.ok) return { success: false, error: guard.error }
    return { success: true, data: { ok: true } }
  } catch (err) {
    captureException(err)
    if (isDeadline(err)) return { success: false, error: DEADLINE_MESSAGE }
    return { success: false, error: 'Nope.' }
  }
}
`

/** A raw globalThis.fetch call, which the fetch checks must also catch. */
const RAW_FETCH_MUTANT = `
async function sneakyForward(url: string) {
  return await globalThis.fetch(url)
}
`

describe('app/actions/spend-controls.ts — every action settles', () => {
  it('every fetch carries the shared timeout signal', () => {
    const fetches = occurrences(actionSrc, ANY_FETCH)
    expect(fetches).toBeGreaterThan(0)
    expect(
      occurrences(actionSrc, /signal: AbortSignal\.timeout\(API_TIMEOUT\)/)
    ).toBe(fetches)
  })

  it('every fetch builds its headers through apiForwardHeaders', () => {
    const fetches = occurrences(actionSrc, ANY_FETCH)
    expect(occurrences(actionSrc, /headers: apiForwardHeaders\(/)).toBe(fetches)
  })

  it('negative control: a raw globalThis.fetch breaks both fetch counts', () => {
    const mutated = actionSrc + RAW_FETCH_MUTANT
    expect(occurrences(mutated, ANY_FETCH)).toBe(
      occurrences(actionSrc, ANY_FETCH) + 1
    )
    expect(
      occurrences(mutated, /signal: AbortSignal\.timeout\(API_TIMEOUT\)/)
    ).toBeLessThan(occurrences(mutated, ANY_FETCH))
    expect(occurrences(mutated, /headers: apiForwardHeaders\(/)).toBeLessThan(
      occurrences(mutated, ANY_FETCH)
    )
  })

  it('every exported action races its whole body against a deadline', () => {
    // The fetch signal bounds the forward only. guardCapWrite (session lookup +
    // ba_member read) and the ceiling precheck run BEFORE it, against a pool
    // with no statement_timeout, so the deadline has to start at the top.
    expect(exportedActions(actionSrc).size).toBeGreaterThanOrEqual(6)
    expect(unboundedActions(actionSrc)).toEqual([])
  })

  it('negative control: an action with unbounded database work is rejected', () => {
    expect(unboundedActions(actionSrc + UNBOUNDED_MUTANT)).toEqual([
      'mutantCap',
    ])
  })

  it('the deadline names its own wait, like the fetch-timeout copy beside it', () => {
    const at = actionSrc.indexOf('const DEADLINE_MESSAGE')
    expect(at).toBeGreaterThan(-1)
    const line = actionSrc.slice(at, actionSrc.indexOf('\n', at))
    expect(line).toContain('ACTION_DEADLINE / 1000')
    expect(line).toContain('seconds')
  })

  it('every catch prefers the deadline copy when the deadline is what fired', () => {
    for (const [name, body] of exportedActions(actionSrc)) {
      const catchBody = body.slice(body.indexOf('} catch'))
      expect(`${name}: ${catchBody}`).toMatch(/isDeadline\(err\)/)
      expect(`${name}: ${catchBody}`).toMatch(/DEADLINE_MESSAGE/)
    }
  })

  it('every exported action wraps its body in try/catch', () => {
    const actions = exportedActions(actionSrc)
    expect(actions.size).toBeGreaterThanOrEqual(6)
    for (const [name, body] of actions) {
      // Bound the try to the top of the function, before the first await —
      // a try around only part of the body still leaks throws to the client.
      const beforeFirstAwait = body.slice(0, body.indexOf('await'))
      expect(`${name}: ${beforeFirstAwait}`).toMatch(/try \{/)
      expect(body).toMatch(/\} catch/)
    }
  })

  it('every catch returns the failure arm, never rethrows silently', () => {
    for (const [name, body] of exportedActions(actionSrc)) {
      const catchAt = body.indexOf('} catch')
      const catchBody = body.slice(catchAt)
      expect(`${name}: ${catchBody}`).toMatch(/success: false/)
    }
  })

  it('a 401 or 403 with no body says setup problem, not "try again"', () => {
    // Retrying cannot fix a deploy-config gap, and the advice invites an
    // endless retry loop. api-nest's own 403 message still wins when it sent one.
    const at = actionSrc.indexOf('function httpError')
    expect(at).toBeGreaterThan(-1)
    const body = actionSrc.slice(at, actionSrc.indexOf('\n}', at))
    expect(body).toMatch(/if \(message\) return message/)
    expect(body).toMatch(/status === 401 \|\| status === 403/)
    const armStart = body.indexOf('status === 401')
    const unauthorizedArm = body.slice(
      armStart,
      body.indexOf('\n  }', armStart)
    )
    expect(unauthorizedArm).toMatch(/setup problem/)
    expect(unauthorizedArm).not.toMatch(/try again/i)
  })
})

const WRITE_HANDLERS = ['handleCreate', 'handleSave', 'handleDelete'] as const

/** One write handler's source, sliced function-to-function. */
function handlerBody(handler: string): string {
  const start = tabSrc.indexOf(`async function ${handler}`)
  expect(`${handler}: ${start}`).not.toBe(`${handler}: -1`)
  const end = tabSrc.indexOf('async function', start + 1)
  return tabSrc.slice(start, end === -1 ? undefined : end)
}

describe('internal-ai-spend/index.tsx — no write handler can strand busy', () => {
  it('every setBusy(true) has a finally that releases it', () => {
    const arms = occurrences(tabSrc, /setBusy\(true\)/)
    expect(arms).toBeGreaterThan(0)
    expect(occurrences(tabSrc, /\} finally \{\s*setBusy\(false\)\s*\}/)).toBe(
      arms
    )
  })

  it('setBusy(false) lives only in finally blocks', () => {
    // An early setBusy(false) on the happy path would mask a missing finally:
    // the count would balance while the rejection path still strands the flag.
    expect(occurrences(tabSrc, /setBusy\(false\)/)).toBe(
      occurrences(tabSrc, /\} finally \{\s*setBusy\(false\)\s*\}/)
    )
  })

  it('every write handler catch shows the user a toast', () => {
    for (const handler of WRITE_HANDLERS) {
      const body = handlerBody(handler)
      const catchAt = body.indexOf('} catch')
      expect(`${handler}: ${catchAt}`).not.toBe(`${handler}: -1`)
      const finallyAt = body.indexOf('} finally', catchAt)
      expect(body.slice(catchAt, finallyAt)).toMatch(/toast\(\{/)
    }
  })

  it('every write handler catch also reports to Sentry', () => {
    // A toast disappears when the tab closes, so the failure must also reach
    // error reporting; a client catch that only toasts leaves it invisible.
    expect(tabSrc).toContain(
      "import { captureException } from '@sentry/nextjs'"
    )
    for (const handler of WRITE_HANDLERS) {
      const body = handlerBody(handler)
      const catchAt = body.indexOf('} catch')
      const finallyAt = body.indexOf('} finally', catchAt)
      expect(`${handler}: ${body.slice(catchAt, finallyAt)}`).toMatch(
        /captureException\(err\)/
      )
    }
  })

  it('only the awaited action call sits inside the try', () => {
    // Everything after the success toast (the parent refresh) has to
    // live outside it. Inside, a throw there lands in the catch and fires a
    // failure toast on top of the "Cap removed." the user already read.
    for (const handler of WRITE_HANDLERS) {
      const body = handlerBody(handler)
      const tryBlock = body.slice(
        body.indexOf('try {'),
        body.indexOf('} catch')
      )
      expect(`${handler}: ${tryBlock}`).not.toMatch(/toast\(\{/)
      expect(`${handler}: ${tryBlock}`).not.toMatch(
        /onChanged\(\)|onCreated\(\)/
      )
    }
  })
})

describe('repo-spend-section.tsx — no action call can strand the table', () => {
  it('every .then on an action has a .catch beside it', () => {
    // Without the .catch, a transport-level rejection leaves a permanent
    // skeleton.
    const thens = occurrences(sectionSrc, /\.then\(/)
    expect(thens).toBeGreaterThan(0)
    expect(occurrences(sectionSrc, /\.catch\(/)).toBe(thens)
  })

  it('each catch reports to Sentry and shows that surface its error state', () => {
    expect(sectionSrc).toContain(
      "import { captureException } from '@sentry/nextjs'"
    )
    let at = sectionSrc.indexOf('.catch(')
    let seen = 0
    while (at !== -1) {
      const block = sectionSrc.slice(at, at + 260)
      expect(block).toContain('captureException(err)')
      expect(block).toMatch(/'error'/)
      seen += 1
      at = sectionSrc.indexOf('.catch(', at + 1)
    }
    expect(seen).toBeGreaterThan(0)
  })
})

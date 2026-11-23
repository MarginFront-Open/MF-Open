/**
 * The tour's wiring, source-asserted.
 *
 * Dashboard jest is node-only (no React Testing Library), so the contracts a
 * refactor could quietly break are pinned against the source text, the way
 * print-readiness.test.ts pins the print. The three that matter most: every
 * step points at an element that really carries its attribute, the card is a
 * dialog rather than a tooltip so its buttons can be reached by keyboard, and
 * nothing the tour added can reach paper.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { everyTourStep } from '../tour/tour-steps'

const DASHBOARD_ROOT = join(__dirname, '..', '..', '..', '..')

const read = (relativePath: string) =>
  readFileSync(join(DASHBOARD_ROOT, relativePath), 'utf8')

const FEATURE = 'src/features/roi'

const tourSrc = read(`${FEATURE}/tour/roi-tour.tsx`)
const hookSrc = read(`${FEATURE}/tour/use-roi-tour.ts`)
const stepsSrc = read(`${FEATURE}/tour/tour-steps.ts`)
const launcherSrc = read(`${FEATURE}/tour/show-me-around.tsx`)
const eventsSrc = read(`${FEATURE}/tour/tour-events.ts`)
const indexSrc = read(`${FEATURE}/index.tsx`)
const detailSrc = read(`${FEATURE}/detail.tsx`)
const printSrc = read(`${FEATURE}/components/board-ready-export.tsx`)
const withoutAiSrc = read(`${FEATURE}/components/without-ai.tsx`)
const dialogSrc = read(`${FEATURE}/components/initiative-dialog.tsx`)

/** Every file that could legitimately carry a data-tour attribute. */
const ANCHOR_HOSTS = [
  `${FEATURE}/index.tsx`,
  `${FEATURE}/components/roi-report.tsx`,
  `${FEATURE}/components/without-ai.tsx`,
  `${FEATURE}/components/finished-work.tsx`,
  `${FEATURE}/components/initiative-card.tsx`,
  `${FEATURE}/components/board-ready-export.tsx`,
  `${FEATURE}/tour/show-me-around.tsx`,
  'src/features/dashboard-shell/segmented-control.tsx',
  'src/features/dashboard-shell/date-range-selector.tsx',
  'src/features/build/components/getting-started-nudge.tsx',
  'src/components/layout/nav-user.tsx',
].map((path) => read(path))

const ANCHOR_SOURCE = ANCHOR_HOSTS.join('\n')

const anchors = [...new Set(everyTourStep().map((step) => step.anchor))].sort()

describe('every step points at an element that really carries its attribute', () => {
  it.each(anchors)('%s is attached to a real element', (anchor) => {
    // Either spelled on the element itself, or handed to a shared component
    // through its pass-through prop, which is how a control the ROI page does
    // not own (the date range, the account menu) gets an anchor.
    const literal = `data-tour='${anchor}'`
    const passThrough = `dataTour='${anchor}'`
    expect(
      ANCHOR_SOURCE.includes(literal) || ANCHOR_SOURCE.includes(passThrough)
    ).toBe(true)
  })

  it('the shared controls take a pass-through prop rather than a wrapper', () => {
    const segmented = read('src/features/dashboard-shell/segmented-control.tsx')
    expect(segmented).toMatch(/dataTour\?: string/)
    expect(segmented).toMatch(/data-tour=\{dataTour\}/)
    const printButton = printSrc.slice(
      printSrc.indexOf('export function BoardReadyExportButton'),
      printSrc.indexOf('function PrintComparisonRow')
    )
    expect(printButton).toMatch(/data-tour=\{dataTour\}/)
  })

  it('the estimate anchor survives the press that opens the form', () => {
    // The button unmounts the moment it is pressed, so with the anchor only on
    // the button the step would lose its target exactly when the customer
    // obeyed it.
    // The button and the form are mutually exclusive on `open`, so the three
    // spellings never match two nodes at once.
    const literal = /data-tour='estimate-without-ai'/g
    expect(withoutAiSrc.match(literal)).toHaveLength(3)
    const openForm = withoutAiSrc.slice(withoutAiSrc.indexOf('{open && ('))
    expect(openForm.match(literal)).toHaveLength(1)
  })

  it('the goal card carries its own id, so the step lands on the goal that was created', () => {
    const cardSrc = read(`${FEATURE}/components/initiative-card.tsx`)
    expect(cardSrc).toContain("data-tour='goal-card'")
    expect(cardSrc).toMatch(/data-tour-id=\{view\.id\}/)
    expect(stepsSrc).toMatch(/data-tour-id/)
  })

  it('the search asks the pure rule which element it wants, and asks it every tick', () => {
    // The grid is ordered by start date and the created card arrives late, so
    // a search that took the first goal-card it saw would keep somebody else's
    // goal for the rest of the step.
    const hook = hookSrc.slice(hookSrc.indexOf('export function useTourTarget'))
    expect(hook).toMatch(
      /tourTargetSelector\(\{ anchor: step\.anchor, pinnedGoalId \}\)/
    )
    expect(hook).toMatch(/document\.querySelector<HTMLElement>\(selector\)/)
    // One query in the search, so there is no second, wider one to fall back
    // to while the created card is on its way.
    expect(hook.match(/document\.querySelector/g)).toHaveLength(1)
    expect(hook).not.toMatch(/goal-card/)
  })

  it('the create hands the tour the id of the goal it made', () => {
    const saved = dialogSrc.slice(
      dialogSrc.indexOf('let createdId'),
      dialogSrc.indexOf("notifyRoiTour({ kind: 'goal-created'") + 120
    )
    expect(saved).toMatch(/createdId = created\.data\.id/)
    expect(saved).toMatch(
      /if \(createdId\)\s*\n?\s*notifyRoiTour\(\{ kind: 'goal-created', initiativeId: createdId \}\)/
    )
    // And the hook pins what it was handed before it moves the step on.
    const signal = hookSrc.slice(hookSrc.indexOf('subscribeToRoiTour(('))
    expect(signal).toMatch(
      /if \(signal\.kind === 'goal-created'\) setPinnedGoalId\(signal\.initiativeId\)/
    )
  })
})

describe('the card is a dialog, not a tooltip', () => {
  it('announces itself to a screen reader and takes focus on its heading', () => {
    expect(tourSrc).toMatch(/role='dialog'/)
    expect(tourSrc).not.toMatch(/role='tooltip'/)
    expect(tourSrc).toMatch(/aria-labelledby=/)
    expect(tourSrc).toMatch(/aria-describedby=/)
    expect(tourSrc).toMatch(/aria-live='polite'/)
    expect(tourSrc).toMatch(/\.focus\(\)/)
  })

  it('Escape closes it from anywhere on the page', () => {
    expect(tourSrc).toMatch(/'Escape'/)
    expect(tourSrc).toMatch(/addEventListener\('keydown'/)
  })

  it('Escape closes the tour only when the tour is the top layer', () => {
    // Step four asks for the goal dialog. Radix dismisses that dialog on the
    // same native keydown without stopping it, so an unguarded handler would
    // read the customer backing out of the form as dismissing the tour, which
    // is permanent.
    const handler = tourSrc.slice(
      tourSrc.indexOf("if (event.key !== 'Escape')"),
      tourSrc.indexOf("onClose('escape')")
    )
    expect(handler).toMatch(/event\.defaultPrevented/)
    expect(handler).toMatch(/anotherLayerOwnsEscape\(\)/)
    expect(tourSrc).toMatch(/data-radix-popper-content-wrapper/)
    expect(tourSrc).toMatch(
      /TOP_LAYER_ROLES = new Set\(\['dialog', 'alertdialog', 'menu'\]\)/
    )
  })

  it('nothing advances on a timer', () => {
    expect(tourSrc).not.toMatch(/setInterval\(/)
    expect(tourSrc).not.toMatch(/setTimeout\([^)]*next/)
  })

  it('respects a reader who asked for less movement', () => {
    expect(tourSrc).toMatch(/prefers-reduced-motion/)
  })

  it('the dim layer never swallows a click — the page stays usable', () => {
    expect(tourSrc).toMatch(/pointer-events-none/)
  })

  it('the dim layer is actually tinted, and the control in the hole is ringed', () => {
    // An alpha-modified mf token like `bg-mf-bg/60` compiles to nothing: the
    // mf colors are bare var(--mf-x) strings, and Tailwind drops an
    // alpha-modified utility built on a value it cannot read as a color. Every
    // panel would compute to fully transparent, leaving no spotlight.
    expect(tourSrc).toMatch(/const LAYER_PANEL = 'absolute bg-black\/30'/)
    expect(tourSrc).toMatch(
      /const HIGHLIGHT_RING = '[^']*ring-2 ring-mf-accent'/
    )
    // No alpha modifier on an mf token anywhere in the file, comments aside.
    const code = tourSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
    expect(code).not.toMatch(/-mf-[a-z0-9]+\/\d/)
  })

  it('it sits under the Radix portals, so a dialog or a menu opened from a step still works', () => {
    // ui/dialog and ui/dropdown-menu are z-50; ui/tooltip is z-60.
    for (const zIndex of tourSrc.match(/z-\[(\d+)\]/g) ?? []) {
      expect(Number(/\d+/.exec(zIndex)?.[0])).toBeLessThan(50)
    }
    expect(tourSrc).toMatch(/z-\[\d+\]/)
  })
})

describe('nothing the tour added can reach paper', () => {
  it('the layer and the card are both no-print', () => {
    expect((tourSrc.match(/no-print/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('the print still has exactly one door, and it tells the tour before it opens', () => {
    expect(printSrc.match(/window\.print\(/g)).toHaveLength(1)
    const opener = printSrc.slice(
      printSrc.indexOf('export function openBoardReadyPrint'),
      printSrc.indexOf('window.print(')
    )
    expect(opener).toMatch(/notifyRoiTour/)
  })
})

describe('the page wires the tour once, and only where it belongs', () => {
  it('Show me around is the first control in the ROI header extras', () => {
    const start = indexSrc.indexOf('headerExtras=')
    const end = indexSrc.indexOf('<div className=', start)
    const block = indexSrc.slice(start, end)
    const components = block.match(/<[A-Z][A-Za-z]*/g) ?? []
    expect(components[0]).toBe('<ShowMeAround')
  })

  it('the tour is mounted on the ROI page and nowhere else', () => {
    expect(indexSrc).toMatch(/<RoiTour/)
    expect(detailSrc).not.toMatch(/RoiTour/)
    expect(detailSrc).not.toMatch(/use-roi-tour/)
  })

  it('the first-event read happens once on the page, and the nudge is handed the answer', () => {
    expect(indexSrc.match(/getHasIngestedFirstEvent\(\)/g)).toHaveLength(1)
    expect(indexSrc).toMatch(/<GettingStartedNudge[\s\S]{0,120}hasEvents=\{/)
    const nudgeSrc = read(
      'src/features/build/components/getting-started-nudge.tsx'
    )
    // The nudge still fetches for the surfaces that do not pass it in.
    expect(nudgeSrc).toMatch(/hasEvents\?: boolean \| null/)
  })

  it('a first-event read that throws still lets the tour open', () => {
    // The read answering badly is not a claim of zero and not a reason to
    // guide nobody: unread and unknown both resolve to the core tour.
    const start = indexSrc.indexOf('getHasIngestedFirstEvent()')
    const effect = indexSrc.slice(start - 200, start + 600)
    expect(effect).toMatch(/\} catch \{/)
    expect(effect).toMatch(/\} finally \{/)
    expect(effect).toMatch(/if \(!cancelled\) setHasEventsRead\(true\)/)
  })

  it('the tour never opens while the goal dialog is open', () => {
    expect(indexSrc).toMatch(/suppressed: dialogOpen/)
  })

  it('the tour waits for any modal that holds the screen, not only the goal dialog', () => {
    // The setup-method modal in DashboardClientLayout opens on every dashboard
    // load and holds the screen for about a second, until the org's saved
    // choice comes back. It traps focus, so an opening card shown under it
    // loses its focus to the trap and then to the body when the modal
    // unmounts.
    expect(hookSrc).toMatch(/function aModalOwnsTheScreen\(\): boolean/)
    expect(hookSrc).toMatch(
      /MODAL_ROLES = new Set\(\['dialog', 'alertdialog'\]\)/
    )
    const owns = hookSrc.slice(
      hookSrc.indexOf('function aModalOwnsTheScreen'),
      hookSrc.indexOf('export function useRoiTour')
    )
    expect(owns).toMatch(/document\.querySelectorAll\('\[data-state\]'\)/)
    expect(owns).toMatch(/=== 'open'/)
    const loop = hookSrc.slice(
      hookSrc.indexOf('const openWhenTheScreenIsFree = ()'),
      hookSrc.indexOf('openWhenTheScreenIsFree()\n')
    )
    expect(loop).toMatch(/if \(aModalOwnsTheScreen\(\)\)/)
    expect(loop).toMatch(
      /window\.setTimeout\(openWhenTheScreenIsFree, MODAL_POLL_MS\)/
    )
    // The wait is not the dismissal: nothing is settled until it opens.
    expect(loop).toMatch(
      /if \(!settled\.current\) open\(autoPlan, at, 'auto'\)/
    )
  })

  it('the tour waits for the overview and the report before it opens itself', () => {
    const call = indexSrc.slice(
      indexSrc.indexOf('useRoiTour({'),
      indexSrc.indexOf('const subtitle')
    )
    expect(call).toMatch(/ready:/)
    expect(call).toMatch(/goalsRead/)
    expect(call).toMatch(/reportState/)
    expect(call).toMatch(/hasEventsRead/)
  })
})

describe('persistence reads browser storage safely', () => {
  it('the dismissal key is read inside an effect, never during a render', () => {
    const read = hookSrc.indexOf('storage.getItem(TOUR_STORAGE_KEY)')
    expect(read).toBeGreaterThan(-1)
    const effect = hookSrc.lastIndexOf('useEffect(', read)
    expect(effect).toBeGreaterThan(-1)
    expect(hookSrc).not.toMatch(/useState\([^)]*storage\.getItem/)
  })

  it('it writes through the shared storage wrapper, not raw localStorage', () => {
    expect(hookSrc).toMatch(/from '@\/lib\/storage'/)
    expect(hookSrc).not.toMatch(/\blocalStorage\b/)
  })

  it('every write goes through the two pure rules, so a chapter and the launcher cannot reach the key', () => {
    expect(hookSrc.match(/storage\.setItem\(/g)).toHaveLength(1)
    expect(hookSrc).toMatch(/runWritesResumeStep\(\{/)
    expect(hookSrc).toMatch(/runWritesDismissal\(\{/)
    // The rules need to know which door opened the run, so the session has to
    // carry it from the moment it opens.
    expect(hookSrc).toMatch(/startedBy: TourStartSource/)
    expect(hookSrc).toMatch(/startedBy: session\.startedBy/)
  })
})

describe('the auto-advance signals come from the controls themselves', () => {
  it('saving your numbers tells the tour', () => {
    expect(withoutAiSrc).toMatch(/notifyRoiTour\(\{ kind: 'numbers-saved' \}\)/)
  })

  it('creating a goal tells the tour which goal it was', () => {
    expect(dialogSrc).toMatch(/notifyRoiTour\(\{[\s\S]{0,80}'goal-created'/)
    expect(dialogSrc).toMatch(/initiativeId/)
  })

  it('the emitter is a module-level subscription, so no control needs a new prop', () => {
    expect(eventsSrc).toMatch(/export function notifyRoiTour/)
    expect(eventsSrc).toMatch(/export function subscribeToRoiTour/)
  })
})

describe('the tour module carries no rendered prose of its own', () => {
  it('every customer-facing string in the components comes from tour-steps.ts', () => {
    for (const src of [tourSrc, launcherSrc]) {
      const withoutComments = src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
      const prose = (withoutComments.match(/>[^<>{}]+</g) ?? [])
        .map((fragment) => fragment.slice(1, -1).trim())
        .filter((fragment) => /^[A-Za-z][A-Za-z ,.'-]{3,}$/.test(fragment))
      expect(prose).toEqual([])
    }
  })

  it('the copy module is pure — no React, no browser globals', () => {
    // Its own copy says "the print window" and "one board-ready document", so
    // the scan runs on code with the strings and the comments taken out.
    const code = stepsSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
      .replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''")
    expect(code).not.toMatch(/from 'react'/)
    expect(code).not.toMatch(/\bdocument\b/)
    expect(code).not.toMatch(/\bwindow\b/)
    expect(code).not.toMatch(/\blocalStorage\b/)
  })
})

describe('the card keeps hold of the control it points at', () => {
  it('the search runs for as long as the step is open, never for a fixed 1.5s', () => {
    // Step five follows the create, and the created card cannot exist until
    // the overview refetch lands. A search that gave up would tell the
    // customer to create the goal they made one second ago.
    const hook = hookSrc.slice(hookSrc.indexOf('export function useTourTarget'))
    expect(hook).toMatch(/timer = window\.setTimeout\(look, TARGET_POLL_MS\)/)
    // The wait only decides when the written fallback may show, not when the
    // looking stops: the reschedule sits outside every early return.
    const loop = hook.slice(
      hook.indexOf('const look = ()'),
      hook.indexOf('timer = window.setTimeout(look, 0)')
    )
    const giveUp = loop.indexOf('TARGET_WAIT_MS')
    const reschedule = loop.indexOf(
      'timer = window.setTimeout(look, TARGET_POLL_MS)'
    )
    expect(giveUp).toBeGreaterThan(-1)
    expect(reschedule).toBeGreaterThan(giveUp)
    expect(loop).not.toMatch(
      /TARGET_WAIT_MS[\s\S]*?\breturn\b[\s\S]*?setTimeout\(look, TARGET_POLL_MS\)/
    )
  })

  it('a detached or zero-size target counts as not found', () => {
    expect(hookSrc).toMatch(/isPointableTarget/)
    expect(hookSrc).toMatch(/element\.isConnected/)
    const hook = hookSrc.slice(hookSrc.indexOf('export function useTourTarget'))
    expect(hook).toMatch(/if \(!pointable\(pinned\)\)/)
    expect(stepsSrc).toMatch(/export function isPointableTarget/)
  })

  it('the card never measures against a node that has left the page', () => {
    const measure = tourSrc.slice(
      tourSrc.indexOf('const measure = useCallback'),
      tourSrc.indexOf('}, [target])')
    )
    expect(measure).toMatch(/!target \|\| !target\.isConnected/)
  })

  it('the written fallback waits for the search to finish', () => {
    expect(tourSrc).toMatch(
      /target \|\| !searched \? step\.action : step\.missingTargetText/
    )
  })
})

describe('the card is reachable the moment it opens', () => {
  it('it is parked off screen while it measures, never hidden', () => {
    // A `visibility: hidden` subtree takes no focus and is out of the
    // accessibility tree, and that is the exact frame the opening card of
    // every tour and every chapter renders in.
    const code = tourSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
    expect(code).not.toMatch(/visibility:/)
    expect(code).toMatch(/left: placement\?\.left \?\? OFF_SCREEN_LEFT/)
  })

  it('it appears beside its control rather than flying in from the parking spot', () => {
    // A transition starts whenever the style a property lands in carries the
    // transition, however new that style is, so turning the glide on in the
    // same commit as the first placement animates the card in from -10000.
    expect(tourSrc).toMatch(
      /canGlide && !reducedMotion[\s\S]{0,40}transition-\[top,left\] duration-200/
    )
    expect(tourSrc).toMatch(/if \(!placement \|\| canGlide\) return/)
    expect(tourSrc).toMatch(
      /requestAnimationFrame\(\(\) => setCanGlide\(true\)\)/
    )
  })

  it('focus follows the card back on screen once it has a place to sit', () => {
    const start = tourSrc.indexOf('if (!placement) return')
    expect(start).toBeGreaterThan(-1)
    const effect = tourSrc.slice(
      start,
      tourSrc.indexOf('}, [step.id, placement])') + 24
    )
    expect(effect).toMatch(/heading\.focus\(\)/)
    // Once per step: a scroll re-measure must not pull focus off a control
    // the step asked the customer to use.
    expect(effect).toMatch(/focusedFor\.current === step\.id/)
    // The step is claimed on a focus that landed, never on the attempt. A
    // modal focus trap elsewhere on the page can pull the opening card's focus
    // straight back and leave it on the body, and a step marked focused on a
    // focus it never got would never try again.
    expect(effect).toMatch(
      /if \(document\.activeElement === heading\) focusedFor\.current = step\.id/
    )
    // Re-asserted only from the body, which belongs to nobody.
    expect(effect).toMatch(/document\.activeElement !== document\.body/)
  })

  it('closing the tour puts focus back on Show me around, whichever door was used', () => {
    // In the hook rather than the card, because the last core step finishes on
    // the print signal, which closes the tour without any card button being
    // pressed. A keyboard customer must not come back from the print dialog
    // with focus on the document.
    const closer = hookSrc.slice(
      hookSrc.indexOf('const close = useCallback'),
      hookSrc.indexOf('const next = useCallback')
    )
    expect(closer).toMatch(/data-tour='show-me-around'/)
    expect(closer).toMatch(/\.focus\(\)/)
    expect(tourSrc).not.toMatch(/show-me-around/)
    // Done, Skip, the X and Escape: four doors in the card, one close.
    expect((tourSrc.match(/onClose\('/g) ?? []).length).toBe(4)
    // And the fifth door, the print signal, goes through the same close.
    const signal = hookSrc.slice(hookSrc.indexOf('subscribeToRoiTour(('))
    expect(signal).toMatch(/close\('done'\)/)
  })
})

describe('the step scrolls its control into view exactly once', () => {
  it('the sticky-header allowance rides the scroll, not a second one after it', () => {
    // scrollIntoView is asynchronous under smooth behavior, so a correction
    // read from getBoundingClientRect on the next line is read from where the
    // control sat before the scroll, and the two scrolls compose.
    const code = tourSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:/])\/\/[^\n]*/g, '$1')
    expect(code).not.toMatch(/scrollBy/)
    expect(code.match(/scrollIntoView/g)).toHaveLength(1)
    const effect = tourSrc.slice(
      tourSrc.indexOf('target.scrollIntoView'),
      tourSrc.indexOf('const measure = useCallback')
    )
    expect(effect).toMatch(/block: 'start'/)
    expect(effect).toMatch(/reducedMotion \? 'auto' : 'smooth'/)
    expect(effect).not.toMatch(/getBoundingClientRect/)
  })

  it('the sticky-header allowance is a scroll margin the browser applies itself', () => {
    const css = read('src/index.css')
    expect(css).toMatch(/\[data-tour\]\s*\{[^}]*scroll-margin-top:\s*72px/)
    // Never an inline style written onto a control the tour does not own.
    expect(tourSrc).not.toMatch(/scrollMarginTop/)
  })
})

describe('the tab belongs to the customer once a step has had its move', () => {
  it('the hook asks the pure rule, it does not force the tab on every render', () => {
    const effect = hookSrc.slice(
      hookSrc.indexOf('const decision = tourTabSwitch({') - 400,
      hookSrc.indexOf('if (decision.switchTo) onTabChange(decision.switchTo)') +
        60
    )
    expect(effect).toMatch(/switchedFor: switchedTabFor\.current/)
    expect(effect).toMatch(/switchedTabFor\.current = decision\.switchedFor/)
    // Nothing calls onTabChange with a step's tab unless the rule says so.
    expect(hookSrc).not.toMatch(/onTabChange\(step\.tab\)/)
  })
})

/**
 * Node-env unit tests (no RTL, no jsdom) for the install-kit generator.
 * The kit copy is a pure function precisely
 * so its plain phrasing, its verbatim lines, and the paste-able Path B
 * GUIDE prompt can be pinned here without mounting a React component. Mirrors
 * spend-controls-utils.test.ts.
 */
import {
  buildCaplessInstallKit,
  buildInstallKit,
  fillPathBPrompt,
  formatArmingAndSupport,
  formatKitPlainText,
  ADMIN_SEND_CHECKLIST,
  ARMING_LINE,
  CAPS_LATER_NOTE,
  PATH_A_ONELINER,
  PATH_B_VERIFY_COMMAND,
  PATH_B_PROMPT_TEMPLATE,
  SUPPORT_NOTE,
  WINDOWS_WSL_NOTE,
  WINDOWS_WSL_SENTENCE,
} from '../install-kit'
import { publicApiBaseUrl } from '@/config/operator'
import { sourceRepoLabel } from '@/config/source-install'

const SAMPLE = {
  orgName: 'Acme',
  capSentence: 'Stop AI spend at $5,000 across the whole team per month',
  mode: 'enforce' as const,
  whyNote: 'We went over budget last month.',
  setterName: 'Jordan Lee',
}

// The whole kit as one string — the frontier-guard word checks run against
// everything a reader (human or coding agent) could see, not just one section.
function kitText(
  input: Parameters<typeof buildInstallKit>[0] = SAMPLE
): string {
  const kit = buildInstallKit(input)
  return [
    kit.title,
    kit.whyNote.heading,
    ...kit.whyNote.lines,
    kit.keyReady.heading,
    ...kit.keyReady.lines,
    kit.pathA.heading,
    kit.pathA.intro,
    kit.pathA.command,
    kit.pathA.after,
    kit.windowsNote,
    kit.pathB.heading,
    kit.pathB.intro,
    kit.pathB.prompt,
    kit.armingLine ?? '',
    kit.supportNote,
    kit.capsLaterNote ?? '',
  ].join('\n')
}

// ── Kit generated per team/provider — both paths + arming line ─────────

describe('buildInstallKit — the two paths and the arming line', () => {
  it('returns Path A and Path B plus the arming line', () => {
    const kit = buildInstallKit(SAMPLE)
    expect(kit.pathA.command).toBe(PATH_A_ONELINER)
    expect(kit.pathB.prompt.length).toBeGreaterThan(0)
    expect(kit.armingLine).toBe(ARMING_LINE)
  })

  it('pins the arming line verbatim', () => {
    expect(ARMING_LINE).toBe(
      'Claude Code arms on your next session, or a /hooks reload. Codex needs one more step: run /hooks inside codex once and trust the MarginFront cap check. Once armed, cap updates apply to running sessions too.'
    )
    expect(kitText()).toContain(ARMING_LINE)
  })

  // The two tools do NOT arm the same way. Claude Code arms itself on the next
  // session; a Codex hook sits there enabled and untrusted, doing nothing, until
  // the developer trusts it in /hooks. One merged sentence would read as "both
  // arm on their own", leaving a teammate believing in a cap that never fires.
  it('the arming line splits the two tools instead of promising one behavior', () => {
    expect(ARMING_LINE).toContain('Claude Code arms on your next session')
    expect(ARMING_LINE).toContain('Codex needs one more step')
    expect(ARMING_LINE).toMatch(/run \/hooks inside codex once/)
  })

  it('pins the Path A one-liner verbatim — never re-typed', () => {
    expect(PATH_A_ONELINER).toBe(
      `git clone ${sourceRepoLabel()} marginfront && cd marginfront && npm ci && npx turbo run build --filter=@marginfront/code-cost-clarity && node packages/code-cost-clarity/dist/cli.js init --control`
    )
  })

  // The meter is built from the MarginFront source on the teammate's own
  // computer, so it talks to the operator's own install. No kit line may reach
  // for a public package registry.
  it('builds from source and never installs from a package registry', () => {
    expect(PATH_A_ONELINER).toContain('npx turbo run build')
    expect(kitText()).not.toMatch(/npx @marginfront|npm install @marginfront/)
    expect(kitText()).not.toContain('npmjs.com')
    expect(kitText()).not.toContain('marginfront.com')
  })

  it('tells the teammate which server address the meter needs', () => {
    expect(buildInstallKit(SAMPLE).pathA.after).toContain(
      `When it asks for your MarginFront server address, enter ${publicApiBaseUrl()}`
    )
  })

  it('addresses Path A to a teammate, not a developer', () => {
    expect(buildInstallKit(SAMPLE).pathA.heading).toBe(
      'For a teammate: one line'
    )
  })

  it('names who set the cap, what it is, and why (the admin note on top)', () => {
    const kit = buildInstallKit(SAMPLE)
    const note = kit.whyNote.lines.join('\n')
    expect(note).toContain('Jordan Lee')
    expect(note).toContain('Acme')
    expect(note).toContain(SAMPLE.capSentence)
    expect(note).toContain('We went over budget last month.')
  })

  it('falls back to an honest line when the admin leaves the why-note blank', () => {
    const kit = buildInstallKit({ ...SAMPLE, whyNote: '' })
    const note = kit.whyNote.lines.join('\n')
    expect(note).toContain('No note was added')
  })
})

// ── The key-ready section ─────────────────────

describe('the key-ready section — have your mf_sk_ key before you start', () => {
  it('sits between the admin note and Path A, and names the key prefix', () => {
    const kit = buildInstallKit(SAMPLE)
    expect(kit.keyReady.heading).toBe('First: have your MarginFront key ready')
    const lines = kit.keyReady.lines.join('\n')
    expect(lines).toContain('mf_sk_')
    // Both honest routes to a key: create your own, or the admin sent one.
    expect(lines).toContain('Build > API keys > "Create key pair"')
    expect(lines).toContain('your admin may have sent you one')
    // The no-key path is ask-first, never guess-and-stall mid-install.
    expect(lines).toContain('Ask your admin before you start')
  })

  it('renders between the admin note and Path A in the copied kit', () => {
    const text = formatKitPlainText(buildInstallKit(SAMPLE))
    const iNote = text.indexOf('The note from your admin')
    const iKey = text.indexOf('First: have your MarginFront key ready')
    const iPathA = text.indexOf('For a teammate: one line')
    expect(iNote).toBeGreaterThan(-1)
    expect(iKey).toBeGreaterThan(iNote)
    expect(iPathA).toBeGreaterThan(iKey)
  })
})

// ── The admin send checklist (on-screen only) ─────────────────────────

describe('ADMIN_SEND_CHECKLIST — sender guidance, never in the copied kit', () => {
  it('covers both tools including the desktop apps, and both key routes', () => {
    const lines = ADMIN_SEND_CHECKLIST.lines.join('\n')
    expect(ADMIN_SEND_CHECKLIST.heading).toBe('Before you send this kit')
    expect(lines).toContain(
      'One kit covers Claude Code and Codex, the terminal versions and the desktop apps.'
    )
    // Invite route, with the role that can actually create keys.
    expect(lines).toContain('Settings, then Team, then Invite member')
    expect(lines).toContain('Developer role')
    expect(lines).toMatch(/plain Member can't create keys/)
    // Hand-over route: password manager, never chat or email.
    expect(lines).toContain('password manager, never Slack or email')
  })

  it('never leaks into the plain-text kit a teammate receives', () => {
    const text = formatKitPlainText(buildInstallKit(SAMPLE))
    expect(text).not.toContain(ADMIN_SEND_CHECKLIST.heading)
    expect(text).not.toContain('Invite member')
  })
})

// ── Path B is a single testable artifact (exported + snapshot-pinned) ───

describe('Path B prompt — one exported, pinned artifact', () => {
  it('exports the raw template as a constant with fillable placeholders', () => {
    expect(typeof PATH_B_PROMPT_TEMPLATE).toBe('string')
    expect(PATH_B_PROMPT_TEMPLATE).toContain('{{SETTER_NAME}}')
    expect(PATH_B_PROMPT_TEMPLATE).toContain('{{ORG_NAME}}')
    expect(PATH_B_PROMPT_TEMPLATE).toContain('{{CAP_SENTENCE}}')
    expect(PATH_B_PROMPT_TEMPLATE).toContain('{{MODE_WORD}}')
    expect(PATH_B_PROMPT_TEMPLATE).toContain('{{WHY_NOTE}}')
  })

  it('fills every placeholder — no {{token}} survives into the shipped prompt', () => {
    const kit = buildInstallKit(SAMPLE)
    expect(kit.pathB.prompt).not.toMatch(/{{|}}/)
  })

  it('the dialog and the pure function agree (one fill path)', () => {
    const kit = buildInstallKit(SAMPLE)
    expect(kit.pathB.prompt).toBe(
      fillPathBPrompt({
        setterName: 'Jordan Lee',
        orgName: 'Acme',
        capSentence: SAMPLE.capSentence,
        modeWord: 'Enforce',
        whyNote: 'We went over budget last month.',
      })
    )
  })

  it('pins the exact filled prompt', () => {
    const kit = buildInstallKit(SAMPLE)
    expect(kit.pathB.prompt).toBe(EXPECTED_PATH_B)
  })

  it('is a GUIDE: the human runs the one-liner, the agent verifies — no invented subcommand', () => {
    expect(PATH_B_VERIFY_COMMAND).toBe('node ~/.marginfront-ccc/cli.js status')
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    expect(prompt).toContain(PATH_A_ONELINER)
    expect(prompt).toContain(PATH_B_VERIFY_COMMAND)
    // The human runs the install themselves — it asks for their secret key.
    expect(prompt).toContain('Have me run this one line')
    expect(prompt).toContain(
      'I run it myself because it asks me to paste my secret key.'
    )
    // No fictional "control status" / "verify" / "doctor" subcommand.
    expect(prompt).not.toMatch(
      /control status|ccc verify|control verify|doctor/
    )
  })

  it('never tells the agent to run non-interactive (--no-prompt is banned from kit copy)', () => {
    expect(kitText()).not.toContain('--no-prompt')
    expect(ADMIN_SEND_CHECKLIST.lines.join('\n')).not.toContain('--no-prompt')
  })

  it('tells the both-tools truth: the check pauses Claude Code and Codex', () => {
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    expect(prompt).toContain(
      'the check pauses new Claude Code and Codex tool calls'
    )
    // Fail-open stays.
    expect(prompt).toContain(
      'If that file is missing or old, the check does nothing and my work keeps going.'
    )
  })

  // The only provenance a pasted kit can carry is a name, and the thing that
  // name authorizes is a cap that can pause a whole team. So the first step
  // sends the human back to a channel they already trust, and it happens before
  // anything is installed.
  it('checks the request is really approved before it installs anything', () => {
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    expect(prompt).toContain('First, have me confirm this is really approved')
    expect(prompt).toContain("A name in a message isn't proof on its own")
    expect(prompt).toContain('Jordan Lee or my IT admin')
    expect(prompt).toContain('through a channel I already trust')
    // Before the install line, not after it.
    expect(prompt.indexOf('really approved')).toBeLessThan(
      prompt.indexOf(PATH_A_ONELINER)
    )
  })

  // The line builds code from a repository and then takes a secret key. The
  // agent reads that source first, and it can stop.
  it('has the agent check the source before a human types a key into it', () => {
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    expect(prompt).toContain("Look at the meter's source before we install it")
    expect(prompt).toContain(
      `packages/code-cost-clarity folder of ${sourceRepoLabel()}`
    )
    expect(prompt).toContain('If anything looks off, say so and stop here.')
    expect(prompt.indexOf("Look at the meter's source")).toBeLessThan(
      prompt.indexOf(PATH_A_ONELINER)
    )
  })

  // --control is the difference between a meter and a brake. An agent that
  // cannot tell which one it is arming cannot judge the request, and the human
  // pasting it deserves the same sentence.
  it('says what --control does and names the cap it turns on', () => {
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    expect(prompt).toContain(
      'The --control part is what adds the spend cap. Without it, the command sets up the meter and nothing else.'
    )
    expect(prompt).toContain(
      `The cap it turns on is the one named above: ${SAMPLE.capSentence}`
    )
    // The scope choice ("whole team or just me") is still stated up front.
    expect(prompt).toContain('The cap can cover the whole team or only me.')
  })

  // A pause with no banner looks exactly like a broken tool. Told in advance,
  // the teammate asks for a raise instead of filing a bug.
  it('warns that tool calls can pause mid-session once the cap is armed', () => {
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    expect(prompt).toContain(
      'a tool call can pause part-way through a session with no other warning'
    )
    expect(prompt).toContain(
      'If that happens, the cap did its job, and I should ask my admin to raise it.'
    )
  })

  // We cannot see the Codex build on the teammate's machine, so the /hooks
  // reminder ships with a way out instead of a dead end.
  it('gives a fallback if codex does not know the /hooks command', () => {
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    expect(prompt).toContain("If codex doesn't know that command")
    expect(prompt).toContain(
      "check Codex's own docs for how to review and reload hooks"
    )
  })

  it('verifies the wiring for BOTH tools and the Codex arming step', () => {
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    expect(prompt).toContain('.claude/settings.json')
    expect(prompt).toContain('check-cap.py')
    expect(prompt).toContain(
      '~/.codex/hooks.json has the MarginFront cap entry'
    )
    expect(prompt).toContain('run /hooks once inside codex to finish arming')
    // The wrap-up: report back, then the quit-and-reopen reminder.
    expect(prompt).toContain('Tell me in a few words')
    expect(prompt).toContain(
      'quit and reopen Claude and Codex so counting starts'
    )
  })

  it('gives the agent a legible, verifiable policy (provenance + what the check does + fail-open)', () => {
    const prompt = buildInstallKit(SAMPLE).pathB.prompt
    // Provenance.
    expect(prompt).toContain('Jordan Lee')
    expect(prompt).toContain('Acme')
    // What the check actually does — a local file, not an opaque hook.
    expect(prompt).toContain('one small file')
    expect(prompt).toMatch(/makes no network calls|no network calls/)
    // Fail-open, in plain words.
    expect(prompt).toMatch(/missing or old/)
    expect(prompt).toContain('does nothing')
  })
})

// ── Phrasing checked against frontier-model guards ─────────────────────

describe('kit copy — passes the frontier-model guard phrasing rules', () => {
  it('uses plain words — never "block", "bypass", or "deny"', () => {
    const text = kitText().toLowerCase()
    expect(text).not.toContain('bypass')
    expect(text).not.toContain('deny')
    expect(text).not.toContain('block')
  })

  it('keeps the Path A one-liner visible next to Path B (never agent-only)', () => {
    const kit = buildInstallKit(SAMPLE)
    // Both paths present in the kit the admin copies.
    expect(kit.pathA.command).toBe(PATH_A_ONELINER)
    expect(kit.pathB.prompt).toContain('init --control')
  })

  it('ships the one-line support note (the "if your agent declines" fallback)', () => {
    expect(SUPPORT_NOTE).toBe(
      'If your coding agent declines this, use the one-line command above. Same result.'
    )
    expect(buildInstallKit(SAMPLE).supportNote).toBe(SUPPORT_NOTE)
  })
})

// ── Reading level and plain wording ───────────────────────────────────────────

describe('kit copy — plain reading level and one support line', () => {
  it('explains every jargon term in parentheses the first time', () => {
    const text = kitText()
    expect(text).toMatch(/terminal \(/) // Path A
    expect(text).toMatch(/coding agent \(/) // Path B intro
  })

  it('has exactly one support line, no disclaimer paragraph', () => {
    // The single support note is one sentence, no multi-line legalese.
    expect(SUPPORT_NOTE).not.toContain('\n')
    const text = kitText()
    const supportHits = text.split(SUPPORT_NOTE).length - 1
    expect(supportHits).toBe(1)
  })

  it('keeps human-facing sentences short (a reading-level proxy)', () => {
    const kit = buildInstallKit(SAMPLE)
    const humanCopy = [
      ...kit.whyNote.lines,
      ...kit.keyReady.lines,
      ...ADMIN_SEND_CHECKLIST.lines,
      kit.pathA.intro,
      kit.pathA.after,
      kit.windowsNote,
      kit.pathB.intro,
      kit.supportNote,
    ].join(' ')
    const sentences = humanCopy
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
    const longest = Math.max(...sentences.map((s) => s.split(/\s+/).length))
    // No human-facing sentence runs past ~28 words.
    expect(longest).toBeLessThanOrEqual(28)
  })

  it('renders the track-mode note without ever claiming it pauses anyone', () => {
    const kit = buildInstallKit({ ...SAMPLE, mode: 'track' })
    const note = kit.whyNote.lines.join('\n').toLowerCase()
    expect(note).toContain('watches')
    expect(note).toContain('never pauses')
  })

  it('the enforce-mode note names both tools it can pause', () => {
    const kit = buildInstallKit(SAMPLE)
    expect(kit.whyNote.lines.join('\n')).toContain(
      'new Claude Code and Codex tool calls pause'
    )
  })
})

// ── The copy-whole-kit block (what a developer actually receives) ─────────────

describe('formatKitPlainText — the copyable kit devs receive', () => {
  it('includes both paths, the arming line, the support note, and the doc links', () => {
    const text = formatKitPlainText(buildInstallKit(SAMPLE))
    const iA = text.indexOf('For a teammate: one line')
    const iB = text.indexOf('For a coding agent: copy and paste')
    const iArm = text.indexOf(ARMING_LINE)
    expect(text).toContain(PATH_A_ONELINER)
    expect(iA).toBeGreaterThan(-1)
    expect(iB).toBeGreaterThan(iA) // Path A above Path B (guard rule)
    expect(iArm).toBeGreaterThan(-1)
    expect(text).toContain(SUPPORT_NOTE)
    expect(text).toContain(
      `Source: ${sourceRepoLabel()} (packages/code-cost-clarity)`
    )
    expect(text).not.toContain('Docs:')
    // No coming-soon IT/MDM path in what teammates receive.
    expect(text).not.toMatch(/MDM/)
    expect(text).not.toMatch(/IT team/i)
  })

  it('still carries no "block", "bypass", or "deny"', () => {
    const text = formatKitPlainText(buildInstallKit(SAMPLE)).toLowerCase()
    expect(text).not.toContain('bypass')
    expect(text).not.toContain('deny')
    expect(text).not.toContain('block')
  })
})

// ── The capless kit: zero caps is an install path, not a dead end ─

describe('buildCaplessInstallKit — the install-only kit for a capless org', () => {
  const capless = buildCaplessInstallKit({
    orgName: 'Acme',
    setterName: 'Jordan Lee',
  })

  const caplessText = () =>
    [
      capless.title,
      capless.whyNote.heading,
      ...capless.whyNote.lines,
      ...capless.keyReady.lines,
      capless.pathA.intro,
      capless.pathA.command,
      capless.pathA.after,
      capless.windowsNote,
      capless.pathB.intro,
      capless.pathB.prompt,
      capless.supportNote,
      capless.capsLaterNote ?? '',
    ].join('\n')

  it('keeps the same build-from-source one-liner and verify command', () => {
    expect(capless.pathA.command).toBe(PATH_A_ONELINER)
    expect(capless.pathB.prompt).toContain(PATH_A_ONELINER)
    expect(capless.pathB.prompt).toContain(PATH_B_VERIFY_COMMAND)
    expect(caplessText()).not.toMatch(
      /npx @marginfront|npm install @marginfront/
    )
  })

  it('names who asked and says honestly that no cap is set', () => {
    const note = capless.whyNote.lines.join('\n')
    expect(capless.whyNote.heading).toBe('Who asked for this')
    expect(note).toContain('Jordan Lee')
    expect(note).toContain('Acme')
    expect(note).toContain('No cap is set yet.')
  })

  it('drops the cap-specific parts: no arming line, no cap sentence, Path A stays simple', () => {
    expect(capless.armingLine).toBeNull()
    const text = caplessText()
    expect(text).not.toContain(ARMING_LINE)
    expect(text).not.toContain("It's set to")
    // /hooks appears in exactly two legitimate places (the Codex clause of
    // CAPS_LATER_NOTE and the prompt's wiring step) — never in Path A.
    expect(capless.pathA.after).not.toContain('/hooks')
    expect(capless.pathA.intro).not.toContain('/hooks')
  })

  it('carries the one caps-can-wait sentence, verbatim, with the honest Codex clause', () => {
    expect(capless.capsLaterNote).toBe(CAPS_LATER_NOTE)
    // The Codex clause is load-bearing: a Codex hook stays inert until the
    // developer trusts it in /hooks, so a bare "picks it up on its own"
    // would promise Codex coverage the device can't deliver.
    expect(CAPS_LATER_NOTE).toBe(
      'No cap is set yet. Once spend is flowing, set one on the Caps tab. No reinstall needed: Claude Code picks a new cap up on its own, and Codex teammates finish by trusting the cap check in /hooks once.'
    )
  })

  it('keeps the wiring-check step, so a later cap is not unverified', () => {
    const prompt = capless.pathB.prompt
    expect(prompt).toContain('Check the wiring')
    expect(prompt).toContain('check-cap.py')
    expect(prompt).toContain(
      '~/.codex/hooks.json has the MarginFront cap entry'
    )
    expect(prompt).toContain('run /hooks once inside codex')
    expect(prompt).toContain('so a later cap covers Codex too')
    expect(prompt).toContain("If codex doesn't know that command")
  })

  it('keeps the Path B safety spine: approval first, source check, the human runs the line', () => {
    const prompt = capless.pathB.prompt
    expect(prompt).not.toMatch(/{{|}}/)
    expect(prompt).toContain('First, have me confirm this is really approved')
    expect(prompt).toContain("Look at the meter's source before we install it")
    expect(prompt).toContain(
      'I run it myself because it asks me to paste my secret key.'
    )
    expect(prompt.indexOf('really approved')).toBeLessThan(
      prompt.indexOf(PATH_A_ONELINER)
    )
    expect(prompt.indexOf("Look at the meter's source")).toBeLessThan(
      prompt.indexOf(PATH_A_ONELINER)
    )
  })

  it('tells the truth about --control with no cap: wires the check, changes nothing today', () => {
    const prompt = capless.pathB.prompt
    expect(prompt).toContain('THE CAP: none yet.')
    expect(prompt).toContain(
      'With no cap set, the check does nothing and my work keeps going.'
    )
    expect(prompt).toContain(
      'With no cap set it changes nothing today; it means a cap my admin sets later starts working without a reinstall.'
    )
  })

  it('stays guard-safe: no block/bypass/deny anywhere in the capless kit', () => {
    const text = caplessText().toLowerCase()
    expect(text).not.toContain('bypass')
    expect(text).not.toContain('deny')
    expect(text).not.toContain('block')
  })

  it('formats to a plain-text kit with both paths, the caps-later line, and the links', () => {
    const text = formatKitPlainText(capless)
    expect(text).toContain('For a teammate: one line')
    expect(text).toContain('For a coding agent: copy and paste')
    expect(text).toContain(WINDOWS_WSL_NOTE)
    expect(text).toContain(CAPS_LATER_NOTE)
    expect(text).not.toContain(ARMING_LINE)
    expect(text).toContain(
      `Source: ${sourceRepoLabel()} (packages/code-cost-clarity)`
    )
  })
})

// ── The Windows/WSL line: one line, both kits, both surfaces ──────

describe('the Windows/WSL note', () => {
  it('says native PowerShell works, and adds no docs link when no docs site is set', () => {
    expect(WINDOWS_WSL_SENTENCE).toBe(
      "Windows teammates: the same command works in PowerShell 7 or newer. No WSL needed. One Windows gap: the Claude desktop app isn't counted yet, only Claude Code in the terminal. Codex is counted either way."
    )
    expect(WINDOWS_WSL_NOTE).toBe(WINDOWS_WSL_SENTENCE)
    expect(WINDOWS_WSL_NOTE).not.toContain('\n')
  })

  it('rides the copied kit body for BOTH kits, right after Path A', () => {
    for (const kit of [
      buildInstallKit(SAMPLE),
      buildCaplessInstallKit({ orgName: 'Acme', setterName: 'Jordan Lee' }),
    ]) {
      const text = formatKitPlainText(kit)
      const iCommand = text.indexOf(`  ${kit.pathA.command}`)
      const iWindows = text.indexOf(WINDOWS_WSL_NOTE)
      const iPathB = text.indexOf('For a coding agent: copy and paste')
      expect(iCommand).toBeGreaterThan(-1)
      expect(iWindows).toBeGreaterThan(iCommand)
      expect(iWindows).toBeLessThan(iPathB)
    }
  })
})

// The exact Path B text for SAMPLE. If the template drifts, this pin breaks
// and must be updated on purpose.
const EXPECTED_PATH_B = `Please guide me through setting up my team's MarginFront cost meter and its spend cap on this computer. Here's the full context so you can check it's safe before we start.

WHO ASKED: Jordan Lee at Acme set this up and asked me to install it.
THE CAP: Stop AI spend at $5,000 across the whole team per month. It's set to Enforce.
WHY: We went over budget last month.

WHAT THIS SETS UP, in plain words:
1. The MarginFront meter. It records this computer's Claude Code and Codex spend so my team can see it. To do this it downloads one standard helper program (about 360MB) that counts AI usage. This is internal cost tracking only. It doesn't change any customer's bill.
2. A small check that runs before each tool call. The check reads one small file on this computer that holds my team's recent AI spend. The cap can cover the whole team or only me. If that spend reaches an Enforce cap that covers all AI tools, the check pauses new Claude Code and Codex tool calls until my admin raises or resets the cap. If that file is missing or old, the check does nothing and my work keeps going. The check makes no network calls, and it's one small file you can open and read.

PLEASE GUIDE ME THROUGH THESE STEPS:
1. First, have me confirm this is really approved. A name in a message isn't proof on its own, and an Enforce cap can pause work for my whole team, not only mine. Ask me to check with Jordan Lee or my IT admin, through a channel I already trust. Wait for me to say yes before you go on.
2. Look at the meter's source before we install it. It lives in the packages/code-cost-clarity folder of ${sourceRepoLabel()}. Tell me whether it looks like what this message describes. If anything looks off, say so and stop here.
3. Have me run this one line in my terminal and answer its questions:
   ${PATH_A_ONELINER}
   I run it myself because it asks me to paste my secret key. It builds the meter from the source you just looked at, then installs it. When it asks for my MarginFront server address, I enter ${publicApiBaseUrl()}. The --control part is what adds the spend cap. Without it, the command sets up the meter and nothing else. The cap it turns on is the one named above: Stop AI spend at $5,000 across the whole team per month.
4. Once I tell you it finished, run:
   ${PATH_B_VERIFY_COMMAND}
   and check the meter is running.
5. Check the wiring: ~/.claude/settings.json has a PreToolUse hook that runs check-cap.py, the file ~/.marginfront-ccc/control/check-cap.py exists, and ~/.codex/hooks.json has the MarginFront cap entry. You may open and read check-cap.py to confirm it does only what I described above. Then remind me to run /hooks once inside codex to finish arming. If codex doesn't know that command, tell me to check Codex's own docs for how to review and reload hooks.
6. Tell me in a few words what's armed and whether anything looked wrong. Warn me that from here on, a tool call can pause part-way through a session with no other warning, if my team reaches the cap. If that happens, the cap did its job, and I should ask my admin to raise it. Then remind me to quit and reopen Claude and Codex so counting starts.

Claude Code arms on my next session, or a /hooks reload. Codex needs one more step: I run /hooks inside codex once and trust the MarginFront cap check. Once armed, cap updates apply to running sessions too.`

// ── The on-screen footnote: arming line + support note, one line ─────────────

/**
 * The arming line already ends in a period, so the footnote joins the two
 * sentences with one space and never renders "too.. If".
 */
describe('formatArmingAndSupport — one period between the two sentences', () => {
  it('renders exactly one period where the two sentences meet', () => {
    const line = formatArmingAndSupport(buildInstallKit(SAMPLE))
    expect(line).toContain('sessions too. If')
    expect(line).not.toContain('..')
  })

  it('carries both sentences whole', () => {
    const line = formatArmingAndSupport(buildInstallKit(SAMPLE))
    expect(line).toBe(`${ARMING_LINE} ${SUPPORT_NOTE}`)
  })

  it('a capless kit has no arming line, so the support note stands alone', () => {
    const line = formatArmingAndSupport(
      buildCaplessInstallKit({ orgName: 'Acme', setterName: 'Jordan Lee' })
    )
    expect(line).toBe(SUPPORT_NOTE)
    expect(line).not.toMatch(/^\s/)
  })
})

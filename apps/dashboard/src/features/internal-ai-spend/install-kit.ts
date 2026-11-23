/**
 * The install-kit generator. Pure copy + string work, NO React and NO
 * `@marginfront/db`
 * import — a `'use client'` dialog imports this, and the same client-bundle
 * rule spend-controls-utils.ts is pinned against applies here. Everything the
 * kit says lives in one tested function so the plain phrasing, the
 * verbatim lines, and the paste-able coding-agent prompt can't drift without a
 * red test.
 *
 * The kit is the delegation artifact: an admin on the Internal AI Spend page
 * picks a cap, types a why-note, and hands their teammates a kit anyone
 * could follow. Section order: the admin's note, the key-ready check,
 * the teammate one-liner (Path A), then the coding-agent GUIDE paste (Path B),
 * plus links to the docs and the source for anyone who wants more. An
 * org with zero caps gets the capless twin: same paths, same
 * pinned one-liner, cap talk replaced by CAPS_LATER_NOTE.
 *
 * Path B is a GUIDE, not a driver: the agent walks the human through the same
 * install the one-liner does, and the HUMAN runs the command (it asks for
 * their secret key, which never belongs in an agent transcript). That is why
 * no kit copy carries --no-prompt — a test pins that.
 *
 * Phrasing is deliberately guard-safe so coding agents accept it: plain
 * words only ("pause", "stop at the cap") — never "block"/"bypass"/"deny" —
 * Path A always sits next to Path B, and Path B gives the agent a legible,
 * verifiable policy (who set the cap, the amount, the why, and exactly what the
 * on-device check does) instead of an opaque "install this hook".
 */

import type { CapMode } from '@/features/money/spend-controls-types'
import { CCC_COMMAND_INVOCATION } from '@/lib/meter-command'
import { docsLink, publicApiBaseUrl } from '@/config/operator'
import {
  CCC_SOURCE_CONTROL_INIT_COMMAND,
  CCC_SOURCE_INIT_COMMAND,
  CCC_WORKSPACE,
  cccServerAddressLine,
  cloneAndBuildCommand,
  sourceRepoLabel,
} from '@/config/source-install'
import { MODE_COPY } from './spend-controls-utils'

// ── Verbatim, snapshot-pinned lines ──────────────────────────────────────────

/** The teammate one-liner. Path A of the kit and the command Path B guides the
 * human through. It builds the meter from the MarginFront source, then
 * `init --control` does the real install; the kit never hand-rolls a hook. */
export const PATH_A_ONELINER = `${cloneAndBuildCommand(CCC_WORKSPACE)} && ${CCC_SOURCE_CONTROL_INIT_COMMAND}`

/** The meter-only install line, no spend cap. The Getting Started walkthrough
 * reads it from here so the two surfaces can never describe two different
 * installs of the same meter. */
export const CCC_INIT_COMMAND = `${cloneAndBuildCommand(CCC_WORKSPACE)} && ${CCC_SOURCE_INIT_COMMAND}`

/** The verify command the code-cost-clarity CLI ships. There is NO
 * `control status` subcommand (see packages/code-cost-clarity/src/cli.ts), so Path B verifies
 * with the `status` output that DOES exist plus an on-disk check of the hooks
 * and script `init --control` writes. It runs the copy `init` installed. */
export const PATH_B_VERIFY_COMMAND = `${CCC_COMMAND_INVOCATION} status`

/** The arming sentence, split per tool because the two tools arm differently:
 * Claude Code arms by itself on the next session, Codex stays inert until the
 * developer trusts the hook in `/hooks`. One combined sentence would read as
 * "both tools arm on their own", which is false for Codex. */
export const ARMING_LINE =
  'Claude Code arms on your next session, or a /hooks reload. Codex needs one more step: run /hooks inside codex once and trust the MarginFront cap check. Once armed, cap updates apply to running sessions too.'

/** The single support line. One sentence, never a disclaimer paragraph. */
export const SUPPORT_NOTE =
  'If your coding agent declines this, use the one-line command above. Same result.'

/** null when the operator has no docs site (NEXT_PUBLIC_DOCS_URL unset). */
export const CCC_WINDOWS_DOCS_URL = docsLink('/tools/code-cost-clarity-windows')

export const CCC_DOCS_URL = docsLink('/tools/code-cost-clarity')

/** Split from the full note so the dialog can render the sentence with a real
 * link while the copied kit carries the raw URL. */
export const WINDOWS_WSL_SENTENCE =
  "Windows teammates: the same command works in PowerShell 7 or newer. No WSL needed. One Windows gap: the Claude desktop app isn't counted yet, only Claude Code in the terminal. Codex is counted either way."

export const WINDOWS_WSL_NOTE = CCC_WINDOWS_DOCS_URL
  ? `${WINDOWS_WSL_SENTENCE} Setup guide: ${CCC_WINDOWS_DOCS_URL}`
  : WINDOWS_WSL_SENTENCE

/** The capless kit's one caps-can-wait sentence. The Codex clause
 * is load-bearing honesty: a Codex hook stays inert until the developer trusts
 * it in /hooks (see ARMING_LINE), so "picks it up on its own" is only true for
 * Claude Code. */
export const CAPS_LATER_NOTE =
  'No cap is set yet. Once spend is flowing, set one on the Caps tab. No reinstall needed: Claude Code picks a new cap up on its own, and Codex teammates finish by trusting the cap check in /hooks once.'

// ── The admin block (on-screen only, never in the copied kit) ────────────────

/** What the ADMIN sees above the cap picker before sending the kit: coverage
 * in one sentence, then the two honest routes to get a teammate a key. This
 * renders in the dialog only — the teammate's copied kit never includes it. */
export const ADMIN_SEND_CHECKLIST = {
  heading: 'Before you send this kit',
  lines: [
    'One kit covers Claude Code and Codex, the terminal versions and the desktop apps.',
    'Each teammate needs their own MarginFront key. Two ways to get them one:',
    "Invite them: Settings, then Team, then Invite member. Give them the Developer role. A plain Member can't create keys.",
    'Or create a key for them and hand it over in your password manager, never Slack or email.',
  ],
} as const

// ── The Path B prompt template (the single testable artifact) ────────────────

/**
 * The paste-able coding-agent prompt, with `{{TOKEN}}` placeholders filled from
 * the same inputs the kit uses. Written TO a coding agent, in the teammate's
 * voice: it leads with provenance and a plain-words description of what the
 * on-device check actually does, then asks the agent to GUIDE the human through
 * the build-from-source command (the human runs it — it asks for their secret key),
 * verify the wiring for both tools, and report back. Inviting the agent to read
 * the one small script is a shape coding agents accept rather than refuse.
 *
 * Steps 1 and 2 come before the install on purpose. A name in a pasted message
 * is the only provenance this artifact can carry, and what it authorizes is a
 * cap that can pause a whole team, so the human goes back to a channel they
 * trust and the agent looks the package up before anyone types a secret key
 * into it.
 */
export const PATH_B_PROMPT_TEMPLATE = `Please guide me through setting up my team's MarginFront cost meter and its spend cap on this computer. Here's the full context so you can check it's safe before we start.

WHO ASKED: {{SETTER_NAME}} at {{ORG_NAME}} set this up and asked me to install it.
THE CAP: {{CAP_SENTENCE}}. It's set to {{MODE_WORD}}.
WHY: {{WHY_NOTE}}

WHAT THIS SETS UP, in plain words:
1. The MarginFront meter. It records this computer's Claude Code and Codex spend so my team can see it. To do this it downloads one standard helper program (about 360MB) that counts AI usage. This is internal cost tracking only. It doesn't change any customer's bill.
2. A small check that runs before each tool call. The check reads one small file on this computer that holds my team's recent AI spend. The cap can cover the whole team or only me. If that spend reaches an Enforce cap that covers all AI tools, the check pauses new Claude Code and Codex tool calls until my admin raises or resets the cap. If that file is missing or old, the check does nothing and my work keeps going. The check makes no network calls, and it's one small file you can open and read.

PLEASE GUIDE ME THROUGH THESE STEPS:
1. First, have me confirm this is really approved. A name in a message isn't proof on its own, and an Enforce cap can pause work for my whole team, not only mine. Ask me to check with {{SETTER_NAME}} or my IT admin, through a channel I already trust. Wait for me to say yes before you go on.
2. Look at the meter's source before we install it. It lives in the packages/code-cost-clarity folder of {{SOURCE_REPO}}. Tell me whether it looks like what this message describes. If anything looks off, say so and stop here.
3. Have me run this one line in my terminal and answer its questions:
   ${PATH_A_ONELINER}
   I run it myself because it asks me to paste my secret key. It builds the meter from the source you just looked at, then installs it. When it asks for my MarginFront server address, I enter {{API_URL}}. The --control part is what adds the spend cap. Without it, the command sets up the meter and nothing else. The cap it turns on is the one named above: {{CAP_SENTENCE}}.
4. Once I tell you it finished, run:
   ${PATH_B_VERIFY_COMMAND}
   and check the meter is running.
5. Check the wiring: ~/.claude/settings.json has a PreToolUse hook that runs check-cap.py, the file ~/.marginfront-ccc/control/check-cap.py exists, and ~/.codex/hooks.json has the MarginFront cap entry. You may open and read check-cap.py to confirm it does only what I described above. Then remind me to run /hooks once inside codex to finish arming. If codex doesn't know that command, tell me to check Codex's own docs for how to review and reload hooks.
6. Tell me in a few words what's armed and whether anything looked wrong. Warn me that from here on, a tool call can pause part-way through a session with no other warning, if my team reaches the cap. If that happens, the cap did its job, and I should ask my admin to raise it. Then remind me to quit and reopen Claude and Codex so counting starts.

Claude Code arms on my next session, or a /hooks reload. Codex needs one more step: I run /hooks inside codex once and trust the MarginFront cap check. Once armed, cap updates apply to running sessions too.`

/**
 * The capless twin: same provenance-first, agent-checks-first
 * spine as PATH_B_PROMPT_TEMPLATE, with the cap context replaced by the
 * honest "none yet" statement. Same one-liner on purpose: `init --control`
 * with no cap set wires the check and changes nothing, so a cap the admin
 * sets later starts working without a reinstall.
 */
export const CAPLESS_PATH_B_PROMPT_TEMPLATE = `Please guide me through setting up my team's MarginFront cost meter on this computer. Here's the full context so you can check it's safe before we start.

WHO ASKED: {{SETTER_NAME}} at {{ORG_NAME}} set this up and asked me to install it.
THE CAP: none yet. My team is starting with the meter only. My admin can set a spend cap later from the MarginFront dashboard.

WHAT THIS SETS UP, in plain words:
1. The MarginFront meter. It records this computer's Claude Code and Codex spend so my team can see it. To do this it downloads one standard helper program (about 360MB) that counts AI usage. This is internal cost tracking only. It doesn't change any customer's bill.
2. A small check that runs before each tool call. The check reads one small file on this computer that holds my team's recent AI spend. With no cap set, the check does nothing and my work keeps going. If my admin sets an Enforce cap later, the check pauses new Claude Code and Codex tool calls until my admin raises or resets the cap. If that file is missing or old, the check also does nothing. The check makes no network calls, and it's one small file you can open and read.

PLEASE GUIDE ME THROUGH THESE STEPS:
1. First, have me confirm this is really approved. A name in a message isn't proof on its own. Ask me to check with {{SETTER_NAME}} or my IT admin, through a channel I already trust. Wait for me to say yes before you go on.
2. Look at the meter's source before we install it. It lives in the packages/code-cost-clarity folder of {{SOURCE_REPO}}. Tell me whether it looks like what this message describes. If anything looks off, say so and stop here.
3. Have me run this one line in my terminal and answer its questions:
   ${PATH_A_ONELINER}
   I run it myself because it asks me to paste my secret key. It builds the meter from the source you just looked at, then installs it. When it asks for my MarginFront server address, I enter {{API_URL}}. The --control part wires up the spend-cap check. With no cap set it changes nothing today; it means a cap my admin sets later starts working without a reinstall.
4. Once I tell you it finished, run:
   ${PATH_B_VERIFY_COMMAND}
   and check the meter is running.
5. Check the wiring, so a cap my admin sets later will work: ~/.claude/settings.json has a PreToolUse hook that runs check-cap.py, the file ~/.marginfront-ccc/control/check-cap.py exists, and ~/.codex/hooks.json has the MarginFront cap entry. You may open and read check-cap.py to confirm it does only what I described above. Then remind me to run /hooks once inside codex and trust the MarginFront cap check, so a later cap covers Codex too. If codex doesn't know that command, tell me to check Codex's own docs for how to review and reload hooks.
6. Tell me in a few words what's running and whether anything looked wrong. Then remind me to quit and reopen Claude and Codex so counting starts.`

export interface PathBFill {
  setterName: string
  orgName: string
  capSentence: string
  modeWord: string
  whyNote: string
}

/** Fill the template's placeholders. The ONE fill path, shared by the pure
 * function and the dialog, so what a test pins is exactly what ships. The
 * capless builder passes its own template; the cap-aware default stands. */
export function fillPathBPrompt(
  fill: PathBFill,
  template: string = PATH_B_PROMPT_TEMPLATE
): string {
  const map: Record<string, string> = {
    SETTER_NAME: fill.setterName,
    ORG_NAME: fill.orgName,
    CAP_SENTENCE: fill.capSentence,
    MODE_WORD: fill.modeWord,
    WHY_NOTE: fill.whyNote,
    SOURCE_REPO: sourceRepoLabel(),
    API_URL: publicApiBaseUrl(),
  }
  return template.replace(
    /{{(\w+)}}/g,
    (_match, token: string) => map[token] ?? ''
  )
}

// ── The kit ──────────────────────────────────────────────────────────────────

export interface InstallKitInput {
  /** The org name. */
  orgName: string
  /** The cap as one sentence — built by buildCapSentence upstream, never
   * re-derived here. */
  capSentence: string
  mode: CapMode
  /** Free text the admin types when generating; not persisted (rides the kit). */
  whyNote: string
  /** Who is sending the kit — surfaced as "who set the cap". */
  setterName: string
}

export interface InstallKit {
  title: string
  whyNote: { heading: string; lines: string[] }
  keyReady: { heading: string; lines: string[] }
  pathA: { heading: string; intro: string; command: string; after: string }
  pathB: { heading: string; intro: string; prompt: string }
  windowsNote: string
  /** null in the capless kit: there is no cap to arm. */
  armingLine: string | null
  supportNote: string
  /** null in the cap-aware kit; the capless kit's one caps-can-wait sentence. */
  capsLaterNote: string | null
}

const PATH_A_INTRO =
  'You need git and Node.js 20 or newer. Open your terminal (the window where you type commands) and run this one line. It downloads the MarginFront source and builds the meter on your computer:'

function pathAAfterLead(): string {
  return `It asks a few quick questions. ${cccServerAddressLine()}. Paste your key when it asks.`
}

/** One honest sentence about what THIS cap's mode means for a teammate. Track
 * never claims it pauses anything; enforce says plainly that an all-AI cap can
 * pause Claude Code and Codex work (the only kind the device pauses). */
function modeNote(mode: CapMode): string {
  if (mode === 'track') {
    return 'It only watches and warns you. It never pauses your work.'
  }
  return 'It can pause work. When the cap is reached, new Claude Code and Codex tool calls pause until your admin raises it.'
}

export function buildInstallKit(input: InstallKitInput): InstallKit {
  const { orgName, capSentence, mode, whyNote, setterName } = input
  const modeWord = MODE_COPY[mode].label
  const why = whyNote.trim() ? whyNote.trim() : 'No note was added.'

  return {
    title: "Your team's cost cap install kit",
    whyNote: {
      heading: 'The note from your admin',
      lines: [
        `${setterName} at ${orgName} set this cap and sent you this kit.`,
        `The cap: ${capSentence}. It's set to ${modeWord}. ${modeNote(mode)}`,
        `Why: ${why}`,
      ],
    },
    keyReady: {
      heading: 'First: have your MarginFront key ready',
      lines: [
        'Your key starts with mf_sk_. The installer asks for it.',
        'Invited to MarginFront? Create yours at Build > API keys > "Create key pair".',
        'Or your admin may have sent you one in your password manager.',
        'No key? Ask your admin before you start.',
      ],
    },
    pathA: {
      heading: 'For a teammate: one line',
      intro: PATH_A_INTRO,
      command: PATH_A_ONELINER,
      after: `${pathAAfterLead()} When it finishes, quit and reopen Claude and Codex so counting starts. Using Codex? Finish by running /hooks once inside it and trusting the MarginFront cap check.`,
    },
    pathB: {
      heading: 'For a coding agent: copy and paste',
      intro:
        'Use a coding agent (an AI helper like Claude Code or Codex that can run commands for you)? Paste the text below to it. It guides you through the same install and checks that it worked.',
      prompt: fillPathBPrompt({
        setterName,
        orgName,
        capSentence,
        modeWord,
        whyNote: why,
      }),
    },
    windowsNote: WINDOWS_WSL_NOTE,
    armingLine: ARMING_LINE,
    supportNote: SUPPORT_NOTE,
    capsLaterNote: null,
  }
}

export interface CaplessInstallKitInput {
  orgName: string
  setterName: string
}

/**
 * The install-only kit for an org with zero caps. Same shape and
 * same one-liner as the cap-aware kit, so a teammate who installs today is
 * already wired when the admin sets a cap. Cap-specific parts (the cap
 * sentence, the admin's why-note, the arming line) are absent, replaced by
 * CAPS_LATER_NOTE.
 */
export function buildCaplessInstallKit(
  input: CaplessInstallKitInput
): InstallKit {
  const { orgName, setterName } = input

  return {
    title: "Your team's cost meter install kit",
    whyNote: {
      heading: 'Who asked for this',
      lines: [
        `${setterName} at ${orgName} asked you to install the team's cost meter.`,
        'No cap is set yet. The meter counts spend so your team can see it.',
      ],
    },
    keyReady: {
      heading: 'First: have your MarginFront key ready',
      lines: [
        'Your key starts with mf_sk_. The installer asks for it.',
        'Invited to MarginFront? Create yours at Build > API keys > "Create key pair".',
        'Or your admin may have sent you one in your password manager.',
        'No key? Ask your admin before you start.',
      ],
    },
    pathA: {
      heading: 'For a teammate: one line',
      intro: PATH_A_INTRO,
      command: PATH_A_ONELINER,
      after: `${pathAAfterLead()} When it finishes, quit and reopen Claude and Codex so counting starts.`,
    },
    pathB: {
      heading: 'For a coding agent: copy and paste',
      intro:
        'Use a coding agent (an AI helper like Claude Code or Codex that can run commands for you)? Paste the text below to it. It guides you through the same install and checks that it worked.',
      prompt: fillPathBPrompt(
        {
          setterName,
          orgName,
          capSentence: '',
          modeWord: '',
          whyNote: '',
        },
        CAPLESS_PATH_B_PROMPT_TEMPLATE
      ),
    },
    windowsNote: WINDOWS_WSL_NOTE,
    armingLine: null,
    supportNote: SUPPORT_NOTE,
    capsLaterNote: CAPS_LATER_NOTE,
  }
}

/** The panel's one-line footnote. Both sentences already end in a period, so
 * the join adds a space and nothing else, so the render site must not add a
 * separator. */
export function formatArmingAndSupport(kit: InstallKit): string {
  return kit.armingLine === null
    ? kit.supportNote
    : `${kit.armingLine} ${kit.supportNote}`
}

/** The whole kit as one plain-text block — what the admin copies to hand a
 * teammate. Section
 * order matches the on-screen kit so a copied kit reads the same as the panel.
 * The admin checklist is NOT here on purpose: it's guidance for the sender. */
export function formatKitPlainText(kit: InstallKit): string {
  return [
    kit.title,
    '',
    kit.whyNote.heading,
    ...kit.whyNote.lines,
    '',
    kit.keyReady.heading,
    ...kit.keyReady.lines,
    '',
    kit.pathA.heading,
    kit.pathA.intro,
    `  ${kit.pathA.command}`,
    kit.pathA.after,
    kit.windowsNote,
    '',
    kit.pathB.heading,
    kit.pathB.intro,
    '',
    kit.pathB.prompt,
    '',
    ...(kit.armingLine !== null ? [kit.armingLine, ''] : []),
    kit.supportNote,
    '',
    ...(kit.capsLaterNote !== null ? [kit.capsLaterNote, ''] : []),
    'More:',
    ...(CCC_DOCS_URL ? [`  Docs: ${CCC_DOCS_URL}`] : []),
    `  Source: ${sourceRepoLabel()} (packages/code-cost-clarity)`,
  ].join('\n')
}

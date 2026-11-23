/**
 * The prompt is handed to an AI assistant on someone else's machine, so the
 * parts that make it work cannot silently fall out: the reinstall command,
 * both platforms' settings paths, the remote command, and all eight checks.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { CCC_INIT_COMMAND } from '../install-kit'
import { REPO_HELP_PROMPT } from '../repo-help'
import {
  DIMENSION_CHOICES,
  NO_KEY_ROW_NOTES,
} from '@/features/money/repo-spend'

describe('REPO_HELP_PROMPT', () => {
  it('reinstalls with the same build-from-source command the install kit uses', () => {
    expect(REPO_HELP_PROMPT).toContain(CCC_INIT_COMMAND)
    expect(REPO_HELP_PROMPT).not.toMatch(/npx @marginfront/)
  })

  it('names the settings file on Mac, Linux and Windows', () => {
    expect(REPO_HELP_PROMPT).toContain('~/.marginfront-ccc/')
    expect(REPO_HELP_PROMPT).toContain('%USERPROFILE%\\.marginfront-ccc\\')
  })

  it('gives the remote command the answer usually hangs on', () => {
    expect(REPO_HELP_PROMPT).toContain('git remote get-url origin')
  })

  it('walks all eight checks, each starting its own line', () => {
    for (let check = 1; check <= 8; check += 1) {
      expect(REPO_HELP_PROMPT).toMatch(new RegExp(`^${check}\\. `, 'm'))
    }
  })

  // Every claim below is something the assistant reads out loud on someone
  // else's machine. A reword that drops one turns a check into a dead end.
  it.each([
    ['CCC_IGNORE_REPOS'],
    ['"Ignoring:"'],
    ['cli.js version'],
    ['git rev-parse --show-toplevel'],
    ['git remote get-url origin'],
    ['/usr/bin/git --version'],
    ['xcode-select --install'],
    ['PowerShell'],
    ['0.8.2'],
    ['0.16.0'],
    ['home folder'],
    ['detached HEAD'],
    ['This month'],
  ])('keeps the load-bearing claim %s', (claim) => {
    expect(REPO_HELP_PROMPT).toContain(claim)
  })
})

/**
 * Same shape as the version pin in install-kit.test.ts: a rename inside the
 * meter package has to break a test here rather than quietly send a
 * customer's assistant to a path or a key that no longer exists.
 */
describe('REPO_HELP_PROMPT — drift against the shipped meter', () => {
  const METER_SRC = join(
    __dirname,
    '../../../../../..',
    'packages/code-cost-clarity/src'
  )

  it('names the ignore-list env key the forwarder actually reads', () => {
    const forwarder = readFileSync(join(METER_SRC, 'forwarder.ts'), 'utf8')
    const declared = /IGNORE_REPOS_ENV_KEY = "([^"]+)"/.exec(forwarder)
    expect(declared).not.toBeNull()
    expect(REPO_HELP_PROMPT).toContain(declared![1])
  })

  it('points the version check at the installed copy the daemon runs', () => {
    const connector = readFileSync(join(METER_SRC, 'connector.ts'), 'utf8')
    expect(connector).toContain('DAEMON_CLI_PATH = join(CONFIG_DIR, "cli.js")')
    expect(REPO_HELP_PROMPT).toContain('.marginfront-ccc/cli.js')
  })
})

describe('NO_KEY_ROW_NOTES', () => {
  it('has a note for every dimension the section can show', () => {
    for (const choice of DIMENSION_CHOICES) {
      expect(typeof NO_KEY_ROW_NOTES[choice.id]).toBe('string')
      expect(NO_KEY_ROW_NOTES[choice.id].length).toBeGreaterThan(0)
    }
    expect(Object.keys(NO_KEY_ROW_NOTES).sort()).toEqual(
      DIMENSION_CHOICES.map((choice) => choice.id).sort()
    )
  })
})

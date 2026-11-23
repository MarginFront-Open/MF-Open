import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import {
  copyrightLine,
  docsLink,
  getOperatorSettings,
  publicApiBaseUrl,
} from '../operator'
import {
  cloneAndBuildCommand,
  pullAndBuildCommand,
  sourceRepoLabel,
  sourceRepoUrl,
} from '../source-install'

const OPERATOR_VARS = [
  'NEXT_PUBLIC_COMPANY_NAME',
  'NEXT_PUBLIC_SUPPORT_EMAIL',
  'NEXT_PUBLIC_DOCS_URL',
  'NEXT_PUBLIC_TERMS_URL',
  'NEXT_PUBLIC_PRIVACY_URL',
  'NEXT_PUBLIC_API_BASE_URL',
  'NEXT_PUBLIC_SOURCE_REPO_URL',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const name of OPERATOR_VARS) {
    saved[name] = process.env[name]
    delete process.env[name]
  }
})

afterEach(() => {
  for (const name of OPERATOR_VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe('operator settings with nothing configured', () => {
  it('returns null for every link and name, so the UI hides them', () => {
    expect(getOperatorSettings()).toEqual({
      name: null,
      supportEmail: null,
      docsUrl: null,
      termsUrl: null,
      privacyUrl: null,
    })
    expect(docsLink('/sdk/tracking-events')).toBeNull()
    expect(copyrightLine(2026)).toBeNull()
  })

  it('treats blank values as unset', () => {
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL = '   '
    process.env.NEXT_PUBLIC_DOCS_URL = ''
    expect(getOperatorSettings().supportEmail).toBeNull()
    expect(docsLink()).toBeNull()
  })

  it('falls back to the local API address for snippets', () => {
    expect(publicApiBaseUrl()).toBe('http://localhost:4000/v1')
  })
})

describe('operator settings when configured', () => {
  it('joins docs paths onto the docs site without doubling slashes', () => {
    process.env.NEXT_PUBLIC_DOCS_URL = 'https://docs.example.com/'
    expect(docsLink()).toBe('https://docs.example.com')
    expect(docsLink('/mcp/setup')).toBe('https://docs.example.com/mcp/setup')
    expect(docsLink('concepts')).toBe('https://docs.example.com/concepts')
  })

  it('builds the copyright line from the operator name', () => {
    process.env.NEXT_PUBLIC_COMPANY_NAME = 'Acme Billing'
    expect(copyrightLine(2026)).toBe('© 2026 Acme Billing')
  })

  it('shows snippets with the configured API address', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://billing.example.com/v1/'
    expect(publicApiBaseUrl()).toBe('https://billing.example.com/v1')
  })
})

describe('build-from-source commands with no source address configured', () => {
  it('has no built-in address: links are hidden and commands show a placeholder nobody can run', () => {
    delete process.env.NEXT_PUBLIC_SOURCE_REPO_URL
    expect(sourceRepoUrl()).toBeNull()
    expect(sourceRepoLabel()).toBe('<your MarginFront source URL>')
    expect(cloneAndBuildCommand('@marginfront/code-cost-clarity')).toBe(
      'git clone <your MarginFront source URL> marginfront && cd marginfront && npm ci && npx turbo run build --filter=@marginfront/code-cost-clarity'
    )
    expect(cloneAndBuildCommand('@marginfront/sdk')).not.toMatch(/https?:\/\//)
  })

  it('treats a blank setting as not set', () => {
    process.env.NEXT_PUBLIC_SOURCE_REPO_URL = '  '
    expect(sourceRepoUrl()).toBeNull()
  })
})

describe('no placeholder repository address anywhere in the source tree', () => {
  const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..')
  const SKIPPED_FOLDERS = new Set([
    'node_modules',
    '.git',
    '.next',
    '.turbo',
    'dist',
    'build',
    'coverage',
  ])
  const CHECKED = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|txt)$/

  function trackedLookingFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED_FOLDERS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...trackedLookingFiles(full))
      else if (
        entry.isFile() &&
        CHECKED.test(entry.name) &&
        entry.name !== 'package-lock.json'
      ) {
        out.push(full)
      }
    }
    return out
  }

  it('no file points at the OWNER placeholder account on GitHub, a name anyone could register', () => {
    const placeholder = ['github.com', 'OWNER'].join('/')
    const offenders = trackedLookingFiles(REPO_ROOT).filter((file) =>
      readFileSync(file, 'utf8').includes(placeholder)
    )
    expect(offenders.map((file) => relative(REPO_ROOT, file))).toEqual([])
  })
})

describe('build-from-source commands', () => {
  it('clone the configured source and build one package with turbo', () => {
    process.env.NEXT_PUBLIC_SOURCE_REPO_URL = 'https://git.example.com/me/mf/'
    expect(sourceRepoUrl()).toBe('https://git.example.com/me/mf')
    expect(cloneAndBuildCommand('@marginfront/sdk')).toBe(
      'git clone https://git.example.com/me/mf marginfront && cd marginfront && npm ci && npx turbo run build --filter=@marginfront/sdk'
    )
    expect(pullAndBuildCommand('@marginfront/mcp')).toBe(
      'cd marginfront && git pull && npm ci && npx turbo run build --filter=@marginfront/mcp'
    )
  })

  it('never reach for a public package registry', () => {
    for (const command of [
      cloneAndBuildCommand('@marginfront/code-cost-clarity'),
      pullAndBuildCommand('@marginfront/sdk'),
    ]) {
      expect(command).not.toMatch(/npx @marginfront|npm install @marginfront/)
      expect(command).not.toContain('marginfront.com')
    }
  })
})

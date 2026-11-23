/**
 * Stored-XSS guard: the ingest fields in record-usage.dto.ts
 * (customerExternalId, agentCode, signalName, model, modelProvider,
 * metadata) are customer-controlled free text the dashboard renders. JSX
 * escaping holds only while dangerouslySetInnerHTML and raw-DOM writes stay
 * out of render-path source, so this fails on any such sink. Full-tree walk
 * rather than a file allowlist (cf. em-dash-sweep.test.ts): a new
 * file adding a sink fails immediately, with no list to maintain.
 *
 * No audited exceptions: every render-path file sweeps clean with zero
 * carve-outs.
 */
import { readFileSync, readdirSync, lstatSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(__dirname, '../../..')

// Not render-path production source: build output, deps, test harnesses,
// seeders, docs, static assets.
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  '__tests__',
  'playwright',
  'scripts',
  'docs',
  'public',
  'assets',
  '.git',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue
    const full = join(dir, entry)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      walk(full, out)
    } else if (
      /\.tsx?$/.test(entry) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      out.push(full)
    }
  }
  return out
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
}

// Forward-slash separators regardless of host OS, so the per-file test names
// stay stable on Windows checkouts too.
const ALL_FILES = walk(ROOT)
  .map((abs) => relative(ROOT, abs).split('\\').join('/'))
  .sort()

const FORBIDDEN_SINKS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'dangerouslySetInnerHTML', pattern: /dangerouslySetInnerHTML/ },
  { name: '.innerHTML assignment', pattern: /\.innerHTML\s*\+?=(?!=)/ },
  { name: '.outerHTML assignment', pattern: /\.outerHTML\s*\+?=(?!=)/ },
  { name: 'insertAdjacentHTML(', pattern: /\.insertAdjacentHTML\s*\(/ },
  { name: 'document.write(', pattern: /document\.write\s*\(/ },
  { name: 'document.writeln(', pattern: /document\.writeln\s*\(/ },
]

describe('render-sink sweep (stored-XSS guard)', () => {
  it("walked more than a stub file list (sanity check the walk isn't silently empty or mis-rooted)", () => {
    expect(ALL_FILES.length).toBeGreaterThan(300)
  })

  it.each(ALL_FILES)('%s has no raw-HTML render sink', (relPath) => {
    const src = stripComments(readFileSync(join(ROOT, relPath), 'utf8'))
    for (const sink of FORBIDDEN_SINKS) {
      expect(src).not.toMatch(sink.pattern)
    }
  })
})

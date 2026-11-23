import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import * as ts from 'typescript'

/**
 * Guard: the client bundle must never value-import a banned server-only
 * package. Two rules across four trees:
 *
 *   - src/**, lib/**, components/** (tests excluded): ANY value import is a
 *     violation. These are the client-shared trees — tsconfig resolves
 *     '@/lib/*' to top-level lib/ BEFORE src/lib/, and 'use client' files
 *     import through it (app/layout.tsx → '@/lib/api/client'), so all three
 *     are reachable from 'use client' components.
 *   - app/** (tests excluded): a value import is a violation ONLY in files
 *     carrying the 'use client' directive. Files without it are Server
 *     Components, Server Actions, and route handlers — there, these imports
 *     are the whole point. Known residual hole, accepted deliberately: an
 *     app/ file WITHOUT 'use client' that value-imports a banned package is
 *     skipped here yet can still reach the client bundle transitively if a
 *     'use client' component imports it; blanket-flagging app/ would
 *     false-positive on the many legitimate server-side imports.
 *
 * Type-only forms are fine everywhere — they're erased at build:
 *
 *   import type { X } from '@marginfront/db'    // allowed
 *   export type { X } from '@marginfront/db'    // allowed
 *   import { x, type Y } from '@marginfront/db' // VIOLATION — x is a value
 *
 * Why: each banned package is a single-entry bundle whose module graph
 * reaches node built-ins. A value import (static, dynamic import(), or
 * require()) from any 'use client'-reachable file drags that whole chain
 * into the browser bundle, which throws "Cannot find module 'node:fs'" at
 * module evaluation and kills the page. The sanctioned pattern is a
 * client-safe port locked by a parity test; see the safeMarginPercent
 * comment in src/lib/canon-format.ts.
 *
 * The scanner walks the real TypeScript AST instead of regex-matching
 * because client files RENDER doc snippets like "import { MarginFrontClient }
 * from '@marginfront/sdk'" inside template literals (sdk-simulator,
 * getting-started, IDETabs) — that's text, not an import. The AST is immune
 * to strings and comments by construction.
 *
 * Test files are excluded: jest runs in node, where importing these packages
 * is exactly how the parity tests keep the ports honest.
 */

const BANNED_PACKAGES = [
  // Single CJS entry that reaches the Prisma client and node:fs.
  '@marginfront/db',
  // Single entry whose module graph includes the cli path, which imports fs.
  '@marginfront/sdk',
]

const SRC_ROOT = join(__dirname, '..')
const APP_ROOT = join(__dirname, '..', '..', 'app')
const LIB_ROOT = join(__dirname, '..', '..', 'lib')
const COMPONENTS_ROOT = join(__dirname, '..', '..', 'components')

interface BannedValueImport {
  packageName: string
  statement: string
}

function bannedPackageFor(moduleSpecifier: string): string | undefined {
  return BANNED_PACKAGES.find(
    (pkg) => moduleSpecifier === pkg || moduleSpecifier.startsWith(`${pkg}/`)
  )
}

function importClauseHasValue(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true // side-effect import (`import '@marginfront/db'`) always evaluates the module
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings) return true
  if (ts.isNamespaceImport(bindings)) return true
  // `import {} from 'x'` still emits and evaluates the module.
  if (bindings.elements.length === 0) return true
  return bindings.elements.some((specifier) => !specifier.isTypeOnly)
}

function exportClauseHasValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause) return true
  if (ts.isNamespaceExport(node.exportClause)) return true
  if (node.exportClause.elements.length === 0) return true
  return node.exportClause.elements.some((specifier) => !specifier.isTypeOnly)
}

function hasUseClientDirective(sourceFile: ts.SourceFile): boolean {
  // The directive prologue is the run of leading string-literal statements
  // (comments don't break it). 'use client' after real code is inert.
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      return false
    }
    if (statement.expression.text === 'use client') return true
  }
  return false
}

function findClientBundleViolations(
  source: string,
  filePath: string,
  zone: 'src' | 'app'
): BannedValueImport[] {
  // Cheap pre-filter: any real import must contain the package name verbatim.
  if (!BANNED_PACKAGES.some((pkg) => source.includes(pkg))) return []

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    false,
    /\.(tsx|jsx)$/.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )

  if (zone === 'app' && !hasUseClientDirective(sourceFile)) return []

  const violations: BannedValueImport[] = []
  const record = (node: ts.Node, packageName: string) => {
    violations.push({ packageName, statement: node.getText(sourceFile) })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const banned = bannedPackageFor(node.moduleSpecifier.text)
        if (banned && importClauseHasValue(node.importClause)) {
          record(node, banned)
        }
      }
      return
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const banned = bannedPackageFor(node.moduleSpecifier.text)
        if (banned && exportClauseHasValue(node)) {
          record(node, banned)
        }
      }
      return
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        const banned = bannedPackageFor(node.moduleReference.expression.text)
        if (banned) record(node, banned)
      }
      return
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      const argument = node.arguments[0]
      if ((isDynamicImport || isRequire) && ts.isStringLiteralLike(argument)) {
        const banned = bannedPackageFor(argument.text)
        if (banned) record(node, banned)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function sourceFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    // lib/ and components/ hold symlink shims into src/ (scanned where they
    // resolve) plus broken links that readFileSync would throw on — skip.
    if (entry.isSymbolicLink()) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(fullPath))
    } else if (
      // allowJs is on — plain-JS (src/config/fonts.js) reaches the bundle too.
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
    ) {
      files.push(fullPath)
    }
  }
  return files
}

const scanSrcFixture = (source: string) =>
  findClientBundleViolations(source, 'fixture.tsx', 'src')
const scanAppFixture = (source: string) =>
  findClientBundleViolations(source, 'fixture.tsx', 'app')

describe('the scanner itself understands the import forms', () => {
  it('allows every type-only form', () => {
    const allowed = [
      "import type { KeyRole } from '@marginfront/db'\n",
      "export type {\n  BreakdownRow,\n} from '@marginfront/db'\n",
      "import { type KeyRole, type Prisma } from '@marginfront/db'\n",
      "import type { MarginFrontClient } from '@marginfront/sdk'\n",
    ]
    for (const snippet of allowed) {
      expect(scanSrcFixture(snippet)).toEqual([])
    }
  })

  it('flags value imports: mixed, multi-line, default, namespace, re-export, side-effect, subpath, import-equals', () => {
    const violations = [
      "import { safeMarginPercent } from '@marginfront/db'\n",
      "import { mintableKeyRoles, type KeyRole } from '@marginfront/db'\n",
      "import {\n  safeMarginPercent,\n  type KeyRole,\n} from '@marginfront/db'\n",
      "import prisma from '@marginfront/db'\n",
      "import * as db from '@marginfront/db'\n",
      "export { safeMarginPercent } from '@marginfront/db'\n",
      "export * from '@marginfront/db'\n",
      "import '@marginfront/db'\n",
      "import { db } from '@marginfront/db/anything'\n",
      "import db = require('@marginfront/db')\n",
    ]
    for (const snippet of violations) {
      expect(scanSrcFixture(snippet)).toHaveLength(1)
    }
  })

  it('flags dynamic import() and require(), for every banned package', () => {
    const dynamicImport =
      "async function load() {\n  const { db } = await import('@marginfront/db')\n}\n"
    expect(scanSrcFixture(dynamicImport)).toEqual([
      expect.objectContaining({ packageName: '@marginfront/db' }),
    ])

    const requireCall =
      "const { MarginFrontClient } = require('@marginfront/sdk')\n"
    expect(scanSrcFixture(requireCall)).toEqual([
      expect.objectContaining({ packageName: '@marginfront/sdk' }),
    ])
  })

  it('ignores banned import lines inside template literals (rendered doc snippets)', () => {
    const templateLiteralDecoy =
      "const snippet = `import { MarginFrontClient } from '@marginfront/sdk';\n" +
      'const client = new MarginFrontClient(apiKey);`\n'
    expect(scanSrcFixture(templateLiteralDecoy)).toEqual([])

    const requireInsideTemplate =
      'const prompt = `2. Create and run test.js:\n\n' +
      'const { MarginFrontClient } = require("@marginfront/sdk");`\n'
    expect(scanSrcFixture(requireInsideTemplate)).toEqual([])
  })

  it('ignores mentions in comments and plain strings', () => {
    const decoys = [
      "// see '@marginfront/db' for the canonical impl\n",
      "/*\n import { db } from '@marginfront/db'\n*/\n",
      'const docs = "install @marginfront/sdk and import { MarginFrontClient } from \'@marginfront/sdk\'"\n',
    ]
    for (const snippet of decoys) {
      expect(scanSrcFixture(snippet)).toEqual([])
    }
  })
})

describe("app/ zone: only 'use client' files are policed", () => {
  it("flags a banned value import in a 'use client' file", () => {
    const clientComponent =
      "'use client'\n\nimport { safeMarginPercent } from '@marginfront/db'\n"
    expect(scanAppFixture(clientComponent)).toHaveLength(1)

    const doubleQuotedAfterComment =
      '// header comment\n"use client"\nimport { db } from "@marginfront/db"\n'
    expect(scanAppFixture(doubleQuotedAfterComment)).toHaveLength(1)
  })

  it('allows the same import in a server file (no directive)', () => {
    const serverAction =
      "'use server'\n\nimport { safeMarginPercent } from '@marginfront/db'\n"
    expect(scanAppFixture(serverAction)).toEqual([])

    const serverComponent =
      "import { MANAGE_MONEY_ROLES } from '@marginfront/db'\n"
    expect(scanAppFixture(serverComponent)).toEqual([])

    const inertDirectiveAfterCode =
      "const x = 1\n'use client'\nimport { db } from '@marginfront/db'\n"
    expect(scanAppFixture(inertDirectiveAfterCode)).toEqual([])
  })
})

describe('no client-reachable value imports of banned server-only packages (browser crash guard)', () => {
  it("src/**, lib/**, components/** are value-import-free; app/** 'use client' files are value-import-free", () => {
    const zones = [
      { root: SRC_ROOT, zone: 'src', label: 'src' },
      { root: LIB_ROOT, zone: 'src', label: 'lib' },
      { root: COMPONENTS_ROOT, zone: 'src', label: 'components' },
      { root: APP_ROOT, zone: 'app', label: 'app' },
    ] as const

    const violations: string[] = []
    for (const { root, zone, label } of zones) {
      for (const file of sourceFilesUnder(root)) {
        const source = readFileSync(file, 'utf8')
        for (const found of findClientBundleViolations(source, file, zone)) {
          violations.push(
            `${label}/${relative(root, file)}\n      [${found.packageName}] ${found.statement.replace(/\s+/g, ' ')}`
          )
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `${violations.length} client-reachable file(s) pull a runtime VALUE from a banned server-only package:\n\n` +
          violations.map((v) => `  - ${v}`).join('\n') +
          `\n\nWhy this is a page-killer: ${BANNED_PACKAGES.join(' and ')} are ` +
          `single-entry packages whose module graphs reach node built-ins ` +
          `(node:fs). A value import — static, dynamic import(), or require() — ` +
          `from any 'use client'-reachable file pulls that chain into the ` +
          `browser bundle, which throws "Cannot find module 'node:fs'" at ` +
          `module evaluation and crashes the whole page. ` +
          `Fix: use "import type { X } from '...'" for types; for values, port ` +
          `them into a client-safe module locked by a parity test — see the ` +
          `safeMarginPercent comment in src/lib/canon-format.ts for the ` +
          `sanctioned pattern. Server-only code (Server Actions, route ` +
          `handlers, server page.tsx) belongs under app/ WITHOUT a 'use ` +
          `client' directive, where these imports are legal.`
      )
    }
  })
})

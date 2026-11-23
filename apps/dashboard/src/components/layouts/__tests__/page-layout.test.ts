/**
 * The `Page` layout, source-asserted
 * (dashboard jest is node-only, no RTL). Many routes render through this one
 * component, so each assertion pins a contract an edit could silently break:
 *
 *   - in-body <h1>: the title is a real heading in the page body, so
 *     getByRole('heading') works. The <h1> matches the PageShell
 *     command pages (page-shell.tsx type scale/weight/color tokens).
 *   - mf-token skin: canvas/border/text/tab-active colors come from the --mf-*
 *     tokens so Page routes sit flush with the PageShell command pages.
 *   - public API is frozen: every existing call site (title, description,
 *     scrollable, withPadding, headerProps{breadcrumb,tabs,actionButtons},
 *     children, forwardRef, ...HTMLAttributes) must compile unedited.
 *   - header breadcrumb push: SmartBreadcrumbs (header.tsx) reads
 *     options.breadcrumbs, so the updateOptions effect must exist.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

const PAGE_SRC = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('in-body <h1> title', () => {
  it('renders the title prop inside a real <h1> element', () => {
    expect(PAGE_SRC).toMatch(/<h1[^>]*>\s*\{title\}\s*<\/h1>/)
  })

  it('styles the <h1> with the mf command-page heading tokens (page-shell.tsx)', () => {
    const h1 = PAGE_SRC.match(/<h1\s+className='([^']*)'/)
    expect(h1).not.toBeNull()
    const classes = h1![1]
    expect(classes).toMatch(/font-semibold/)
    expect(classes).toMatch(/text-mf-tx\b/)
  })
})

describe('mf-token skin (flush with PageShell command pages)', () => {
  it('paints the wrapper canvas with bg-mf-bg', () => {
    expect(PAGE_SRC).toMatch(/bg-mf-bg/)
  })

  it('uses the mf border token, not border-border/50', () => {
    expect(PAGE_SRC).toMatch(/border-mf-bd/)
    expect(PAGE_SRC).not.toMatch(/border-border\/50/)
  })

  it('colors the active tab and description with mf text/accent tokens', () => {
    expect(PAGE_SRC).toMatch(/border-mf-accent text-mf-accent/)
    expect(PAGE_SRC).toMatch(/text-mf-tx2/)
  })

  it('does not use the primary/muted-foreground tab colors', () => {
    expect(PAGE_SRC).not.toMatch(/border-primary text-primary/)
    expect(PAGE_SRC).not.toMatch(/text-muted-foreground/)
  })
})

describe('public API is frozen (every call site compiles unedited)', () => {
  it('keeps the exact PageProps surface', () => {
    for (const prop of [
      'title: string',
      'description\\?: string',
      'scrollable\\?: boolean',
      'withPadding\\?: boolean',
      'headerProps\\?: PageHeaderProps',
      'children: React.ReactNode',
    ]) {
      expect(PAGE_SRC).toMatch(new RegExp(prop))
    }
  })

  it('PageProps still extends HTMLAttributes<HTMLDivElement> (className + ...props + ref)', () => {
    expect(PAGE_SRC).toMatch(
      /interface PageProps extends React\.HTMLAttributes<HTMLDivElement>/
    )
  })

  it('keeps the headerProps shape: breadcrumb, tabs, actionButtons', () => {
    expect(PAGE_SRC).toMatch(/breadcrumb\?: BreadcrumbItem\[\]/)
    expect(PAGE_SRC).toMatch(/tabs\?: TabItem\[\]/)
    expect(PAGE_SRC).toMatch(/actionButtons\?: React\.ReactNode/)
  })

  it('stays a forwardRef component named Page with the Page displayName', () => {
    expect(PAGE_SRC).toMatch(
      /export const Page = React\.forwardRef<HTMLDivElement, PageProps>/
    )
    expect(PAGE_SRC).toMatch(/Page\.displayName = 'Page'/)
  })

  it('still honors scrollable and withPadding on the content area', () => {
    expect(PAGE_SRC).toMatch(/scrollable && 'overflow-y-auto'/)
    expect(PAGE_SRC).toMatch(/withPadding &&/)
  })

  it('still renders every consumer tab as a next/link with its aria-current/disabled behavior', () => {
    expect(PAGE_SRC).toMatch(
      /aria-current=\{tab\.isActive \? 'page' : undefined\}/
    )
    expect(PAGE_SRC).toMatch(/aria-disabled=\{tab\.disabled\}/)
    expect(PAGE_SRC).toMatch(
      /tab\.disabled && 'pointer-events-none opacity-50'/
    )
  })
})

describe('header breadcrumb push preserved (SmartBreadcrumbs consumes it)', () => {
  it('pushes breadcrumbs and pageTitle via updateOptions', () => {
    expect(PAGE_SRC).toMatch(/updateOptions\(\{/)
    expect(PAGE_SRC).toMatch(/pageTitle: title/)
    expect(PAGE_SRC).toMatch(/breadcrumbs: breadcrumbs\.length > 0/)
  })

  it('does NOT have PageShell edit-layout features', () => {
    expect(PAGE_SRC).not.toMatch(/Edit layout/)
    expect(PAGE_SRC).not.toMatch(/onSaveLayout/)
  })
})

describe('Page layout details', () => {
  const { readFileSync } = require('node:fs')
  const { join } = require('node:path')
  const root = join(__dirname, '..', '..', '..', '..')

  it('Page skips the title bar entirely when there is nothing to show', () => {
    const src = readFileSync(
      join(root, 'src/components/layouts/page.tsx'),
      'utf8'
    )
    expect(src).toMatch(
      /\{\(title \|\| description \|\| hasTabs \|\| headerProps\?\.actionButtons\) && \(/
    )
    expect(src).toMatch(/\{title && \(\s*<h1/)
  })
})

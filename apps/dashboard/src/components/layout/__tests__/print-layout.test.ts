import { readFileSync } from 'fs'
import { join } from 'path'

// Asserts on source text: the shell leans on client-only hooks that Node-only jest can't render.

const SRC_DIR = join(__dirname, '..', '..', '..')
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8')

const sidebarSrc = read(SRC_DIR, 'components', 'layout', 'app-sidebar.tsx')
const shellSrc = read(
  SRC_DIR,
  '..',
  'app',
  '(dashboard)',
  'DashboardClientLayout.tsx'
)
const cssSrc = read(SRC_DIR, 'index.css')

describe('the dashboard shell on paper', () => {
  it('hides the whole sidebar, spacer included, when printing', () => {
    expect(sidebarSrc).toMatch(
      /<motion\.div[\s\S]{0,120}className='h-full print:hidden'/
    )
  })

  it('marks the one-screen shell so print styles can let it grow', () => {
    expect(shellSrc).toMatch(
      /className='print-grow flex h-screen w-full overflow-hidden'/
    )
  })

  it('lets the marked shell, its columns and the main area grow and stop clipping in print', () => {
    const printBlock = cssSrc.slice(cssSrc.indexOf('@media print {'))
    expect(printBlock).toMatch(
      /\.print-grow,\s*\.print-grow > \*,\s*\.print-grow main \{\s*height: auto !important;\s*overflow: visible !important;\s*\}/
    )
  })
})

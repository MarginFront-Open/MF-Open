import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Source-assertion wiring for the install-kit panel. Dashboard jest
 * is node-only (no RTL), so — like money-invoices-tab.test.ts — we assert the
 * component's wiring against its source instead of mounting it: the "Send the
 * kit" button opens the in-page install-kit panel,
 * and the panel builds its copy through the pure, tested generator.
 */
const COMPONENTS = join(__dirname, '..', 'components')

describe('internal-ai-spend/index.tsx — Send-the-kit is wired to the real panel', () => {
  const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8')

  it('has no coming-soon link (no comingSoon href, no KIT_STUB_HREF)', () => {
    expect(src).not.toContain('comingSoon=install-kit')
    expect(src).not.toContain('KIT_STUB_HREF')
  })

  it('opens the install-kit panel from the button instead of navigating away', () => {
    expect(src).toMatch(
      /import \{ InstallKitDialog \} from '\.\/components\/install-kit-dialog'/
    )
    expect(src).toMatch(/onClick=\{\(\) => \{?[\s\S]{0,200}?setKitOpen\(true\)/)
    expect(src).toMatch(/<InstallKitDialog\b/)
    expect(src).toMatch(/data=\{data\}/)
  })
})

describe('install-kit-dialog.tsx — copy surface over the pure generator', () => {
  const src = readFileSync(join(COMPONENTS, 'install-kit-dialog.tsx'), 'utf8')

  it('renders the kit from the pure buildInstallKit generator, not inline copy', () => {
    expect(src).toMatch(
      /import \{[\s\S]*?buildInstallKit,[\s\S]*?formatKitPlainText,?[\s\S]*?\} from '\.\.\/install-kit'/
    )
    expect(src).toMatch(/buildInstallKit\(\{/)
  })

  it('reuses buildCapSentence for the cap line — never re-derives the sentence', () => {
    expect(src).toMatch(
      /import \{ buildCapSentence \} from '\.\.\/spend-controls-utils'/
    )
    expect(src).toMatch(/buildCapSentence\(/)
    // No hand-rolled "Stop <provider> spend at ..." string assembly here.
    expect(src).not.toMatch(/`Stop \$\{/)
  })

  it('delivers by copy or link, never by email', () => {
    expect(src).toMatch(/navigator\.clipboard\.writeText/)
    expect(src.toLowerCase()).not.toContain('sendemail')
    expect(src).not.toMatch(/resend|nodemailer/i)
  })

  it('a zero-cap org gets the capless install kit', () => {
    expect(src).toContain('buildCaplessInstallKit')
    expect(src).not.toContain('Set a cap above first')
  })

  it('gates the cap picker and why-note on caps existing', () => {
    const gateAt = src.indexOf('{hasCaps ? (')
    const pickerAt = src.indexOf('Which cap is this kit for?')
    expect(gateAt).toBeGreaterThan(-1)
    expect(pickerAt).toBeGreaterThan(gateAt)
  })

  it('renders the arming line and caps-later note null-safely', () => {
    expect(src).toMatch(/formatArmingAndSupport\(kit\)/)
    expect(src).toMatch(/kit\.capsLaterNote !== null/)
  })

  // The arming line already ends in a period, so the render site adds no
  // separator.
  it('joins the arming line and support note through the generator, not inline', () => {
    expect(src).not.toMatch(/\$\{kit\.armingLine\}\./)
    expect(src).not.toContain('kit.supportNote')
  })

  it('shows the Windows/WSL line on screen with the docs link', () => {
    expect(src).toContain('WINDOWS_WSL_SENTENCE')
    expect(src).toContain('CCC_WINDOWS_DOCS_URL')
  })

  it('shows both the Path A command and the Path B prompt (Path A never hidden)', () => {
    expect(src).toContain('kit.pathA.command')
    expect(src).toContain('kit.pathB.prompt')
  })

  it('renders the key-ready section from the generator', () => {
    expect(src).toContain('kit.keyReady.heading')
    expect(src).toContain('kit.keyReady.lines')
  })

  it('shows the admin send checklist on screen, above the cap picker', () => {
    expect(src).toMatch(/ADMIN_SEND_CHECKLIST/)
    const iChecklist = src.indexOf('ADMIN_SEND_CHECKLIST.heading')
    const iCapPicker = src.indexOf('Which cap is this kit for?')
    expect(iChecklist).toBeGreaterThan(-1)
    expect(iCapPicker).toBeGreaterThan(iChecklist)
  })

  it('carries no --no-prompt anywhere (Path B guides; the human runs init)', () => {
    expect(src).not.toContain('--no-prompt')
  })

  it('does not render a Path C section', () => {
    // The kit offers only Paths A and B, in the panel and the copyable text.
    expect(src).not.toContain('kit.pathC')
  })

  it('links out to the docs (only when configured) and the source, as safe external links', () => {
    expect(src).toContain('{CCC_DOCS_URL ? (')
    expect(src).toContain('href={CCC_DOCS_URL}')
    expect(src).toContain('{sourceUrl ? (')
    expect(src).toContain('href={sourceUrl}')
    expect(src).not.toContain('npmjs.com')
    expect(src).not.toContain('docs.marginfront.com')
    for (const href of ['href={CCC_DOCS_URL}', 'href={sourceUrl}']) {
      const at = src.indexOf(href)
      expect(src.slice(at, at + 160)).toMatch(
        /target='_blank'[\s\S]*?rel='noopener noreferrer'/
      )
    }
  })
})

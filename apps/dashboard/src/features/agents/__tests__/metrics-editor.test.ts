import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * The metrics editor is ONE surface with edit-in-place, and agents have a
 * name/description edit affordance. Source-assertion, not a
 * render test — these components depend on client-only hooks this repo's
 * Node-only jest can't render.
 *
 * Contracts locked here:
 *   - no wizard step machinery (single surface, all fields at once)
 *   - existing metrics are editable in place via updateSignalWithServices
 *   - the delete affordance stays and nothing new is destructive
 *   - single AND multi-service flows share the one editor (combobox + add row)
 *   - agent name/description edit surface exists and is wired into AgentTabs
 *   - no em dash in rendered copy (honest-null '—' ok)
 *   - no separate Signals.tsx list
 */

const FEATURE_DIR = join(__dirname, '..')
const wizardSrc = readFileSync(join(FEATURE_DIR, 'MetricsWizard.tsx'), 'utf8')
const dialogSrc = readFileSync(
  join(FEATURE_DIR, 'components', 'edit-agent-dialog.tsx'),
  'utf8'
)
const tabsSrc = readFileSync(join(FEATURE_DIR, 'AgentTabs.tsx'), 'utf8')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
}

function stripNullGlyph(src: string): string {
  return src.replace(/(['"])—\1/g, '').replace(/>\s*—\s*</g, '><')
}

describe('metrics editor: one surface, no steps', () => {
  it('has no wizard step machinery', () => {
    expect(wizardSrc).not.toMatch(/WizardStep/)
    expect(wizardSrc).not.toMatch(/currentStep/)
    expect(wizardSrc).not.toMatch(/setCurrentStep/)
  })

  it('name, services, and count type all live on the single editor surface', () => {
    expect(wizardSrc).toMatch(/What task does your agent perform\?/)
    expect(wizardSrc).toMatch(/What services power it\?/)
    expect(wizardSrc).toMatch(/How should we count it\?/)
  })

  it('supports the multi-service flow inline (combobox stays open for another row)', () => {
    expect(wizardSrc).toMatch(/ServiceCombobox/)
    expect(wizardSrc).toMatch(/Add another service/)
    expect(wizardSrc).toMatch(/removeMetricService/)
  })
})

describe('metrics editor: edit in place', () => {
  it('saves edits through the transactional update action', () => {
    expect(wizardSrc).toMatch(
      /import\s*\{[^}]*\bupdateSignalWithServices\b[^}]*\}\s*from\s*'@\/app\/actions\/signal-services'/s
    )
    expect(wizardSrc).toMatch(/updateSignalWithServices\(\{/)
  })

  it('every saved metric row carries an edit affordance', () => {
    expect(wizardSrc).toMatch(/IconPencil/)
    expect(wizardSrc).toMatch(/aria-label=\{`Edit \$\{metric\.name\}`\}/)
  })

  it('warns that renaming changes the ingest key (events match on name)', () => {
    expect(wizardSrc).toMatch(/usage events match on this name/i)
  })

  it('keeps the existing delete affordance and adds no other destructive surface', () => {
    expect(wizardSrc).toMatch(/useDeleteSignal/)
    expect(wizardSrc).toMatch(/deleteSignalMutation\.mutateAsync/)
    // One trash icon (per-metric delete) is the only destructive control.
    expect(wizardSrc.match(/IconTrash/g)).toHaveLength(2) // import + one usage
    expect(wizardSrc).not.toMatch(/useDeleteAgent/)
  })
})

describe('agent core fields — edit surface (name/description)', () => {
  it('EditAgentDialog updates name and description through useUpdateAgent', () => {
    expect(dialogSrc).toMatch(/useUpdateAgent/)
    expect(dialogSrc).toMatch(/name:\s*name\.trim\(\)/)
    expect(dialogSrc).toMatch(/description:\s*description\.trim\(\)/)
  })

  it('AgentTabs mounts the dialog behind an Edit agent button', () => {
    expect(tabsSrc).toMatch(/EditAgentDialog/)
    expect(tabsSrc).toMatch(/Edit agent/)
  })

  it('dialog remounts on open so a canceled draft never resurfaces', () => {
    expect(tabsSrc).toMatch(
      /<EditAgentDialog\s+key=\{String\(showEditDialog\)\}/
    )
    expect(dialogSrc).not.toMatch(/handleOpenChange/)
  })
})

describe('rendered copy hygiene', () => {
  it.each([
    ['MetricsWizard.tsx', wizardSrc],
    ['edit-agent-dialog.tsx', dialogSrc],
    ['AgentTabs.tsx', tabsSrc],
  ])('%s has no em dash in rendered copy', (_name, src) => {
    expect(stripNullGlyph(stripComments(src))).not.toMatch(/—/)
  })
})

describe('no unused list component', () => {
  it('there is no separate Signals.tsx list', () => {
    expect(existsSync(join(FEATURE_DIR, 'Signals.tsx'))).toBe(false)
  })
})

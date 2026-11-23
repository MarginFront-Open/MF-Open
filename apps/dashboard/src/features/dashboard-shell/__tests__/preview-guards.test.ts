import { readFileSync } from 'fs'
import { join } from 'path'

// Preview page guards (source-asserts — dashboard jest is node-only, no
// RTL).

const shellDir = join(__dirname, '..')
const pagePath = join(__dirname, '../../../../app/dev/catalog-preview/page.tsx')

describe('catalog-preview guards', () => {
  it('the preview page 404s in production before rendering anything', () => {
    const src = readFileSync(pagePath, 'utf8')
    const body = src.slice(src.indexOf('export default'))
    const guard = body.indexOf("process.env.NODE_ENV === 'production'")
    const render = body.indexOf('<CatalogPreview')
    expect(guard).toBeGreaterThan(-1)
    expect(body).toMatch(/notFound\(\)/)
    expect(guard).toBeLessThan(render)
  })

  it('the preview renders both theme sections (.light and .dark wrappers)', () => {
    const src = readFileSync(join(shellDir, 'catalog-preview.tsx'), 'utf8')
    expect(src).toMatch(/['"`][^'"`]*\blight\b[^'"`]*['"`]/)
    expect(src).toMatch(/['"`][^'"`]*\bdark\b[^'"`]*['"`]/)
  })
})

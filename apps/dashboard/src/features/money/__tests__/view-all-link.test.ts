import { buildCostManagementHref } from '../view-all-link'

describe('buildCostManagementHref', () => {
  it('rolling (no params) → empty startDate/endDate', () => {
    expect(buildCostManagementHref({})).toBe(
      '/finops?tab=cost-management&startDate=&endDate='
    )
  })

  it('month mode → carries the resolved month window through', () => {
    expect(
      buildCostManagementHref({
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      })
    ).toBe(
      '/finops?tab=cost-management&startDate=2026-06-01&endDate=2026-06-30'
    )
  })

  it('custom mode → carries the exact custom window through', () => {
    expect(
      buildCostManagementHref({
        startDate: '2026-01-15',
        endDate: '2026-02-02',
      })
    ).toBe(
      '/finops?tab=cost-management&startDate=2026-01-15&endDate=2026-02-02'
    )
  })
})

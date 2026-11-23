// The ONE chart palette for the 7 catalog
// components. Values are the --mf-* CSS custom properties (src/index.css),
// referenced directly (never re-wrapped in hsl()) since the mf-* tokens
// already carry their own alpha. The CHART_COLORS in
// command-center-shared.tsx is a separate, unrelated palette; the two share
// no values.
//
// Derived from the brand green/orange family and validated
// per-theme with the dataviz palette validator (adjacent-pair CVD ΔE ≥ 21
// both modes; chart3-6 sit inside the mode's lightness band; slots 1-2 are
// the brand accent/orange verbatim — on dark they run brighter than the
// conservative band by design, brand identity wins). Status tokens
// (--mf-green/amber/red) are deliberately NOT series colors: a
// "good/warn/bad" color must never impersonate "series 4".
export const MF_CHART_COLORS = [
  'var(--mf-accent)',
  'var(--mf-orange)',
  'var(--mf-chart3)',
  'var(--mf-chart4)',
  'var(--mf-chart5)',
  'var(--mf-chart6)',
] as const

// The spend-vs-revenue pairing: accent for the primary series,
// tx3 for the secondary. Used by timeseries-chart's 1-2 series prop.
export const MF_SERIES = {
  primary: 'var(--mf-accent)',
  secondary: 'var(--mf-tx3)',
} as const

/**
 * TS twin of the --mf-* token block in
 * src/index.css. CSS is the runtime source of truth; this twin exists for
 * the preview route's swatch sheet and the token-parity test that keeps the
 * two from drifting. Values must stay byte-identical to index.css.
 *
 * Brand green/orange; dark backgrounds sit on a green-tinted near-black
 * ramp hsl(150 15% 6|8|14%). chart3-6 are the CVD-validated series colors
 * consumed by chart-colors.ts.
 */

export const MF_TOKEN_NAMES = [
  'bg',
  'sidebar',
  'card',
  'card2',
  'bd',
  'bd2',
  'tx',
  'tx2',
  'tx3',
  'accent',
  'accent2',
  'orange',
  'green',
  'amber',
  'red',
  'barbg',
  'chart3',
  'chart4',
  'chart5',
  'chart6',
] as const

export type MfTokenName = (typeof MF_TOKEN_NAMES)[number]

export const MF_THEME_DARK: Record<MfTokenName, string> = {
  bg: '#0d120f',
  sidebar: '#0f1512',
  card: '#111714',
  card2: '#1e2924',
  bd: 'rgba(255, 255, 255, 0.08)',
  bd2: 'rgba(255, 255, 255, 0.055)',
  tx: '#f1f4f2',
  tx2: '#939f99',
  tx3: '#636e69',
  accent: '#1cca79',
  accent2: 'rgba(28, 202, 121, 0.16)',
  orange: '#fa7e19',
  green: '#4cb782',
  amber: '#ddaf3c',
  red: '#e5735e',
  barbg: 'rgba(255, 255, 255, 0.07)',
  chart3: '#25a2b5',
  chart4: '#b1880b',
  chart5: '#35a175',
  chart6: '#c25f2f',
}

export const MF_THEME_LIGHT: Record<MfTokenName, string> = {
  bg: '#fafafa',
  sidebar: '#f7f8f7',
  card: '#ffffff',
  card2: '#f1f3f2',
  bd: 'rgba(17, 20, 24, 0.1)',
  bd2: 'rgba(17, 20, 24, 0.065)',
  tx: '#171c1a',
  tx2: '#616b66',
  tx3: '#9aa29e',
  accent: '#16a260',
  accent2: '#e7f9ee',
  orange: '#fa7e19',
  green: '#2f9e68',
  amber: '#b7791f',
  red: '#d0503a',
  barbg: 'rgba(17, 20, 24, 0.06)',
  chart3: '#088ca0',
  chart4: '#b38705',
  chart5: '#127d56',
  chart6: '#ad491f',
}

/** Theme-invariant radii; CSS vars --mf-radius-* in index.css. */
export const MF_RADII = {
  card: '11px',
  inner: '9px',
  seg: '8px',
  segItem: '6px',
} as const

/**
 * MarginFront Tailwind Configuration Package
 *
 * This package provides shared Tailwind CSS configurations for MarginFront applications.
 *
 * @example
 * ```typescript
 * // In your tailwind.config.ts
 * import { marginfrontTheme } from '@marginfront/tailwind-config'
 *
 * export default {
 *   ...marginfrontTheme,
 *   // Your custom overrides
 * }
 * ```
 */

export { default, marginfrontTheme } from './marginfront-theme'

export type { Config } from 'tailwindcss'

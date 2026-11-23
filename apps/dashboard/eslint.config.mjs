import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import tseslint from 'typescript-eslint'
import pluginQuery from '@tanstack/eslint-plugin-query'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...pluginQuery.configs['flat/recommended'],
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'src/components/ui/**', 'components/**']),
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-console': 'warn',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react-icons/fa', message: 'Use lucide-react instead.' },
            { name: 'react-icons/ai', message: 'Use lucide-react instead.' },
            { name: 'react-icons/bs', message: 'Use lucide-react instead.' },
            { name: 'react-icons/bi', message: 'Use lucide-react instead.' },
            { name: 'react-icons/fi', message: 'Use lucide-react instead.' },
          ],
        },
      ],
    },
  },
  // Revenue-type guard. Action files MUST return canonical types from
  // @marginfront/db (RevenueMetrics / AgentEarned / InvoiceTotals / Mrr /
  // CostMetrics) — never hand-build a {earned, billed, collected} object
  // literal. The 4-label canon (Agent-Earned / Revenue / Billed /
  // Collected) is documented in packages/db/CANON.md.
  // Canon display guard: money never renders through raw .toFixed, so
  // every amount goes through one formatter. canon-format.ts is the only
  // formatter. Export routes are exempt (spreadsheet cells have
  // their own deliberate formatting contract). NOTE: flat config REPLACES
  // (not merges) a rule across matching blocks — this block must stay
  // ABOVE the app/actions block, which re-lists these selectors.
  {
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    ignores: ['app/api/export/**', '**/__tests__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='toFixed'][callee.object.name=/^.*(cost|revenue|margin|amount|price|earned|billed|collected|mrr|arr)/i]",
          message:
            'Raw .toFixed on a money value. Use formatCost / formatCurrency / formatPct from @/lib/canon-format.',
        },
        {
          selector:
            "CallExpression[callee.property.name='toFixed'][callee.object.property.name=/^.*(cost|revenue|margin|amount|price|earned|billed|collected|mrr|arr)/i]",
          message:
            'Raw .toFixed on a money value. Use formatCost / formatCurrency / formatPct from @/lib/canon-format.',
        },
      ],
    },
  },
  {
    files: ['app/actions/**/*.{ts,tsx}'],
    ignores: ['app/actions/__tests__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='toFixed'][callee.object.name=/^.*(cost|revenue|margin|amount|price|earned|billed|collected|mrr|arr)/i]",
          message:
            'Raw .toFixed on a money value. Use formatCost / formatCurrency / formatPct from @/lib/canon-format.',
        },
        {
          selector:
            "CallExpression[callee.property.name='toFixed'][callee.object.property.name=/^.*(cost|revenue|margin|amount|price|earned|billed|collected|mrr|arr)/i]",
          message:
            'Raw .toFixed on a money value. Use formatCost / formatCurrency / formatPct from @/lib/canon-format.',
        },
        {
          selector:
            "ObjectExpression:has(Property[key.name='earned']):has(Property[key.name='billed']):has(Property[key.name='collected'])",
          message:
            "Don't hand-build {earned, billed, collected} object literals in action files. Compose canonical library returns (RevenueMetrics, AgentEarned, InvoiceTotals) from @marginfront/db instead. See packages/db/CANON.md.",
        },
        // Canon M1/M2: hand-rolled percent math — ((a-b)/a)*100
        // margin/growth shapes and (part/total)*100 shares — is banned in
        // action files. Use safeMarginPercent / growthPercent / shareOfTotal
        // / avgPer from @marginfront/db. Scoped to app/actions because chart
        // geometry in components legitimately computes pixel percentages;
        // test mirrors are the sanctioned exception (ignores above).
        {
          selector:
            "BinaryExpression[operator='*'][right.value=100][left.operator='/'][left.left.operator='-']",
          message:
            'Hand-rolled margin/growth percent. Use safeMarginPercent or growthPercent from @marginfront/db (canon M1/M2, packages/db/CANON.md).',
        },
        {
          selector:
            "BinaryExpression[operator='*'][right.value=100][left.operator='/']:not([left.left.operator='-'])",
          message:
            'Hand-rolled share-of-total percent. Use shareOfTotal from @marginfront/db (canon M2, packages/db/CANON.md).',
        },
        // Canon R3: pricing math never happens inline — calcRouted and the
        // tier engine in @marginfront/db are the only legal homes for × rate.
        {
          selector:
            "BinaryExpression[operator='*'][right.property.name='rate'], BinaryExpression[operator='*'][left.property.name='rate']",
          message:
            'Inline "× rate" pricing math. Route through calcRouted / the @marginfront/db tier engine (canon R3).',
        },
      ],
    },
  },
])

export default eslintConfig

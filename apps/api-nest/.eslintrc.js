module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    // Both projects: the build tsconfig excludes **/*spec.ts, and with it
    // alone the typed parser cannot parse a spec at all.
    project: ['tsconfig.json', 'tsconfig.spec.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'test/'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
  },
  overrides: [
    {
      // The only rule specs relax, and it is off for two independent reasons.
      // Both have to be spent before it can go back on:
      //
      //   1. jest.mock binding. A spec that calls jest.mock('x') can
      //      only reach the MOCKED module through require('x') in the test
      //      body; an import hoists above the jest.mock call and binds the real
      //      one.
      //   2. Filesystem discovery. The route sweeps and the
      //      migration/parity integration specs walk a directory and
      //      require(filePath) each controller they find, so the specifier is a
      //      runtime value and cannot be an import at all.
      //
      // Removing reason 1 alone (say, by moving those specs to
      // jest.requireMock) does NOT make the relaxation unnecessary.
      files: ['**/*.spec.ts'],
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
      },
    },
    {
      // Canon M1/M2 guard: the analytics module holds most of the
      // percent and money math, so hand-rolled versions drift. Percent shapes and
      // money .toFixed are banned here — use safeMarginPercent /
      // growthPercent / shareOfTotal / avgPer from @marginfront/db
      // (packages/db/CANON.md).
      files: ['src/modules/analytics/**/*.ts'],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "BinaryExpression[operator='*'][right.value=100][left.operator='/'][left.left.operator='-']",
            message:
              'Hand-rolled margin/growth percent. Use safeMarginPercent or growthPercent from @marginfront/db (canon M1/M2).',
          },
          {
            selector:
              "BinaryExpression[operator='*'][right.value=100][left.operator='/']:not([left.left.operator='-'])",
            message:
              'Hand-rolled share-of-total percent. Use shareOfTotal from @marginfront/db (canon M2).',
          },
          {
            selector:
              "CallExpression[callee.property.name='toFixed'][callee.object.name=/^.*(cost|revenue|margin|amount|price|earned|billed|collected|mrr|arr)/i]",
            message:
              'Raw .toFixed on a money value in analytics. Return full-precision numbers (canon R4); the UI layer formats.',
          },
        ],
      },
    },
  ],
};

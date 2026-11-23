module.exports = function (options, webpack) {
  return {
    ...options,
    // Disable code splitting for serverless compatibility
    optimization: {
      ...options.optimization,
      splitChunks: false,
      runtimeChunk: false,
    },
    output: {
      ...options.output,
      libraryTarget: 'commonjs2',
    },
    externals: {
      '@prisma/client': 'commonjs @prisma/client',
      '.prisma/client': 'commonjs .prisma/client',
      // Add chromium as external since it's loaded at runtime
      '@sparticuz/chromium': 'commonjs @sparticuz/chromium',
    },
    module: {
      ...options.module,
      rules: options.module.rules.map((rule) => {
        if (rule.loader && rule.loader.includes('ts-loader')) {
          return {
            ...rule,
            options: {
              ...rule.options,
              transpileOnly: true, // Skip type checking during compilation
            },
          };
        }
        return rule;
      }),
    },
    plugins: options.plugins.filter((plugin) => {
      // Remove ForkTsCheckerWebpackPlugin to skip type checking
      return plugin.constructor.name !== 'ForkTsCheckerWebpackPlugin';
    }),
  };
};

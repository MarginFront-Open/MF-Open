import type { NextConfig } from 'next'
import { withSentryConfig } from '@sentry/nextjs'

const nextConfig: NextConfig = {
  // Enable standalone output for Docker deployments
  output: 'standalone',

  // Dev-only: allow cross-origin requests (HMR WebSocket + RSC fetches) from
  // wildcard subdomains used in local dev. Without these, Next.js 15+ returns
  // 400 on HMR WS upgrade for *.lvh.me / *.localhost subdomain hostnames,
  // which breaks client-side hydration of components like PortalActivityChart.
  // No effect in production (no HMR there).
  allowedDevOrigins: ['*.lvh.me', '*.localhost'],

  // Image optimization configuration
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'img.logo.dev',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.googleusercontent.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        pathname: '/**',
      },
    ],
  },

  // Turbopack configuration
  turbopack: {
    root: '../..',
    resolveAlias: {
      '@/app/*': './app/*',
      // Turbopack's multi-candidate '@/lib/*' alias below never falls
      // through to ./src/lib on `next build` for a file that doesn't also
      // exist in ./lib. Every src/lib-only module needs its own explicit
      // entry here.
      '@/lib/canon-format': './src/lib/canon-format',
      '@/lib/canon-date': './src/lib/canon-date',
      '@/lib/component-catalog': './src/lib/component-catalog',
      '@/lib/revenue-basis': './src/lib/revenue-basis',
      '@/lib/internal-email': './src/lib/internal-email',
      '@/lib/*': ['./lib/*', './src/lib/*'],
      '@/components/*': './src/components/*',
      '@/*': './src/*',
    },
  },

  // Redirects configuration
  async redirects() {
    return [
      // Top-level aliases that land on the role-aware home.
      // permanent: false (307) because browsers cache a 308 forever, which
      // would stop these paths from ever serving a page of their own.
      // '/' resolves the role-aware post-auth landing server-side, so this
      // can never loop back to these paths.
      { source: '/home', destination: '/', permanent: false },
      { source: '/overview', destination: '/', permanent: false },
      { source: '/revenue-dashboard', destination: '/', permanent: false },
      { source: '/dashboard', destination: '/', permanent: false },
      { source: '/users', destination: '/', permanent: false },
      { source: '/analytics', destination: '/', permanent: false },
      // /developer-zone/api-keys lands on the Build page's keys tab, the one
      // key-management surface. permanent: false (307) for the same
      // 308s-cache-forever reason as above.
      {
        source: '/developer-zone/api-keys',
        destination: '/build?tab=keys',
        permanent: false,
      },
      // /money?tab=spend-controls lands on the standalone /internal-ai-spend
      // page. The `has` matcher means it fires ONLY when the query matches;
      // plain /money (and every other tab) is untouched.
      // permanent: false (307) for the same 308s-cache-forever reason.
      {
        source: '/money',
        has: [{ type: 'query', key: 'tab', value: 'spend-controls' }],
        destination: '/internal-ai-spend',
        permanent: false,
      },
    ]
  },

  // Headers configuration
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ]
  },

  // Webpack configuration (for @tabler/icons-react and path aliases)
  webpack: (config) => {
    const path = require('path')
    config.resolve.alias = {
      ...config.resolve.alias,
      '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
      '@/app': path.resolve(__dirname, 'app'),
    }
    return config
  },
}

// Sentry configuration
const sentryWebpackPluginOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // The build plugin otherwise reports its own usage to Sentry's project on
  // every build, with or without a Sentry account configured here.
  telemetry: false,
  silent: true,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
}

// Export with Sentry config
export default withSentryConfig(nextConfig, sentryWebpackPluginOptions)

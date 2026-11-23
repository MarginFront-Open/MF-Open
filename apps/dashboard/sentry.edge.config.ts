import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN
const environment = process.env.NEXT_PUBLIC_APP_ENV || 'development'

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    // Performance Monitoring
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    // Send events from every environment except development
    enabled: environment !== 'development',
  })
} else {
  console.warn('Sentry DSN not configured (edge)')
}

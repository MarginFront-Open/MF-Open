import * as Sentry from '@sentry/nextjs'
import { getReplayPrivacyOptions } from './src/config/sentry'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN
const environment = process.env.NEXT_PUBLIC_APP_ENV || 'development'

if (dsn) {
  Sentry.init({
    dsn,
    environment,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    integrations: [Sentry.replayIntegration(getReplayPrivacyOptions())],
    // Performance Monitoring
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    // Session Replay
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    // Send events from every environment except development
    enabled: environment !== 'development',
  })
} else {
  console.warn('Sentry DSN not configured (client)')
}

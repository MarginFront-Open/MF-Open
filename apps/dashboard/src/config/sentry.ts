import * as Sentry from '@sentry/nextjs'

/**
 * Privacy settings for Sentry session replay.
 *
 * Default: every piece of text and every input is masked and all images and
 * media are blocked, so a recording shows the shape of the screen and nothing a
 * customer typed or was shown (names, amounts, email addresses).
 *
 * An operator who has decided they want readable recordings sets
 * NEXT_PUBLIC_SENTRY_REPLAY_UNMASK=true at build time. Inputs stay masked
 * either way.
 */
export function getReplayPrivacyOptions(): {
  maskAllText: boolean
  maskAllInputs: boolean
  blockAllMedia: boolean
} {
  const unmask = process.env.NEXT_PUBLIC_SENTRY_REPLAY_UNMASK === 'true'
  return {
    maskAllText: !unmask,
    maskAllInputs: true,
    blockAllMedia: !unmask,
  }
}

export function initSentry() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN
  const environment = process.env.NEXT_PUBLIC_APP_ENV || 'development'

  if (!dsn) {
    console.warn('Sentry DSN not configured')
    return
  }

  Sentry.init({
    dsn,
    environment,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(getReplayPrivacyOptions()),
    ],
    // Performance Monitoring
    tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
    // Session Replay
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    // Only send errors in production and staging
    enabled: environment !== 'development',
  })
}

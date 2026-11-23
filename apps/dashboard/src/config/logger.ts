import { Logtail } from '@logtail/browser'

let logtail: Logtail | null = null

export function initLogger() {
  const sourceToken = process.env.NEXT_PUBLIC_BETTERSTACK_SOURCE_TOKEN
  const environment = process.env.NEXT_PUBLIC_APP_ENV || 'development'

  if (!sourceToken) {
    console.warn('BetterStack source token not configured')
    return
  }

  if (environment === 'development') {
    console.log('BetterStack logging disabled in development')
    return
  }

  logtail = new Logtail(sourceToken)
}

export function getLogger() {
  return logtail
}

// Helper functions for logging
export const logger = {
  info: (message: string, context?: Record<string, any>) => {
    if (logtail) {
      logtail.info(message, context)
    }
    console.log(message, context)
  },
  warn: (message: string, context?: Record<string, any>) => {
    if (logtail) {
      logtail.warn(message, context)
    }
    console.warn(message, context)
  },
  error: (message: string, context?: Record<string, any>) => {
    if (logtail) {
      logtail.error(message, context)
    }
    console.error(message, context)
  },
  debug: (message: string, context?: Record<string, any>) => {
    if (logtail) {
      logtail.debug(message, context)
    }
    console.debug(message, context)
  },
}

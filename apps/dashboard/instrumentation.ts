export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
    const { logAuthConfigNotices } =
      await import('./app/lib/auth-startup-checks')
    logAuthConfigNotices()
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

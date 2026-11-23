import { collectAuthConfigNotices } from '../auth-startup-checks'

function messages(env: Record<string, string | undefined>) {
  return collectAuthConfigNotices(env)
}

describe('sign-in configuration checks at server start', () => {
  it('says nothing for a plain local-development setup', () => {
    expect(messages({ NODE_ENV: 'development' })).toEqual([])
  })

  it('reports an error when the bot check is on but no hostname is configured', () => {
    const notices = messages({
      NODE_ENV: 'production',
      TURNSTILE_SECRET_KEY: 'secret',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'site',
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].level).toBe('error')
    expect(notices[0].message).toContain('TURNSTILE_ALLOWED_HOSTNAMES is empty')
    expect(notices[0].message).toContain('Fix:')
  })

  it('reports an error when the bot check is on but the page has no site key', () => {
    const notices = messages({
      NODE_ENV: 'production',
      TURNSTILE_SECRET_KEY: 'secret',
      TURNSTILE_ALLOWED_HOSTNAMES: 'app.example.com',
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].level).toBe('error')
    expect(notices[0].message).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY')
  })

  it('is quiet when the bot check is fully configured', () => {
    expect(
      messages({
        NODE_ENV: 'production',
        TURNSTILE_SECRET_KEY: 'secret',
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'site',
        TURNSTILE_ALLOWED_HOSTNAMES: 'app.example.com',
      })
    ).toEqual([])
  })

  it('warns in production when the bot check is off', () => {
    const notices = messages({ NODE_ENV: 'production' })
    expect(notices).toHaveLength(1)
    expect(notices[0].level).toBe('warn')
    expect(notices[0].message).toContain('bot check is OFF')
  })

  it('reports a log-the-code switch left on in production as an ignored error', () => {
    const notices = messages({
      NODE_ENV: 'production',
      TURNSTILE_SECRET_KEY: 'secret',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'site',
      TURNSTILE_ALLOWED_HOSTNAMES: 'app.example.com',
      SKIP_OTP_EMAIL: 'true',
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].level).toBe('error')
    expect(notices[0].message).toContain('SKIP_OTP_EMAIL=true')
    expect(notices[0].message).toContain('IGNORED')
  })

  it('warns loudly when a log-the-link switch is active on localhost', () => {
    const notices = messages({
      NODE_ENV: 'development',
      SKIP_MAGIC_LINK_EMAIL: 'true',
    })
    expect(notices).toHaveLength(1)
    expect(notices[0].level).toBe('warn')
    expect(notices[0].message).toContain('SKIP_MAGIC_LINK_EMAIL=true')
  })
})

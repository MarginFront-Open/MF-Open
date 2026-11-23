import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { nextCookies } from 'better-auth/next-js'
import { emailOTP, organization, magicLink } from 'better-auth/plugins'
import { createAuthMiddleware, APIError } from 'better-auth/api'
import { db as prisma } from '@/app/lib/db'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'crypto'
import {
  TURNSTILE_PROTECTED_PATHS,
  isTurnstileEnabled,
  verifyTurnstileToken,
} from './turnstile'
import { getAuthBaseURL } from './auth-base-url'
import { isLocalDevShortcutActive } from './local-dev-shortcuts'
import {
  copyrightFooterHtml,
  escapeHtml,
  supportNoteHtml,
} from './email-html'
import { getSocialProviderCredentials } from './social-providers'
import { ac, roles } from './permissions'
import { getNoReplyFromEmail } from './email-from'
import { hashApiKeyForLookup } from '@marginfront/db'
import { leftOrganization, membershipProjectionHooks } from './membership-hooks'

// Email sending helper with dynamic Resend import
async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string
  subject: string
  html: string
}) {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  // Auth emails send from the shared noreply sender so replies to
  // sign-in / OTP / invite mail don't land in a monitored inbox.
  const fromEmail = getNoReplyFromEmail()

  if (!apiKey) {
    console.error(
      '[Email] A sign-in email could not be sent because RESEND_API_KEY is not set. ' +
        'Fix: set RESEND_API_KEY and RESEND_FROM_EMAIL. ' +
        'For local development on localhost only, set SKIP_OTP_EMAIL=true and SKIP_MAGIC_LINK_EMAIL=true to print the code or link to this log instead.'
    )
    throw new Error(
      'Email service not configured. Please set RESEND_API_KEY environment variable.'
    )
  }

  if (!fromEmail) {
    console.error(
      '[Email] No sender configured (set RESEND_INVOICE_FROM_EMAIL or RESEND_FROM_EMAIL)'
    )
    throw new Error(
      'Email service not configured. Please set RESEND_INVOICE_FROM_EMAIL (preferred noreply sender) or RESEND_FROM_EMAIL.'
    )
  }

  // Dynamic import to avoid serverless cold start issues
  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)

  const { data, error } = await resend.emails.send({
    from: fromEmail,
    to,
    subject,
    html,
  })

  if (error) {
    console.error('[Email] Resend error:', error)
    throw new Error(`Failed to send email: ${error.message}`)
  }

  console.log(`[Email] Sent to ${to}, id: ${data?.id}`)
  return data
}

// Passwords are stored as bcrypt hashes.
const bcryptHasher = {
  hash: async (password: string) => {
    return bcrypt.hash(password, 10)
  },
  verify: async (data: { hash: string; password: string }) => {
    return bcrypt.compare(data.password, data.hash)
  },
}

const socialProviders = getSocialProviderCredentials()

/**
 * Renders and sends the "You're invited" email whose CTA lands the invitee on
 * the accept page (`/invite/accept/{invitationId}`). The initial
 * invite (organization().sendInvitationEmail) and resendInvitation
 * (app/actions/team.ts) share ONE template and can't drift.
 *
 * This touches NO ba_verification / invite-magic token row — the accept page
 * keys off the invitation id and Better Auth's own auth, so a
 * resend just re-delivers the same link. Awaits sendEmail, so it throws if
 * Resend rejects (callers surface that as a failed resend).
 */
export async function sendInviteAcceptEmail({
  email,
  organizationName,
  invitationId,
}: {
  email: string
  organizationName: string
  invitationId: string
}) {
  const baseUrl = getAuthBaseURL()
  const inviteUrl = `${baseUrl}/invite/accept/${invitationId}`
  const safeInviteUrl = escapeHtml(inviteUrl)
  const safeOrganizationName = escapeHtml(organizationName)

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>You're invited to ${safeOrganizationName}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px;">

          <!-- Logo / Brand -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <span style="font-size: 24px; font-weight: 700; color: #10b981; letter-spacing: -0.5px;">
                MarginFront
              </span>
            </td>
          </tr>

          <!-- Main Card -->
          <tr>
            <td style="background-color: #141414; border: 1px solid #262626; border-radius: 12px; padding: 40px 32px;">

              <!-- Headline -->
              <h1 style="margin: 0 0 24px 0; font-size: 22px; font-weight: 700; color: #ffffff; line-height: 1.3;">
                You're invited to ${safeOrganizationName}
              </h1>

              <!-- Body -->
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                You've been invited to join <strong style="color: #ffffff;">${safeOrganizationName}</strong> on MarginFront.
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Click the button below to accept your invitation:
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
                <tr>
                  <td style="background-color: #10b981; border-radius: 8px;">
                    <a href="${safeInviteUrl}" target="_blank"
                       style="display: inline-block; padding: 12px 28px; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Accept invitation
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Expiry note -->
              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #d4d4d4;">
                <strong style="color: #ffffff;">This invitation is single-use and expires in 7 days.</strong>
              </p>

              <!-- Fallback link -->
              <p style="margin: 16px 0 0 0; font-size: 14px; line-height: 1.6; color: #a3a3a3;">
                If the button above doesn't work, copy and paste this link into your browser:
              </p>
              <p style="margin: 8px 0 0 0; font-size: 12px; line-height: 1.6; color: #737373; word-break: break-all;">
                <a href="${safeInviteUrl}" style="color: #10b981;">${safeInviteUrl}</a>
              </p>

              <!-- Help note -->
              <p style="margin: 32px 0 0 0; font-size: 13px; line-height: 1.6; color: #737373;">
                ${supportNoteHtml()}
              </p>

              <p style="margin: 16px 0 0 0; font-size: 13px; line-height: 1.6; color: #737373;">
                If you didn't expect this invitation, you can safely ignore this email.
              </p>

            </td>
          </tr>

          ${copyrightFooterHtml()}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  await sendEmail({
    to: email,
    subject: `You're invited to join ${organizationName} on MarginFront`,
    html,
  })
}

/**
 * The projection writes for every ba_member row Better Auth mints on its own. Built
 * once here and spread into `organizationHooks` below; the logic and the reasoning live in
 * ./membership-hooks so they can be tested without booting Better Auth.
 */
const membershipHooks = membershipProjectionHooks(prisma)

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  baseURL: getAuthBaseURL(),
  trustedOrigins: process.env.AUTH_TRUSTED_ORIGINS
    ? process.env.AUTH_TRUSTED_ORIGINS.split(',').map((o) => o.trim())
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        // Host-provided deployment URL
        process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
        process.env.NEXT_PUBLIC_BETTER_AUTH_URL || '',
      ].filter(Boolean),
  emailAndPassword: {
    enabled: true,
    // No page offers a password sign-up form, so the endpoint stays closed.
    // People join by magic link, emailed code, social sign-in or invitation.
    disableSignUp: true,
    password: {
      hash: bcryptHasher.hash,
      verify: bcryptHasher.verify,
    },
  },
  // Cloudflare Turnstile gate on bot-susceptible auth endpoints. Runs BEFORE
  // any plugin (emailOTP send, magicLink send, password sign-in/up, etc.)
  // processes the request — bots that haven't solved the challenge can't
  // reach the auth endpoints behind this hook.
  //
  // VERIFY endpoints (OTP verify, magic-link click) are intentionally NOT
  // protected here: Better-Auth's built-in 3-attempt OTP lockout handles
  // brute-force on those paths, and requiring a second challenge after a
  // successful send is bad UX.
  //
  // The check is on whenever TURNSTILE_SECRET_KEY is set, in every NODE_ENV.
  // There is no development-mode bypass: to run without it, leave the key unset.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!TURNSTILE_PROTECTED_PATHS.has(ctx.path)) {
        return // not protected — let it through
      }

      if (!isTurnstileEnabled()) {
        return
      }

      const body = (ctx.body ?? {}) as Record<string, unknown>
      const token =
        typeof body.turnstileToken === 'string' ? body.turnstileToken : null

      const headers = ctx.request?.headers
      const ip =
        headers?.get('cf-connecting-ip') ||
        headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        null

      const ok = await verifyTurnstileToken(token, ip)
      if (!ok) {
        throw new APIError('UNAUTHORIZED', {
          message:
            'Verification challenge failed. Please refresh and try again.',
        })
      }
    }),
    // The ONE membership route the organization plugin gives us no hook for.
    // /organization/leave deletes the caller's canonical ba_member row and fires no
    // organizationHooks (leaveOrganization in Better Auth's crud-members), and it is mounted for every session
    // holder whether the UI links to it or not. Without this, leaving an org strips the
    // canonical row and leaves user_organizations and team_members behind forever.
    //
    // Reading the RETURN VALUE, not the request body, is deliberate: the handler answers
    // with the member row it deleted, so this fires only on an actual success. On a
    // refusal (not a member, last owner) Better Auth puts an APIError in the same slot,
    // which has no organizationId and so falls through untouched.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/organization/leave') return

      const removed = ctx.context.returned as
        | { organizationId?: unknown; userId?: unknown; role?: unknown }
        | undefined
      if (
        typeof removed?.organizationId !== 'string' ||
        typeof removed?.userId !== 'string'
      ) {
        return
      }

      await leftOrganization(prisma, {
        organizationId: removed.organizationId,
        userId: removed.userId,
        role: typeof removed.role === 'string' ? removed.role : 'member',
      })
    }),
  },
  advanced: {
    database: {
      // The schema's id columns are UUIDs.
      generateId: () => randomUUID(),
    },
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          console.log(
            '[Better Auth] Session creation hook called for user:',
            session.userId
          )
          try {
            // The organization plugin keeps memberships in ba_member.
            const membership = await prisma.ba_member.findFirst({
              where: {
                userId: session.userId,
              },
              orderBy: {
                createdAt: 'desc',
              },
              include: {
                organizations: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            })

            if (membership) {
              console.log(
                `[Better Auth] Setting activeOrganizationId to ${membership.organizationId} for user ${session.userId}`
              )
              return {
                data: {
                  ...session,
                  activeOrganizationId: membership.organizationId,
                },
              }
            } else {
              console.log(
                `[Better Auth] No organization found for user ${session.userId}`
              )
              return {
                data: session,
              }
            }
          } catch (error) {
            console.error('[Better Auth] Session creation hook error:', error)
            return {
              data: session,
            }
          }
        },
      },
    },
  },
  secret: process.env.AUTH_SECRET!,
  plugins: [
    organization({
      // Register all five MarginFront roles with the login system (see ./permissions).
      // Without this, inviting someone as finance/developer fails with ROLE_NOT_FOUND.
      // owner/admin/member use Better Auth's default permissions; finance/developer get
      // member-level ones. Real permission enforcement lives in MarginFront's own
      // guards (OrgRoleGuard + ba_member.role), not here.
      ac,
      roles,
      membershipLimit: 100,
      organizationHooks: {
        // This plugin OWNS ba_member (see the `member` model mapping below) and
        // creates, re-roles and deletes rows there from inside node_modules — no Prisma call
        // in our source, so nothing we can grep for or sweep. membershipProjectionHooks is
        // what keeps user_organizations and team_members in step with those writes.
        ...membershipHooks,
      },
      async sendInvitationEmail(data) {
        const invitationIdentifier = `invite-magic:${data.invitation.id}`

        // DEDUPLICATION: Check if we've already created a token for this invitation
        // This prevents duplicate emails if Better Auth calls this callback multiple times
        const existingToken = await prisma.ba_verification.findFirst({
          where: {
            identifier: invitationIdentifier,
          },
        })

        if (existingToken) {
          console.log(
            `[Invitation] Token already exists for invitation ${data.invitation.id}, skipping duplicate email`
          )
          return // Don't send duplicate email
        }

        const magicToken = randomUUID()
        const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

        // The row is the dedup marker checked above. Only the hash is stored;
        // /api/invite-verify hashes an incoming ?token= to match it. The email
        // below does not carry this token.
        await prisma.ba_verification.create({
          data: {
            id: randomUUID(),
            identifier: invitationIdentifier,
            value: hashApiKeyForLookup(magicToken),
            expiresAt: tokenExpiry,
          },
        })

        console.log(`[Invitation] Sending single-click invite to ${data.email}`)

        // Build + send through the shared helper so this initial-invite path and
        // resendInvitation (app/actions/team.ts) render one identical email and
        // can't drift. The helper reads/writes NO ba_verification row, and the
        // accept-page link it sends keys off the invitation id, not the token.
        await sendInviteAcceptEmail({
          email: data.email,
          organizationName: data.organization.name,
          invitationId: data.invitation.id,
        })
      },
      schema: {
        organization: {
          modelName: 'organizations',
          fields: {
            name: 'name',
            slug: 'slug',
            logo: 'logo',
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
            metadata: 'organizationInfo',
          },
        },
        member: {
          modelName: 'ba_member',
        },
        invitation: {
          modelName: 'ba_invitation',
        },
      },
    }),
    emailOTP({
      otpLength: 6,
      expiresIn: 10 * 60, // 10 minutes
      // Store the OTP as a SHA-256 hash at rest. Better-Auth hashes on
      // write and constant-time-compares the hash on verify — no plaintext OTP in
      // ba_verification. Library-managed; do not hand-roll.
      storeOTP: 'hashed',
      allowedAttempts: 3,
      async sendVerificationOTP({ email, otp }, ctx) {
        console.log('[Better Auth] Sending OTP to:', email)

        if (isLocalDevShortcutActive('SKIP_OTP_EMAIL', ctx?.request?.headers)) {
          console.log('[Better Auth] Skipping email, OTP:', otp)
          return
        }

        const safeEmail = escapeHtml(email)

        try {
          const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your MarginFront verification code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px;">

          <!-- Logo / Brand -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <span style="font-size: 24px; font-weight: 700; color: #10b981; letter-spacing: -0.5px;">
                MarginFront
              </span>
            </td>
          </tr>

          <!-- Main Card -->
          <tr>
            <td style="background-color: #141414; border: 1px solid #262626; border-radius: 12px; padding: 40px 32px;">

              <!-- Headline -->
              <h1 style="margin: 0 0 24px 0; font-size: 22px; font-weight: 700; color: #ffffff; line-height: 1.3;">
                Your verification code
              </h1>

              <!-- Body -->
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Sign in to MarginFront as <a href="mailto:${safeEmail}" style="color: #10b981; text-decoration: underline;">${safeEmail}</a>.
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Enter this code to sign in:
              </p>

              <!-- OTP Code -->
              <div style="margin: 0 0 24px 0;">
                <span style="font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', monospace; font-size: 42px; font-weight: 700; letter-spacing: 6px; color: #10b981;">${otp}</span>
              </div>

              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #d4d4d4;">
                <strong style="color: #ffffff;">This code will expire in 10 minutes and can only be used once.</strong>
              </p>

              <!-- Help note -->
              <p style="margin: 32px 0 0 0; font-size: 13px; line-height: 1.6; color: #737373;">
                ${supportNoteHtml()}
              </p>

              <p style="margin: 16px 0 0 0; font-size: 13px; line-height: 1.6; color: #737373;">
                You are receiving this email because you requested to sign in to MarginFront.
              </p>

            </td>
          </tr>

          ${copyrightFooterHtml()}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

          await sendEmail({
            to: email,
            subject: `${otp} is your MarginFront verification code`,
            html,
          })
          console.log('[Better Auth] OTP email sent successfully to:', email)
        } catch (error) {
          console.error('[Better Auth] Failed to send OTP email:', error)
          throw error
        }
      },
    }),
    magicLink({
      expiresIn: 10 * 60, // 10 minutes
      // Store the magic-link token as a SHA-256 hash at rest. Better-
      // Auth hashes on write and hashes the incoming token on verify (raw token
      // stays in the emailed URL). Library-managed; do not hand-roll.
      storeToken: 'hashed',
      async sendMagicLink({ email, url }, ctx) {
        // Host only — the full url carries the single-use token.
        console.log('[Better Auth] Magic link origin:', new URL(url).origin)
        console.log('[Better Auth] Sending magic link to:', email)

        if (
          isLocalDevShortcutActive(
            'SKIP_MAGIC_LINK_EMAIL',
            ctx?.request?.headers
          )
        ) {
          console.log('[Better Auth] Magic link URL (email disabled):', url)
          return
        }

        const safeEmail = escapeHtml(email)
        const safeUrl = escapeHtml(url)

        try {
          const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in to MarginFront</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px;">

          <!-- Logo / Brand -->
          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <span style="font-size: 24px; font-weight: 700; color: #10b981; letter-spacing: -0.5px;">
                MarginFront
              </span>
            </td>
          </tr>

          <!-- Main Card -->
          <tr>
            <td style="background-color: #141414; border: 1px solid #262626; border-radius: 12px; padding: 40px 32px;">

              <!-- Headline -->
              <h1 style="margin: 0 0 24px 0; font-size: 22px; font-weight: 700; color: #ffffff; line-height: 1.3;">
                Sign in to MarginFront
              </h1>

              <!-- Body -->
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Sign in to MarginFront as <a href="mailto:${safeEmail}" style="color: #10b981; text-decoration: underline;">${safeEmail}</a>.
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Click the button below to sign in:
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
                <tr>
                  <td style="background-color: #10b981; border-radius: 8px;">
                    <a href="${safeUrl}" target="_blank"
                       style="display: inline-block; padding: 12px 28px; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Sign in to MarginFront
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #d4d4d4;">
                <strong style="color: #ffffff;">This link will expire in 10 minutes and can only be used once.</strong>
              </p>

              <!-- Fallback link -->
              <p style="margin: 16px 0 0 0; font-size: 14px; line-height: 1.6; color: #a3a3a3;">
                If the button above doesn't work, copy and paste this link into your browser:
              </p>
              <p style="margin: 8px 0 0 0; font-size: 12px; line-height: 1.6; color: #737373; word-break: break-all;">
                <a href="${safeUrl}" style="color: #10b981;">${safeUrl}</a>
              </p>

              <!-- Help note -->
              <p style="margin: 32px 0 0 0; font-size: 13px; line-height: 1.6; color: #737373;">
                ${supportNoteHtml()}
              </p>

              <p style="margin: 16px 0 0 0; font-size: 13px; line-height: 1.6; color: #737373;">
                You are receiving this email because you requested to sign in to MarginFront.
              </p>

            </td>
          </tr>

          ${copyrightFooterHtml()}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

          await sendEmail({
            to: email,
            subject: 'Sign in to MarginFront',
            html,
          })
          console.log(
            '[Better Auth] Magic link email sent successfully to:',
            email
          )
        } catch (error) {
          console.error('[Better Auth] Failed to send magic link email:', error)
          throw error
        }
      },
    }),
    nextCookies(),
  ],
  socialProviders,
  // Map to existing database table names
  user: {
    modelName: 'users',
    fields: {
      email: 'email',
      name: 'name',
      image: 'image',
      emailVerified: 'isEmailVerified',
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    },
  },
  session: {
    modelName: 'ba_session',
  },
  account: {
    modelName: 'ba_account',
    accountLinking: {
      enabled: true,
      trustedProviders: ['google', 'github'],
    },
  },
  verification: {
    modelName: 'ba_verification',
  },
})

export type Session = typeof auth.$Infer.Session
export type ActiveOrganization = typeof auth.$Infer.ActiveOrganization
export type Member = typeof auth.$Infer.Member
export type Organization = typeof auth.$Infer.Organization
export type Invitation = typeof auth.$Infer.Invitation

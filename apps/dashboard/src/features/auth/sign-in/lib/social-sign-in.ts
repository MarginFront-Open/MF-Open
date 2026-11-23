/**
 * The single source of truth for how a social (Google) sign-in request is built
 * from the sign-in page URL. Every social handler across the auth-form variants
 * routes through buildSocialSignInRequest so the invite-carrying callbackURL and
 * the login_hint pin are decided in exactly ONE place.
 *
 * Pure and React-free so it can be unit-tested directly.
 *
 * SECURITY: nothing here grants membership. The invited email is used only to
 * (a) pin Google's account chooser (login_hint) and (b) let the post-auth
 * landing show a wrong-account interstitial. Membership is still gated
 * server-side (email === invitation.email) at the accept surface.
 */

import { safeRedirectPath } from '@/app/lib/safe-redirect'

const SOCIAL_SUCCESS_PATH = '/auth/google/success'

export type MinimalSearchParams = { get(key: string): string | null }

export type InviteContext = {
  /** The invited email, from the `email` prefill param (null if absent). */
  invitedEmail: string | null
  /** An `/invite/accept/{id}` target carried on `redirectTo` (null otherwise). */
  inviteRedirect: string | null
}

/**
 * Reads invite context from the sign-in URL. Both values are UX hints only.
 */
export function readInviteContext(params: MinimalSearchParams): InviteContext {
  const email = params.get('email')?.trim()
  const redirectTo = safeRedirectPath(params.get('redirectTo'))
  const inviteRedirect =
    redirectTo && redirectTo.startsWith('/invite/accept/') ? redirectTo : null

  return {
    invitedEmail: email ? email : null,
    inviteRedirect,
  }
}

export type SocialSignInRequest = {
  provider: 'google'
  callbackURL: string
  loginHint?: string
}

/**
 * Builds the options for authClient.signIn.social.
 *
 * When invite context is present it (a) carries the invited email + accept
 * target onto the OAuth landing page (so it can enforce the wrong-account guard
 * and route to the accept page) and (b) sets login_hint to the invited email.
 *
 * better-auth sets login_hint on Google's authorize URL from the loginHint field.
 */
export function buildSocialSignInRequest(
  provider: 'google',
  params: MinimalSearchParams
): SocialSignInRequest {
  const { invitedEmail, inviteRedirect } = readInviteContext(params)

  const query = new URLSearchParams()
  if (invitedEmail) query.set('invitedEmail', invitedEmail)
  if (inviteRedirect) query.set('redirectTo', inviteRedirect)
  const qs = query.toString()

  return {
    provider,
    callbackURL: qs ? `${SOCIAL_SUCCESS_PATH}?${qs}` : SOCIAL_SUCCESS_PATH,
    ...(invitedEmail ? { loginHint: invitedEmail } : {}),
  }
}

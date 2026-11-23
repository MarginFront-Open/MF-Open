/**
 * Single source of truth for the noreply From address on outbound
 * transactional emails: auth (magic link, OTP, invite) and the billing-portal
 * login email all send from here so replies don't land in a monitored inbox.
 *
 * The value comes from RESEND_INVOICE_FROM_EMAIL, which despite its name is
 * the shared noreply sender for every email listed above. Falls
 * back to RESEND_FROM_EMAIL so a missing noreply env never blocks a send, and
 * returns undefined only when neither is set (callers raise "email not
 * configured").
 */
export function getNoReplyFromEmail(): string | undefined {
  return (
    process.env.RESEND_INVOICE_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim() ||
    undefined
  )
}

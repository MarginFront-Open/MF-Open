import {
  copyrightFooterHtml,
  escapeHtml,
  safeHttpUrlForHtml,
} from '@/app/lib/email-html'

export function renderMagicLinkEmail({
  customerName,
  organizationName,
  organizationLogo,
  magicLinkUrl,
}: {
  customerName: string
  organizationName: string
  organizationLogo: string | null
  magicLinkUrl: string
}): string {
  const safeOrganizationName = escapeHtml(organizationName)
  const safeCustomerName = escapeHtml(customerName)
  const safeMagicLinkUrl = escapeHtml(magicLinkUrl)
  const safeLogoUrl = safeHttpUrlForHtml(organizationLogo)
  const logoHtml = safeLogoUrl
    ? `<img src="${safeLogoUrl}" alt="${safeOrganizationName}" style="height: 40px; width: auto; margin-bottom: 24px;" />`
    : `<h2 style="margin: 0 0 24px 0; color: #ffffff; font-size: 22px; font-weight: 700;">${safeOrganizationName}</h2>`

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in to ${safeOrganizationName}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px;">

          <!-- Main Card -->
          <tr>
            <td style="background-color: #141414; border: 1px solid #262626; border-radius: 12px; padding: 40px 32px;">

              ${logoHtml}

              <!-- Headline -->
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: #ffffff; line-height: 1.3;">
                Sign in to your billing portal
              </h1>

              <!-- Body -->
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Hi ${safeCustomerName},
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                You're receiving this because you have a billing account with <strong style="color: #ffffff;">${safeOrganizationName}</strong>. Click below to securely access your billing portal. This link expires in 1 hour and can only be used once.
              </p>

              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
                <tr>
                  <td style="background-color: #10b981; border-radius: 8px;">
                    <a href="${safeMagicLinkUrl}" target="_blank"
                       style="display: inline-block; padding: 12px 28px; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Sign in to Portal
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 16px 0 0 0; font-size: 13px; line-height: 1.6; color: #737373;">
                If you didn't request this link, you can safely ignore this email.
              </p>

            </td>
          </tr>

          <!-- Footer -->
          ${copyrightFooterHtml()}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

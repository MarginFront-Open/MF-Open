import { getOperatorSettings } from '@/config/operator'
import {
  copyrightFooterHtml,
  escapeHtml,
  safeHttpUrlForHtml,
} from '@/app/lib/email-html'

// -- The welcome email HTML, styled to match MarginFront branding --
// Dark background, emerald accents, clean and simple. The button and the
// signature only appear when this copy knows its own address and its
// operator's name, so the email never points anywhere else.
function welcomeEmailDashboardUrl(): string | null {
  const configured =
    process.env.BETTER_AUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim()
  return configured ? configured.replace(/\/+$/, '') : null
}

export function buildWelcomeEmailHtml(): string {
  const dashboardUrl = welcomeEmailDashboardUrl()
  const safeDashboardUrl =
    safeHttpUrlForHtml(dashboardUrl)?.replace(/\/+$/, '') ?? null
  const { name: operatorName } = getOperatorSettings()
  const signature = operatorName
    ? `<p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Best,<br />
                <span style="color: #10b981; font-weight: 600;">${escapeHtml(operatorName)}</span>
              </p>`
    : ''
  const button = safeDashboardUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
                <tr>
                  <td style="background-color: #10b981; border-radius: 8px;">
                    <a href="${safeDashboardUrl}" target="_blank"
                       style="display: inline-block; padding: 12px 28px; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none;">
                      Go to Your Dashboard
                    </a>
                  </td>
                </tr>
              </table>`
    : ''

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to MarginFront</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px;">

          <tr>
            <td align="center" style="padding-bottom: 32px;">
              <span style="font-size: 24px; font-weight: 700; color: #10b981; letter-spacing: -0.5px;">
                MarginFront
              </span>
            </td>
          </tr>

          <tr>
            <td style="background-color: #141414; border: 1px solid #262626; border-radius: 12px; padding: 40px 32px;">

              <h1 style="margin: 0 0 24px 0; font-size: 22px; font-weight: 700; color: #ffffff; line-height: 1.3;">
                Your workspace is ready
              </h1>

              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Hi,
              </p>
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.7; color: #d4d4d4;">
                Your MarginFront workspace is set up. Send your first usage event from the Getting Started page and it shows up in your dashboard within a minute.
              </p>
              ${signature}

              ${button}

            </td>
          </tr>

          ${copyrightFooterHtml()}

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim()
}

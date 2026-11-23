/**
 * Dashboard Send-Invoice E2E — drives the actual UI Send dialog.
 *
 * Reads a state file at STATE_PATH (shape: E2EState below) that lists four
 * draft invoices, one per surface: REST / SDK / MCP / Dashboard. This spec
 * picks up the "dashboard" entry and walks through the click path customers
 * see: open the invoice detail page, hit the Send button, fill in the dialog,
 * click Send.
 *
 * What this proves: the dashboard Send button + the SendInvoiceDialog +
 * `sendInvoiceEmailAction` server action + api-nest's POST /v1/invoices/{id}/send
 * all still work end-to-end. The dashboard surface uses its OWN code path
 * (the Server Action mirrors the api-nest service rather than calling the
 * REST route), so this spec catches failures on that path that pure
 * API tests would miss.
 *
 * Prereq: create the four draft invoices and write the state file first. The
 * state file is what tells this spec which invoice to send.
 *
 * Skip behavior: if the state file is missing, the test skips with a clear
 * message instead of failing — keeps CI/local from breaking on a fresh checkout
 * where the state file doesn't exist.
 */

import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const STATE_PATH = '/tmp/marginfront-invoice-send-state.json'

interface E2EState {
  env: string
  stamp: number
  customerId: string
  customerName: string
  customerEmail: string
  invoices: {
    rest: { id: string; total: string; sent: boolean }
    sdk: { id: string; total: string; sent: boolean }
    mcp: { id: string; total: string; sent: boolean }
    dashboard: { id: string; total: string; sent: boolean }
  }
}

test('Dashboard send: click Send on the dashboard-candidate invoice and verify the success path', async ({
  page,
}) => {
  test.skip(
    !existsSync(STATE_PATH),
    `Bootstrap state missing at ${STATE_PATH}. Create the four draft invoices and write their IDs there first.`
  )

  const state: E2EState = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
  const invoiceId = state.invoices.dashboard.id
  const expectedEmail = state.customerEmail

  // 1. Open the invoice detail page. Auth state is replayed from
  //    ~/.marginfront-playwright-state.json per playwright.config.ts.
  await page.goto(`/invoices/${invoiceId}`, { waitUntil: 'domcontentloaded' })
  await expect(page).toHaveURL(new RegExp(`/invoices/${invoiceId}`))

  // 2. Click the Send button. For a non-paid non-overdue invoice the
  //    visible label is "Invoice" (with a Mail icon). The dialog title is
  //    "Send invoice" which is what we wait for in the next step to confirm
  //    the click landed.
  await page.getByRole('button', { name: /^Invoice$/ }).click()

  // 3. Send dialog appears. Recipient is pre-filled from the customer's
  //    stored email.
  await expect(page.getByRole('heading', { name: 'Send invoice' })).toBeVisible(
    {
      timeout: 5000,
    }
  )

  // 4. Verify the recipient field has the right email pre-filled. If this
  //    diverges from what the state file says the
  //    customer's email is, something is broken between the customer
  //    record and the dialog.
  const emailInput = page.locator('input#email')
  await expect(emailInput).toHaveValue(expectedEmail, { timeout: 5000 })

  // 5. Click Send. The dialog calls the sendInvoiceEmail Server Action,
  //    which calls api-nest POST /v1/invoices/{id}/send under the hood.
  await page.getByRole('button', { name: /^Send( invoice)?$/ }).click()

  // 6. Wait for success state. The dialog flips to a heading "Invoice sent"
  //    plus a description line. Anchor on the heading specifically: the
  //    description line also contains "sent" so a loose text match would
  //    hit two locators in strict mode. If api-nest 4xx'd, the dialog
  //    surfaces an error message instead and this heading never appears.
  await expect(page.getByRole('heading', { name: 'Invoice sent' })).toBeVisible(
    { timeout: 15_000 }
  )

  // 7. Mark the dashboard send as completed in the state file.
  const updated: E2EState = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
  updated.invoices.dashboard.sent = true
  writeFileSync(STATE_PATH, JSON.stringify(updated, null, 2))
})

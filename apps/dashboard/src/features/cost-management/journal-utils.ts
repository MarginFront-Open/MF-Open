/**
 * Pure (non-server) helpers for turning the by-GL-code journal export into
 * balanced double-entry journal lines.
 *
 * Lives outside the `'use server'` files so both the export route handler and
 * the client panel can import the sync builder. (Next.js forbids non-async
 * exports from 'use server' modules.)
 *
 * Accounting model: accrue the AI cost. Debit the AI expense/COGS accounts
 * (one line per GL code), credit a single offset account for the total. The
 * offset is "Accrued AI Costs", an accrued-liability account, NOT Accounts
 * Payable. Why not AP: there's no provider invoice (see the no-invoice note
 * in csv.ts), so crediting AP would assert a vendor bill that doesn't exist
 * and fail the first reconciliation an auditor runs. An accrual is the right
 * home for "cost we've incurred but haven't been billed for yet"; it reverses
 * when the real provider invoice posts. To change the offset account, edit it
 * here.
 */

import type { JournalExport } from '@/app/actions/journal-export'

/**
 * Default credit/offset account: an accrued-liability account, because the AI
 * cost is incurred-but-not-yet-invoiced (accrual), not a received vendor bill
 * (Accounts Payable). Change it here to post to a different account.
 */
export const OFFSET_ACCOUNT = {
  glCode: '2100', // 2xxx accrued-liability series (label-only constant; not a chart_of_accounts row)
  glName: 'Accrued AI Costs',
} as const

export type JournalLine = {
  glCode: string | null
  account: string
  /** Dollar amount on the debit side. 0 for the credit/offset line. */
  debit: number
  /** Dollar amount on the credit side. 0 for debit lines. */
  credit: number
  memo: string
}

/**
 * Build balanced double-entry lines from the summary export. Returns one
 * debit line per GL-code bucket plus a single credit line to the offset
 * account for the total. Sum(debits) === credit by construction, so the
 * entry balances.
 */
export function buildJournalLines(data: JournalExport): JournalLine[] {
  const period = `${data.periodStart.slice(0, 10)} to ${data.periodEnd.slice(0, 10)}`

  const debits: JournalLine[] = data.rows.map((r) => ({
    glCode: r.glCode,
    account: r.glName,
    debit: r.amount,
    credit: 0,
    memo: `AI usage ${period}: ${r.eventCount} events`,
  }))

  const offset: JournalLine = {
    glCode: OFFSET_ACCOUNT.glCode,
    account: OFFSET_ACCOUNT.glName,
    debit: 0,
    credit: data.totalAmount,
    memo: `Accrued AI vendor costs ${period}, reverses when the provider invoice posts`,
  }

  return [...debits, offset]
}

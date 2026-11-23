import { NextResponse } from 'next/server'
import { db } from '@/app/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Public, unauthenticated health check for uptime monitors.
//
// Security: this endpoint MUST NOT leak any infrastructure detail (database
// host or user, auth URL, which settings are present, user counts). It returns
// ONLY a status word: 200 = DB reachable, 500 = DB connectivity failure.
export async function GET() {
  try {
    // Trivial connectivity probe on the shared singleton client. It deliberately
    // does NOT count rows; it only needs to know the DB answers.
    await db.$queryRaw`SELECT 1`

    return NextResponse.json({ status: 'ok' }, { status: 200 })
  } catch {
    // Leak nothing about why it failed — no message, code, name, or cause.
    return NextResponse.json({ status: 'error' }, { status: 500 })
  }
}

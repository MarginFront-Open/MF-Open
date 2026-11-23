import { auth } from '@/app/lib/auth'
import { toNextJsHandler } from 'better-auth/next-js'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const handler = toNextJsHandler(auth)

// The caller gets a fixed message. The real error (message, stack, file paths)
// stays in the server log, where only the operator can read it.
function internalError(method: 'GET' | 'POST', error: unknown): NextResponse {
  console.error(`[Auth Route] ${method} failed:`, error)
  return NextResponse.json(
    { error: 'Something went wrong while signing in. Please try again.' },
    { status: 500 }
  )
}

export async function GET(request: NextRequest) {
  try {
    return await handler.GET(request)
  } catch (error) {
    return internalError('GET', error)
  }
}

export async function POST(request: NextRequest) {
  try {
    return await handler.POST(request)
  } catch (error) {
    return internalError('POST', error)
  }
}

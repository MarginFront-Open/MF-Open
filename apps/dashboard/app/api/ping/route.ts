import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Liveness only. No env flags, timestamps or other server state: this route
// needs no auth, so anything in the body is public.
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}

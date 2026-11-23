import { redirect } from 'next/navigation'
import { getPostAuthRedirectServer } from '@/app/lib/auth-redirect-server'

export default async function RootPage() {
  // Server-side redirect - runs BEFORE page renders
  // This prevents any flash by redirecting on the server
  const { url } = await getPostAuthRedirectServer()
  redirect(url)
}

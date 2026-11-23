import { redirect } from 'next/navigation'

interface SignUpPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

// /sign-up redirects to /sign-in, which handles both new and existing users.
export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = await searchParams

  // Preserve query params when redirecting to sign-in
  const queryString = new URLSearchParams()

  if (params.redirectTo) {
    queryString.set('redirectTo', String(params.redirectTo))
  }
  if (params.email) {
    queryString.set('email', String(params.email))
  }

  const redirectUrl = queryString.toString()
    ? `/sign-in?${queryString.toString()}`
    : '/sign-in'

  redirect(redirectUrl)
}

'use client'

import { StrictMode, useEffect } from 'react'
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google'
import { AxiosError } from 'axios'
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { authClient } from '@/app/lib/auth-client'
import { clearTokenCache } from '@/lib/api/client'
import { handleServerError } from '@/utils/handle-server-error'
import { toast } from '@/hooks/use-toast'
import { Toaster } from '@/components/ui/toaster'
import { ThemeProvider } from '@/context/theme-context'
import { LayoutProvider } from '@/context/layout-context'
import { initSentry } from '@/config/sentry'
import { initLogger } from '@/config/logger'
import { SentryIdentifier } from '@/components/sentry/SentryIdentifier'
import '@/index.css'

// Variable Inter for the shell (weights 400-700 incl. 450/550, which have
// no static cuts). Exposed as a CSS var only, inert until a subtree opts in
// via .mf-shell (src/index.css); pages outside .mf-shell use Golos/Europa.
const mfShellFont = Inter({ subsets: ['latin'], variable: '--font-mf' })

// Space Grotesk for .mf-shell headings only (index.css scopes
// it to .mf-shell h1-h6); Inter stays for body copy. Same CSS-var opt-in —
// inert outside the shell.
const mfDisplayFont = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-mf-display',
})

// next/font serves the files from this app's own origin, so no browser ever
// calls Google Fonts at runtime. Tailwind's font-mono stack reads the variable.
const codeFont = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-code',
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // eslint-disable-next-line no-console -- development-only retry log
        if (process.env.NODE_ENV === 'development')
          console.log({ failureCount, error })

        if (failureCount >= 0 && process.env.NODE_ENV === 'development')
          return false
        if (failureCount > 3 && process.env.NODE_ENV === 'production')
          return false

        return !(
          error instanceof AxiosError &&
          [401, 403].includes(error.response?.status ?? 0)
        )
      },
      refetchOnWindowFocus: process.env.NODE_ENV === 'production',
      staleTime: 10 * 1000,
    },
    mutations: {
      onError: (error) => {
        handleServerError(error)

        if (error instanceof AxiosError) {
          if (error.response?.status === 304) {
            toast({
              variant: 'destructive',
              title: 'Content not modified!',
            })
          }
        }
      },
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof AxiosError) {
        if (error.response?.status === 401) {
          toast({
            variant: 'destructive',
            title: 'Session expired!',
          })
          clearTokenCache()
          authClient
            .signOut()
            .then(() => {
              window.location.href = '/sign-in'
            })
            .catch(() => {
              window.location.href = '/sign-in'
            })
        }
        if (error.response?.status === 500) {
          toast({
            variant: 'destructive',
            title: 'Internal Server Error!',
          })
        }
      }
    },
  }),
})

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  useEffect(() => {
    initSentry()
    initLogger()
  }, [])

  return (
    <html lang='en' suppressHydrationWarning>
      <head>
        <title>MarginFront</title>
        <meta charSet='UTF-8' />
        <link rel='icon' type='image/png' href='/images/favicon.png' />
        <link rel='apple-touch-icon' href='/images/apple-touch-icon.png' />
        <meta name='viewport' content='width=device-width, initial-scale=1.0' />
        <meta name='robots' content='noindex, nofollow' />
      </head>
      <body
        className={`group/body ${mfShellFont.variable} ${mfDisplayFont.variable} ${codeFont.variable}`}
      >
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <LayoutProvider>
                <SentryIdentifier />
                {children}
                <Toaster />
                {process.env.NODE_ENV === 'development' && (
                  <ReactQueryDevtools buttonPosition='bottom-left' />
                )}
              </LayoutProvider>
            </ThemeProvider>
          </QueryClientProvider>
        </StrictMode>
      </body>
    </html>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type Theme = 'dark' | 'light' | 'system'
type ResolvedTheme = 'dark' | 'light'

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'light',
      setTheme: (theme: Theme) => set({ theme }),
    }),
    {
      name: 'vite-ui-theme',
    }
  )
)

/**
 * useTheme with resolvedTheme (the actual dark/light in effect).
 * Mirrors the next-themes API shape.
 */
export function useTheme() {
  const { theme, setTheme } = useThemeStore()
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light')

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const updateResolvedTheme = () => {
      if (theme === 'system') {
        setResolvedTheme(mediaQuery.matches ? 'dark' : 'light')
      } else {
        setResolvedTheme(theme)
      }
    }

    updateResolvedTheme()
    mediaQuery.addEventListener('change', updateResolvedTheme)

    return () => mediaQuery.removeEventListener('change', updateResolvedTheme)
  }, [theme])

  return { theme, setTheme, resolvedTheme }
}

// Provider component for applying theme to DOM (optional - can be used in layout)
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useThemeStore((state) => state.theme)

  useEffect(() => {
    const root = window.document.documentElement
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const applyTheme = (theme: Theme) => {
      root.classList.remove('light', 'dark')
      const systemTheme = mediaQuery.matches ? 'dark' : 'light'
      const effectiveTheme = theme === 'system' ? systemTheme : theme
      root.classList.add(effectiveTheme)
    }

    const handleChange = () => {
      if (theme === 'system') {
        applyTheme('system')
      }
    }

    applyTheme(theme)
    mediaQuery.addEventListener('change', handleChange)

    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  return <>{children}</>
}

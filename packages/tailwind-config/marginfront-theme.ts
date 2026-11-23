/**
 * MarginFront Tailwind CSS Theme Configuration
 *
 * A white-focused theme with MarginFront's green accents
 * (#0D4A3A deep teal, #D4F060 lime accent).
 *
 * Features:
 * - White/neutral primary palette for clean, modern aesthetics
 * - MarginFront brand green accents for emphasis and CTAs
 * - Inter + Satoshi typography stack
 * - Animation keyframes for common UI transitions
 * - Dark mode support via CSS variables
 * - Custom shadows, spacing, and border radius
 */

import type { Config } from 'tailwindcss'

// ============================================
// COLOR DEFINITIONS
// ============================================

/**
 * MarginFront Brand Colors
 * - Primary: Deep Teal (#0D4A3A / #003024) - Trust, depth, sophistication
 * - Accent: Lime Green (#D4F060 / #A4EA49) - Growth, innovation, vitality
 */
const brandColors = {
  // Deep Teal - Primary brand color
  teal: {
    50: '#E8F5F2',
    100: '#D1EBE5',
    200: '#A3D7CB',
    300: '#75C3B1',
    400: '#47AF97',
    500: '#1E8A73',
    600: '#166B59',
    700: '#0D4A3A', // Primary brand color
    800: '#083026',
    900: '#041813',
    950: '#020C09',
  },
  // Lime Green - Accent/Secondary brand color
  lime: {
    50: '#FAFDE8',
    100: '#F5FBD1',
    200: '#EBF7A3',
    300: '#E1F375',
    400: '#D4F060', // Primary accent - bright lime
    500: '#B8D447',
    600: '#9CB83A',
    700: '#7F9C2D',
    800: '#638020',
    900: '#476413',
    950: '#2B4809',
  },
} as const

// Neutral palette for white-focused design
const neutralColors = {
  white: '#FFFFFF',
  gray: {
    25: '#FCFCFD',
    50: '#F9FAFB',
    100: '#F3F4F6',
    150: '#ECEEF0',
    200: '#E5E7EB',
    300: '#D1D5DB',
    400: '#9CA3AF',
    500: '#6B7280',
    600: '#4B5563',
    700: '#374151',
    800: '#1F2937',
    900: '#111827',
    950: '#030712',
  },
} as const

// ============================================
// ANIMATION KEYFRAMES
// ============================================

const keyframes = {
  // Scale and fade animations
  'scale-in': {
    '0%': { transform: 'scale(0.95)', opacity: '0' },
    '100%': { transform: 'scale(1)', opacity: '1' },
  },
  'scale-out': {
    '0%': { transform: 'scale(1)', opacity: '1' },
    '100%': { transform: 'scale(0.95)', opacity: '0' },
  },
  'scale-in-content': {
    '0%': { transform: 'scale(0.9)', opacity: '0' },
    '100%': { transform: 'scale(1)', opacity: '1' },
  },

  // Fade animations
  'fade-in': {
    '0%': { opacity: '0' },
    '100%': { opacity: '1' },
  },
  'fade-out': {
    '0%': { opacity: '1' },
    '100%': { opacity: '0' },
  },

  // Slide and fade combinations
  'slide-up-fade': {
    '0%': { transform: 'translateY(6px)', opacity: '0' },
    '100%': { transform: 'translateY(0)', opacity: '1' },
  },
  'slide-down-fade': {
    '0%': { transform: 'translateY(-6px)', opacity: '0' },
    '100%': { transform: 'translateY(0)', opacity: '1' },
  },
  'slide-left-fade': {
    '0%': { transform: 'translateX(6px)', opacity: '0' },
    '100%': { transform: 'translateX(0)', opacity: '1' },
  },
  'slide-right-fade': {
    '0%': { transform: 'translateX(-6px)', opacity: '0' },
    '100%': { transform: 'translateX(0)', opacity: '1' },
  },

  // Slide from edge animations (for sheets/drawers)
  'slide-in-from-right': {
    '0%': { transform: 'translateX(100%)' },
    '100%': { transform: 'translateX(0)' },
  },
  'slide-out-to-right': {
    '0%': { transform: 'translateX(0)' },
    '100%': { transform: 'translateX(100%)' },
  },
  'slide-in-from-left': {
    '0%': { transform: 'translateX(-100%)' },
    '100%': { transform: 'translateX(0)' },
  },
  'slide-out-to-left': {
    '0%': { transform: 'translateX(0)' },
    '100%': { transform: 'translateX(-100%)' },
  },
  'slide-in-from-top': {
    '0%': { transform: 'translateY(-100%)' },
    '100%': { transform: 'translateY(0)' },
  },
  'slide-out-to-top': {
    '0%': { transform: 'translateY(0)' },
    '100%': { transform: 'translateY(-100%)' },
  },
  'slide-in-from-bottom': {
    '0%': { transform: 'translateY(100%)' },
    '100%': { transform: 'translateY(0)' },
  },
  'slide-out-to-bottom': {
    '0%': { transform: 'translateY(0)' },
    '100%': { transform: 'translateY(100%)' },
  },

  // Accordion animations
  'accordion-down': {
    '0%': { height: '0', opacity: '0' },
    '100%': { height: 'var(--radix-accordion-content-height)', opacity: '1' },
  },
  'accordion-up': {
    '0%': { height: 'var(--radix-accordion-content-height)', opacity: '1' },
    '100%': { height: '0', opacity: '0' },
  },

  // Collapsible animations
  'collapsible-down': {
    '0%': { height: '0' },
    '100%': { height: 'var(--radix-collapsible-content-height)' },
  },
  'collapsible-up': {
    '0%': { height: 'var(--radix-collapsible-content-height)' },
    '100%': { height: '0' },
  },

  // Modal/Dialog animations
  'dialog-overlay-show': {
    '0%': { opacity: '0' },
    '100%': { opacity: '1' },
  },
  'dialog-overlay-hide': {
    '0%': { opacity: '1' },
    '100%': { opacity: '0' },
  },
  'dialog-content-show': {
    '0%': { transform: 'translate(-50%, -48%) scale(0.96)', opacity: '0' },
    '100%': { transform: 'translate(-50%, -50%) scale(1)', opacity: '1' },
  },
  'dialog-content-hide': {
    '0%': { transform: 'translate(-50%, -50%) scale(1)', opacity: '1' },
    '100%': { transform: 'translate(-50%, -48%) scale(0.96)', opacity: '0' },
  },

  // Tooltip/Popover animations
  'tooltip-down-fade': {
    '0%': { transform: 'translateY(-4px)', opacity: '0' },
    '100%': { transform: 'translateY(0)', opacity: '1' },
  },
  'tooltip-up-fade': {
    '0%': { transform: 'translateY(4px)', opacity: '0' },
    '100%': { transform: 'translateY(0)', opacity: '1' },
  },

  // Loading/Progress animations
  shimmer: {
    '0%': { transform: 'translateX(-100%)' },
    '100%': { transform: 'translateX(100%)' },
  },
  'pulse-soft': {
    '0%, 100%': { opacity: '1' },
    '50%': { opacity: '0.7' },
  },
  'spin-slow': {
    '0%': { transform: 'rotate(0deg)' },
    '100%': { transform: 'rotate(360deg)' },
  },

  // Bounce and elastic animations
  'bounce-subtle': {
    '0%, 100%': { transform: 'translateY(0)' },
    '50%': { transform: 'translateY(-4px)' },
  },
  wiggle: {
    '0%, 100%': { transform: 'rotate(-3deg)' },
    '50%': { transform: 'rotate(3deg)' },
  },

  // Attention-seeking animations
  ping: {
    '75%, 100%': { transform: 'scale(2)', opacity: '0' },
  },
  'ping-slow': {
    '0%': { transform: 'scale(1)', opacity: '0.5' },
    '50%': { transform: 'scale(1.1)', opacity: '0.3' },
    '100%': { transform: 'scale(1)', opacity: '0.5' },
  },

  // Enter/Exit animations for lists
  'enter-from-right': {
    '0%': { transform: 'translateX(200px)', opacity: '0' },
    '100%': { transform: 'translateX(0)', opacity: '1' },
  },
  'enter-from-left': {
    '0%': { transform: 'translateX(-200px)', opacity: '0' },
    '100%': { transform: 'translateX(0)', opacity: '1' },
  },
  'exit-to-right': {
    '0%': { transform: 'translateX(0)', opacity: '1' },
    '100%': { transform: 'translateX(200px)', opacity: '0' },
  },
  'exit-to-left': {
    '0%': { transform: 'translateX(0)', opacity: '1' },
    '100%': { transform: 'translateX(-200px)', opacity: '0' },
  },

  // Background gradient animation
  'gradient-xy': {
    '0%, 100%': { backgroundPosition: '0% 50%' },
    '50%': { backgroundPosition: '100% 50%' },
  },

  // Caret blink for inputs
  'caret-blink': {
    '0%, 70%, 100%': { opacity: '1' },
    '20%, 50%': { opacity: '0' },
  },
} as const

// ============================================
// ANIMATION DEFINITIONS
// ============================================

const animations = {
  // Scale animations
  'scale-in': 'scale-in 0.2s ease-out',
  'scale-out': 'scale-out 0.15s ease-in',
  'scale-in-content': 'scale-in-content 0.2s ease-out',

  // Fade animations
  'fade-in': 'fade-in 0.2s ease-out',
  'fade-out': 'fade-out 0.15s ease-in',

  // Slide and fade animations
  'slide-up-fade': 'slide-up-fade 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  'slide-down-fade': 'slide-down-fade 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  'slide-left-fade': 'slide-left-fade 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  'slide-right-fade': 'slide-right-fade 0.3s cubic-bezier(0.16, 1, 0.3, 1)',

  // Sheet/Drawer animations
  'slide-in-from-right': 'slide-in-from-right 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  'slide-out-to-right': 'slide-out-to-right 0.2s ease-in',
  'slide-in-from-left': 'slide-in-from-left 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  'slide-out-to-left': 'slide-out-to-left 0.2s ease-in',
  'slide-in-from-top': 'slide-in-from-top 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  'slide-out-to-top': 'slide-out-to-top 0.2s ease-in',
  'slide-in-from-bottom': 'slide-in-from-bottom 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
  'slide-out-to-bottom': 'slide-out-to-bottom 0.2s ease-in',

  // Accordion animations
  'accordion-down': 'accordion-down 0.2s ease-out',
  'accordion-up': 'accordion-up 0.2s ease-out',

  // Collapsible animations
  'collapsible-down': 'collapsible-down 0.2s ease-out',
  'collapsible-up': 'collapsible-up 0.2s ease-out',

  // Dialog animations
  'dialog-overlay-show': 'dialog-overlay-show 0.2s ease-out',
  'dialog-overlay-hide': 'dialog-overlay-hide 0.15s ease-in',
  'dialog-content-show': 'dialog-content-show 0.2s ease-out',
  'dialog-content-hide': 'dialog-content-hide 0.15s ease-in',

  // Tooltip animations
  'tooltip-down-fade': 'tooltip-down-fade 0.2s ease-out',
  'tooltip-up-fade': 'tooltip-up-fade 0.2s ease-out',

  // Loading animations
  shimmer: 'shimmer 2s infinite',
  'pulse-soft': 'pulse-soft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
  'spin-slow': 'spin-slow 3s linear infinite',

  // Attention animations
  'bounce-subtle': 'bounce-subtle 2s infinite',
  wiggle: 'wiggle 0.5s ease-in-out',
  ping: 'ping 1s cubic-bezier(0, 0, 0.2, 1) infinite',
  'ping-slow': 'ping-slow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',

  // List animations
  'enter-from-right': 'enter-from-right 0.25s ease-out',
  'enter-from-left': 'enter-from-left 0.25s ease-out',
  'exit-to-right': 'exit-to-right 0.25s ease-in',
  'exit-to-left': 'exit-to-left 0.25s ease-in',

  // Background animation
  'gradient-xy': 'gradient-xy 10s ease infinite',

  // Caret
  'caret-blink': 'caret-blink 1.25s ease-out infinite',
} as const

// ============================================
// SHADOW DEFINITIONS
// ============================================

const shadows = {
  // Soft shadows (white-focused design)
  'soft-xs': '0 1px 2px 0 rgb(0 0 0 / 0.03)',
  'soft-sm': '0 1px 3px 0 rgb(0 0 0 / 0.04), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
  'soft-md': '0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
  'soft-lg': '0 10px 15px -3px rgb(0 0 0 / 0.05), 0 4px 6px -4px rgb(0 0 0 / 0.05)',
  'soft-xl': '0 20px 25px -5px rgb(0 0 0 / 0.05), 0 8px 10px -6px rgb(0 0 0 / 0.05)',
  'soft-2xl': '0 25px 50px -12px rgb(0 0 0 / 0.1)',

  // Card shadows (elevated surfaces)
  'card-sm': '0 1px 3px 0 rgb(0 0 0 / 0.04), 0 1px 2px 0 rgb(0 0 0 / 0.02)',
  'card-md': '0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -1px rgb(0 0 0 / 0.03)',
  'card-lg': '0 10px 15px -3px rgb(0 0 0 / 0.06), 0 4px 6px -2px rgb(0 0 0 / 0.03)',
  'card-hover': '0 10px 40px -10px rgb(0 0 0 / 0.08), 0 4px 6px -2px rgb(0 0 0 / 0.02)',

  // Brand shadows (with green tint)
  'brand-sm': `0 4px 6px -1px ${brandColors.teal[700]}15, 0 2px 4px -1px ${brandColors.teal[700]}10`,
  'brand-md': `0 10px 15px -3px ${brandColors.teal[700]}12, 0 4px 6px -2px ${brandColors.teal[700]}08`,
  'brand-lg': `0 20px 25px -5px ${brandColors.teal[700]}10, 0 10px 10px -5px ${brandColors.teal[700]}06`,

  // Accent shadows (lime glow)
  'accent-sm': `0 4px 6px -1px ${brandColors.lime[400]}20, 0 2px 4px -1px ${brandColors.lime[400]}15`,
  'accent-md': `0 10px 15px -3px ${brandColors.lime[400]}18, 0 4px 6px -2px ${brandColors.lime[400]}12`,
  'accent-glow': `0 0 20px ${brandColors.lime[400]}40`,

  // Inner shadows
  'inner-sm': 'inset 0 1px 2px 0 rgb(0 0 0 / 0.03)',
  'inner-md': 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',

  // Button shadows
  'button': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  'button-hover': '0 4px 6px -1px rgb(0 0 0 / 0.06), 0 2px 4px -1px rgb(0 0 0 / 0.04)',

  // None
  'none': 'none',
} as const

// ============================================
// BORDER RADIUS SCALE
// ============================================

const borderRadius = {
  'none': '0',
  'xs': '0.125rem',     // 2px
  'sm': '0.25rem',      // 4px
  'DEFAULT': '0.375rem', // 6px
  'md': '0.5rem',       // 8px
  'lg': '0.625rem',     // 10px
  'xl': '0.75rem',      // 12px
  '2xl': '1rem',        // 16px
  '3xl': '1.5rem',      // 24px
  'full': '9999px',
} as const

// ============================================
// SPACING ADJUSTMENTS
// ============================================

const spacing = {
  // Extra small increments
  '0.5': '0.125rem',    // 2px
  '1.5': '0.375rem',    // 6px
  '2.5': '0.625rem',    // 10px
  '3.5': '0.875rem',    // 14px

  // Additional useful sizes
  '4.5': '1.125rem',    // 18px
  '5.5': '1.375rem',    // 22px
  '6.5': '1.625rem',    // 26px
  '7.5': '1.875rem',    // 30px
  '8.5': '2.125rem',    // 34px
  '9.5': '2.375rem',    // 38px

  // Layout sizes
  '13': '3.25rem',      // 52px
  '15': '3.75rem',      // 60px
  '17': '4.25rem',      // 68px
  '18': '4.5rem',       // 72px
  '22': '5.5rem',       // 88px
  '26': '6.5rem',       // 104px
  '30': '7.5rem',       // 120px

  // Content widths
  '100': '25rem',       // 400px
  '104': '26rem',       // 416px
  '108': '27rem',       // 432px
  '112': '28rem',       // 448px
  '116': '29rem',       // 464px
  '120': '30rem',       // 480px
  '128': '32rem',       // 512px
  '144': '36rem',       // 576px
  '160': '40rem',       // 640px
} as const

// ============================================
// THEME CONFIGURATION EXPORT
// ============================================

export const marginfrontTheme = {
  darkMode: 'class' as const,

  theme: {
    extend: {
      // ========================================
      // COLORS
      // ========================================
      colors: {
        // Brand colors
        brand: brandColors,

        // Neutral palette
        neutral: neutralColors.gray,
        white: neutralColors.white,

        // Semantic colors (CSS variable based for theme switching)
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',

        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',

        // Sidebar colors
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },

        // Chart colors
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
      },

      // ========================================
      // TYPOGRAPHY
      // ========================================
      fontFamily: {
        // Primary fonts
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'Noto Sans',
          'sans-serif',
        ],
        heading: [
          'Satoshi',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        display: [
          'Satoshi',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'Fira Code',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'monospace',
        ],
      },

      fontSize: {
        // Extra small
        '2xs': ['0.625rem', { lineHeight: '1rem' }],        // 10px

        // Display sizes
        'display-2xl': ['4.5rem', { lineHeight: '1', letterSpacing: '-0.02em' }],     // 72px
        'display-xl': ['3.75rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],   // 60px
        'display-lg': ['3rem', { lineHeight: '1.1', letterSpacing: '-0.02em' }],      // 48px
        'display-md': ['2.25rem', { lineHeight: '1.15', letterSpacing: '-0.02em' }],  // 36px
        'display-sm': ['1.875rem', { lineHeight: '1.2', letterSpacing: '-0.01em' }],  // 30px
        'display-xs': ['1.5rem', { lineHeight: '1.25', letterSpacing: '-0.01em' }],   // 24px

        // Body sizes
        'body-xl': ['1.25rem', { lineHeight: '1.75' }],     // 20px
        'body-lg': ['1.125rem', { lineHeight: '1.75' }],    // 18px
        'body-md': ['1rem', { lineHeight: '1.5' }],         // 16px
        'body-sm': ['0.875rem', { lineHeight: '1.5' }],     // 14px
        'body-xs': ['0.75rem', { lineHeight: '1.5' }],      // 12px
      },

      letterSpacing: {
        tightest: '-0.04em',
        tighter: '-0.02em',
        tight: '-0.01em',
        normal: '0',
        wide: '0.01em',
        wider: '0.02em',
        widest: '0.04em',
      },

      lineHeight: {
        none: '1',
        tight: '1.1',
        snug: '1.25',
        normal: '1.5',
        relaxed: '1.625',
        loose: '1.75',
        'extra-loose': '2',
      },

      // ========================================
      // SPACING & SIZING
      // ========================================
      spacing,
      borderRadius,

      // ========================================
      // SHADOWS
      // ========================================
      boxShadow: shadows,

      // ========================================
      // ANIMATIONS
      // ========================================
      keyframes,
      animation: animations,

      // ========================================
      // TRANSITIONS
      // ========================================
      transitionDuration: {
        '0': '0ms',
        '50': '50ms',
        '100': '100ms',
        '150': '150ms',
        '200': '200ms',
        '250': '250ms',
        '300': '300ms',
        '400': '400ms',
        '500': '500ms',
        '700': '700ms',
        '1000': '1000ms',
      },

      transitionTimingFunction: {
        'ease-in-out-expo': 'cubic-bezier(0.87, 0, 0.13, 1)',
        'ease-out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'ease-in-expo': 'cubic-bezier(0.7, 0, 0.84, 0)',
        'ease-out-back': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'ease-in-back': 'cubic-bezier(0.36, 0, 0.66, -0.56)',
        'bounce': 'cubic-bezier(0.68, -0.6, 0.32, 1.6)',
      },

      // ========================================
      // Z-INDEX SCALE
      // ========================================
      zIndex: {
        '60': '60',
        '70': '70',
        '80': '80',
        '90': '90',
        '100': '100',
        'dropdown': '1000',
        'sticky': '1100',
        'fixed': '1200',
        'modal-backdrop': '1300',
        'modal': '1400',
        'popover': '1500',
        'tooltip': '1600',
        'toast': '1700',
        'max': '9999',
      },

      // ========================================
      // BACKDROP BLUR
      // ========================================
      backdropBlur: {
        xs: '2px',
        sm: '4px',
        DEFAULT: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
        '2xl': '40px',
        '3xl': '64px',
      },

      // ========================================
      // MAX WIDTH
      // ========================================
      maxWidth: {
        '8xl': '88rem',   // 1408px
        '9xl': '96rem',   // 1536px
        'content': '65ch', // Optimal reading width
      },

      // ========================================
      // ASPECT RATIOS
      // ========================================
      aspectRatio: {
        'auto': 'auto',
        'square': '1 / 1',
        'video': '16 / 9',
        'photo': '4 / 3',
        'portrait': '3 / 4',
        'wide': '21 / 9',
      },

      // ========================================
      // CONTAINER
      // ========================================
      container: {
        center: true,
        padding: {
          DEFAULT: '1rem',
          sm: '1.5rem',
          lg: '2rem',
          xl: '2.5rem',
          '2xl': '3rem',
        },
        screens: {
          sm: '640px',
          md: '768px',
          lg: '1024px',
          xl: '1280px',
          '2xl': '1400px',
        },
      },

      // ========================================
      // SCREENS (Breakpoints)
      // ========================================
      screens: {
        'xs': '475px',
        '3xl': '1800px',
      },
    },
  },
} satisfies Partial<Config>

// ============================================
// PLUGIN RECOMMENDATIONS
// ============================================

/**
 * Recommended plugins for use with this theme:
 *
 * - @tailwindcss/forms - Better form element styling
 * - @tailwindcss/typography - Prose styling for content
 * - @tailwindcss/container-queries - Container query support
 * - tailwindcss-animate - Animation utilities
 *
 * Example usage in tailwind.config.ts:
 *
 * ```typescript
 * import { marginfrontTheme } from '@marginfront/tailwind-config/marginfront-theme'
 * import forms from '@tailwindcss/forms'
 * import typography from '@tailwindcss/typography'
 * import animate from 'tailwindcss-animate'
 *
 * export default {
 *   ...marginfrontTheme,
 *   plugins: [forms, typography, animate],
 * }
 * ```
 */

export default marginfrontTheme

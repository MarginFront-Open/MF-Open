import containerQueries from '@tailwindcss/container-queries'
import forms from '@tailwindcss/forms'
import tailwindCssAnimate from 'tailwindcss-animate'
import defaultTheme from 'tailwindcss/defaultTheme'
import { fonts } from './src/config/fonts.js'

// Use destructuring with fallback to ensure fontFamily is defined
const { fontFamily = { sans: ['sans-serif'] } } = defaultTheme || {}

/** @type {import('tailwindcss').Config} */
const tailwindConfig = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  safelist: fonts.map((font) => `font-${font}`),
  theme: {
    container: {
      center: 'true',
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      /* ============================================
         BRAND TYPOGRAPHY SYSTEM
         ============================================
         Font roles:
         - Europa Grotesk: H1-H3, Feature titles, Marketing sections
         - Golos Text: Body text, H4-H6, UI labels, forms, buttons
         ============================================ */
      fontFamily: {
        // Heading font: Europa Grotesk - Bold, impactful headings
        // Used for: H1-H3, Feature titles, Marketing sections, Bold statements
        heading: [
          '"Golos Text"', // Fallback
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],

        // Body font: Golos Text - Readable body text
        // Used for: Body text, H4-H6, UI labels, forms, buttons, descriptions
        sans: [
          '"Golos Text"',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],

        // Alias for Golos Text (explicit usage)
        golos: [
          '"Golos Text"',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif',
        ],

        // Alias for Europa Grotesk (explicit usage)
        europa: ['"Golos Text"', '-apple-system', 'sans-serif'],

        // Monospace font for code
        mono: [
          'var(--font-code)',
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],

        // Extra font families
        inter: ['Inter', ...fontFamily.sans],
        manrope: ['Manrope', ...fontFamily.sans],
      },

      /* ============================================
         BRAND TYPOGRAPHY SCALE
         ============================================
         Headings use Europa Grotesk, Body uses Golos Text
         ============================================ */
      fontSize: {
        // Display sizes (Hero/Marketing)
        display: [
          '3.125rem',
          { lineHeight: '1.1', letterSpacing: '-0.01em', fontWeight: '700' },
        ], // 50px
        'display-sm': [
          '2.625rem',
          { lineHeight: '1.15', letterSpacing: '-0.01em', fontWeight: '700' },
        ], // 42px

        // Headings (Europa Grotesk)
        // H1: 40-50px Web, Bold 700, Line Height 110%
        h1: [
          '2.75rem',
          { lineHeight: '1.1', letterSpacing: '-0.01em', fontWeight: '700' },
        ], // 44px
        // H2: 36-42px Web, Bold 700, Line Height 115%
        h2: [
          '2.375rem',
          { lineHeight: '1.15', letterSpacing: '-0.01em', fontWeight: '700' },
        ], // 38px
        // H3: 28-32px Web, Medium 500, Line Height 120%
        h3: [
          '1.875rem',
          { lineHeight: '1.2', letterSpacing: '-0.01em', fontWeight: '500' },
        ], // 30px

        // Subheadings (Golos Text)
        // H4: 22-26px Web, Medium 500, Line Height 130%
        h4: [
          '1.5rem',
          { lineHeight: '1.3', letterSpacing: '0', fontWeight: '500' },
        ], // 24px
        // H5: 18-20px Web, Regular/Medium 400-500, Line Height 130%
        h5: [
          '1.1875rem',
          { lineHeight: '1.3', letterSpacing: '0', fontWeight: '500' },
        ], // 19px
        // H6: 16-18px Web, Regular 400, Line Height 135%
        h6: [
          '1.0625rem',
          { lineHeight: '1.35', letterSpacing: '0', fontWeight: '400' },
        ], // 17px

        // Body Text (Golos Text)
        // Body Large: 18px Web, Regular 400, Line Height 150%
        'body-lg': [
          '1.125rem',
          { lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' },
        ], // 18px
        // Body Default: 16px Web, Regular 400, Line Height 150%
        body: [
          '1rem',
          { lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' },
        ], // 16px
        // Body Small: 14px Web, Light/Regular 300-400, Line Height 150%
        'body-sm': [
          '0.875rem',
          { lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' },
        ], // 14px
        // Caption: 12px Web, Light 300, Line Height 140%
        caption: [
          '0.75rem',
          { lineHeight: '1.4', letterSpacing: '0', fontWeight: '300' },
        ], // 12px

        // Button sizes (Golos Text)
        // Primary Button: 16px, Medium 500
        btn: [
          '1rem',
          { lineHeight: '1.5', letterSpacing: '0.01em', fontWeight: '500' },
        ], // 16px
        // Secondary Button: 14-16px, Regular 400
        'btn-sm': [
          '0.875rem',
          { lineHeight: '1.5', letterSpacing: '0.01em', fontWeight: '400' },
        ], // 14px
      },

      /* ============================================
         BRAND LINE HEIGHTS
         ============================================ */
      lineHeight: {
        'heading-tight': '1.1', // Headings: 110%
        heading: '1.15', // Headings: 115%
        'heading-relaxed': '1.2', // H3: 120%
        subheading: '1.3', // H4-H5: 130%
        body: '1.5', // Body text: 150%
        caption: '1.4', // Captions: 140%
      },

      /* ============================================
         BRAND LETTER SPACING
         ============================================ */
      letterSpacing: {
        heading: '-0.01em', // Headings: 0 to -1%
        body: '0', // Body text: 0 to +1%
        button: '0.01em', // Buttons: +1% for clarity
        tight: '-0.01em',
        normal: '0',
        wide: '0.01em',
        wider: '0.02em',
      },

      /* ============================================
         BRAND FONT WEIGHTS
         ============================================ */
      fontWeight: {
        light: '300', // Golos: Subtle captions, metadata
        regular: '400', // Golos: Body text, forms
        medium: '500', // Both: H3, H4-H6, UI sections, buttons
        semibold: '600', // Emphasis
        bold: '700', // Europa: H1, H2
      },

      /* ============================================
         BRAND SPACING SYSTEM
         ============================================ */
      spacing: {
        // Paragraph spacing
        'para-sm': '1rem', // 16px - Paragraph after paragraph
        para: '1.25rem', // 20px
        'para-lg': '1.5rem', // 24px - Paragraph after paragraph (max)
        'heading-after': '1.5rem', // 24px - Paragraph after headings (min)
        'heading-after-lg': '2rem', // 32px - Paragraph after headings (max)

        // UI spacing
        'label-input': '0.375rem', // 6px - Label to input (min)
        'label-input-lg': '0.5rem', // 8px - Label to input (max)
        'input-helper': '0.25rem', // 4px - Input to helper text (min)
        'input-helper-lg': '0.375rem', // 6px - Input to helper text (max)
        'card-title': '0.75rem', // 12px - Card title to content (min)
        'card-title-lg': '1rem', // 16px - Card title to content (max)
      },

      /* ============================================
         BRAND COLORS
         ============================================ */
      colors: {
        // Brand colors
        brand: {
          // Primary: Deep Teal (#003024) - Trust, depth, sophistication
          primary: {
            DEFAULT: '#003024',
            foreground: '#ffffff',
            // Opacity variants for text
            80: 'rgba(0, 48, 36, 0.8)', // Body text
            60: 'rgba(0, 48, 36, 0.6)', // Secondary info, descriptions
          },
          // Secondary/Accent: Lime Green (#A4EA49) - Growth, innovation, vitality
          lime: {
            DEFAULT: '#A4EA49',
            foreground: '#003024',
          },
          // Text colors
          text: {
            primary: '#003024', // Deep Teal - Main headings
            body: 'rgba(0, 48, 36, 0.8)', // Deep Teal 80% - Default body
            secondary: 'rgba(0, 48, 36, 0.6)', // Deep Teal 60% - Descriptions
            accent: '#A4EA49', // Lime Green - Keywords, highlights
          },
        },
        // System colors (HSL-based for shadcn compatibility)
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
          dark: 'hsl(var(--secondary-dark))', // Darker green for text on light backgrounds
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
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
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
        // Theme Color System
        'theme-primary': {
          50: 'hsl(var(--theme-primary-50))',
          100: 'hsl(var(--theme-primary-100))',
          200: 'hsl(var(--theme-primary-200))',
          300: 'hsl(var(--theme-primary-300))',
          400: 'hsl(var(--theme-primary-400))',
          500: 'hsl(var(--theme-primary-500))',
          600: 'hsl(var(--theme-primary-600))',
          700: 'hsl(var(--theme-primary-700))',
          DEFAULT: 'hsl(var(--theme-primary-500))',
          foreground: 'hsl(var(--theme-primary-foreground))',
        },
        'theme-accent': {
          50: 'hsl(var(--theme-accent-50))',
          100: 'hsl(var(--theme-accent-100))',
          200: 'hsl(var(--theme-accent-200))',
          300: 'hsl(var(--theme-accent-300))',
          400: 'hsl(var(--theme-accent-400))',
          500: 'hsl(var(--theme-accent-500))',
          600: 'hsl(var(--theme-accent-600))',
          700: 'hsl(var(--theme-accent-700))',
          DEFAULT: 'hsl(var(--theme-accent-400))',
          foreground: 'hsl(var(--theme-accent-foreground))',
        },
        'theme-neutral': {
          50: 'hsl(var(--theme-neutral-50))',
          100: 'hsl(var(--theme-neutral-100))',
          200: 'hsl(var(--theme-neutral-200))',
          300: 'hsl(var(--theme-neutral-300))',
          400: 'hsl(var(--theme-neutral-400))',
          500: 'hsl(var(--theme-neutral-500))',
          DEFAULT: 'hsl(var(--theme-neutral-200))',
          foreground: 'hsl(var(--theme-neutral-foreground))',
        },
        ai: {
          primary: 'hsl(var(--ai-primary))',
          glow: 'hsl(var(--ai-glow) / 0.3)',
          surface: 'hsl(var(--ai-surface))',
        },
        // `mf` shell tokens (src/index.css). Direct var()
        // on purpose — these values embed their own alpha; do NOT route
        // through the hsl(var(--x)) convention of the tokens above.
        mf: {
          bg: 'var(--mf-bg)',
          sidebar: 'var(--mf-sidebar)',
          card: 'var(--mf-card)',
          card2: 'var(--mf-card2)',
          bd: 'var(--mf-bd)',
          bd2: 'var(--mf-bd2)',
          tx: 'var(--mf-tx)',
          tx2: 'var(--mf-tx2)',
          tx3: 'var(--mf-tx3)',
          accent: 'var(--mf-accent)',
          accent2: 'var(--mf-accent2)',
          green: 'var(--mf-green)',
          amber: 'var(--mf-amber)',
          red: 'var(--mf-red)',
          barbg: 'var(--mf-barbg)',
        },
      },

      /* ============================================
         BORDER RADIUS
         ============================================ */
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        // `mf` shell radii
        'mf-card': 'var(--mf-radius-card)',
        'mf-inner': 'var(--mf-radius-inner)',
        'mf-seg': 'var(--mf-radius-seg)',
        'mf-seg-item': 'var(--mf-radius-seg-item)',
      },

      /* ============================================
         ANIMATIONS & KEYFRAMES
         ============================================ */
      keyframes: {
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'slide-up-fade': {
          '0%': {
            opacity: '0',
            transform: 'translateY(var(--offset, 10px))',
          },
          '100%': {
            opacity: '1',
            transform: 'translateY(0)',
          },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        // Slide down fade (for dropdowns/modals)
        'slide-down-fade': {
          '0%': {
            opacity: '0',
            transform: 'translateY(calc(-1 * var(--offset, 10px)))',
          },
          '100%': {
            opacity: '1',
            transform: 'translateY(0)',
          },
        },
        // Scale up fade (for buttons/cards)
        'scale-up-fade': {
          '0%': {
            opacity: '0',
            transform: 'scale(0.95)',
          },
          '100%': {
            opacity: '1',
            transform: 'scale(1)',
          },
        },
        // Pulse glow (for active states)
        'pulse-glow': {
          '0%, 100%': {
            boxShadow: '0 0 0 0 rgba(16, 185, 129, 0.4)',
          },
          '50%': {
            boxShadow: '0 0 0 8px rgba(16, 185, 129, 0)',
          },
        },
        // Spin slow (for loading states)
        'spin-slow': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s infinite',
        'slide-up-fade': 'slide-up-fade 0.5s ease-out forwards',
        'fade-in': 'fade-in 0.3s ease-out forwards',
        'slide-down-fade': 'slide-down-fade 0.3s ease-out forwards',
        'scale-up-fade': 'scale-up-fade 0.3s ease-out forwards',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'spin-slow': 'spin-slow 3s linear infinite',
      },

      /* ============================================
         BOX SHADOWS
         ============================================ */
      boxShadow: {
        'brand-primary':
          '0 4px 6px -1px hsl(var(--primary) / 0.1), 0 2px 4px -1px hsl(var(--primary) / 0.06)',
        'brand-secondary':
          '0 4px 6px -1px hsl(var(--secondary) / 0.15), 0 2px 4px -1px hsl(var(--secondary) / 0.1)',
        'brand-lg':
          '0 10px 15px -3px hsl(var(--primary) / 0.1), 0 4px 6px -2px hsl(var(--primary) / 0.05)',
        'brand-xl':
          '0 20px 25px -5px hsl(var(--primary) / 0.1), 0 10px 10px -5px hsl(var(--primary) / 0.04)',
      },
    },
  },
  plugins: [tailwindCssAnimate, forms, containerQueries],
}

export default tailwindConfig

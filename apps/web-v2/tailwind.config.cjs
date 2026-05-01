const animate = require('tailwindcss-animate')

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class', '.m-dark'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Tokens are the source of truth in src/styles/tokens.css. Tailwind
      // reads them through CSS custom properties so a token change
      // anywhere in the design system propagates without touching code.
      colors: {
        bg: 'var(--m-bg)',
        sand: 'var(--m-sand)',
        'sand-2': 'var(--m-sand-2)',
        card: 'var(--m-card)',
        'card-soft': 'var(--m-card-soft)',
        line: 'var(--m-line)',
        'line-2': 'var(--m-line-2)',
        ink: 'var(--m-ink)',
        'ink-2': 'var(--m-ink-2)',
        'ink-3': 'var(--m-ink-3)',
        'ink-4': 'var(--m-ink-4)',
        accent: 'var(--m-accent)',
        'accent-ink': 'var(--m-accent-ink)',
        'accent-soft': 'var(--m-accent-soft)',
        'accent-soft-2': 'var(--m-accent-soft-2)',
        good: 'var(--m-green)',
        'good-soft': 'var(--m-green-soft)',
        bad: 'var(--m-red)',
        'bad-soft': 'var(--m-red-soft)',
        warn: 'var(--m-amber)',
        'warn-soft': 'var(--m-amber-soft)',
        info: 'var(--m-blue)',
        'info-soft': 'var(--m-blue-soft)',
      },
      borderRadius: {
        sm: 'var(--m-r-sm)',
        DEFAULT: 'var(--m-r)',
        lg: 'var(--m-r-lg)',
        xl: 'var(--m-r-xl)',
      },
      boxShadow: {
        1: 'var(--m-shadow-1)',
        2: 'var(--m-shadow-2)',
        card: 'var(--m-shadow-card)',
      },
      fontFamily: {
        sans: ['Geist', '-apple-system', 'SF Pro Text', 'system-ui', 'sans-serif'],
        display: ['Geist', '-apple-system', 'SF Pro Display', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SF Mono', 'JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [animate],
}

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// ── Legacy-kit ban (permanent) ─────────────────────────────────────────────
// components/mobile (the wave-2 kit) was retired and DELETED on 2026-06-13
// (campaign: ~/notes/sitelayer-legacy-kit-retirement-campaign-2026-06-13.md,
// waves R0–R6). This rule is the permanent guard: never reintroduce the kit
// or imports of it. UI primitives live in components/m / styles/m.css.
const LEGACY_KIT_ALLOWLIST = []

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/node_modules.old/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'storage/**',
      '.vite/**',
      '**/.vite-cache/**',
      '.turbo/**',
      'docs/steve-handoff/**',
      // Git worktrees (agent isolation) are full repo checkouts with their own
      // tsconfig. Linting them is redundant, AND their nested tsconfig makes
      // typescript-eslint's parser report "multiple candidate TSConfigRootDirs"
      // and fail every file. Ignore them; tsconfigRootDir below pins the root so
      // main-tree files are unaffected when a worktree is present.
      '**/.claude/**',
    ],
  },
  {
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['*.config.{js,cjs,mjs,ts}', 'scripts/**/*.{js,mjs}', 'e2e/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/components/mobile/**', ...LEGACY_KIT_ALLOWLIST],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/components/mobile',
                '@/components/mobile/**',
                '**/components/mobile',
                '**/components/mobile/**',
              ],
              message:
                'components/mobile was deleted 2026-06-13 — use components/m (see ~/notes/sitelayer-legacy-kit-retirement-campaign-2026-06-13.md).',
            },
          ],
        },
      ],
    },
  },
)

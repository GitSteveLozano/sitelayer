import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

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
    files: ['*.config.{js,cjs,mjs,ts}', 'scripts/**/*.{js,mjs}'],
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
)

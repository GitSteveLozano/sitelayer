import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// ── Legacy-kit retirement ratchet ──────────────────────────────────────────
// components/mobile (the wave-2 kit) is being retired in favor of
// components/m. Campaign + wave plan:
// ~/notes/sitelayer-legacy-kit-retirement-campaign-2026-06-13.md
// The allowlist below is the burn-down: it only shrinks. Porting a screen =
// swap its primitives to components/m AND delete its entry here. NO new
// imports of components/mobile anywhere.
const LEGACY_KIT_ALLOWLIST = [
  'apps/web/src/components/ai/RejectSheet.tsx',
  'apps/web/src/components/closeout/banner.tsx',
  'apps/web/src/components/lifecycle/banner.tsx',
  'apps/web/src/components/time-review/index.tsx',
  'apps/web/src/screens/desktop/est-canvas/agent-suggestions-panel.tsx',
  'apps/web/src/screens/financial/billing-run-detail.tsx',
  'apps/web/src/screens/financial/billing-run-list.tsx',
  'apps/web/src/screens/financial/estimate-push-detail.tsx',
  'apps/web/src/screens/financial/estimate-push-list.tsx',
  'apps/web/src/screens/financial/generate-payroll-export-sheet.tsx',
  'apps/web/src/screens/financial/hub.tsx',
  'apps/web/src/screens/financial/labor-payroll-run-create.tsx',
  'apps/web/src/screens/financial/labor-payroll-run-detail.tsx',
  'apps/web/src/screens/financial/labor-payroll-run-list.tsx',
  'apps/web/src/screens/financial/payroll-export-detail.tsx',
  'apps/web/src/screens/financial/payroll-export-list.tsx',
  'apps/web/src/screens/foreman/live-crew.tsx',
  'apps/web/src/screens/integrations/qbo-connection.tsx',
  'apps/web/src/screens/integrations/qbo-custom-fields.tsx',
  'apps/web/src/screens/integrations/qbo-mappings.tsx',
  'apps/web/src/screens/inventory-admin/branches.tsx',
  'apps/web/src/screens/inventory-admin/damage-charges.tsx',
  'apps/web/src/screens/inventory-admin/hub.tsx',
  'apps/web/src/screens/inventory-admin/items.tsx',
  'apps/web/src/screens/inventory-admin/locations.tsx',
  'apps/web/src/screens/inventory-admin/movements.tsx',
  'apps/web/src/screens/inventory-admin/rental-contract.tsx',
  'apps/web/src/screens/inventory-admin/scaffold-catalog.tsx',
  'apps/web/src/screens/mobile/schedule.tsx',
  'apps/web/src/screens/mobile/worker-today.tsx',
  'apps/web/src/screens/owner/bid-accuracy.tsx',
  'apps/web/src/screens/projects/bid-accuracy-card.tsx',
  'apps/web/src/screens/projects/estimate-builder.tsx',
  'apps/web/src/screens/projects/estimate-line-assembly.tsx',
  'apps/web/src/screens/projects/estimate-share-sheet.tsx',
  'apps/web/src/screens/projects/estimate-staleness-banner.tsx',
  'apps/web/src/screens/projects/photo-measure.tsx',
  'apps/web/src/screens/projects/setup.tsx',
  'apps/web/src/screens/projects/shipment-detail.tsx',
  'apps/web/src/screens/projects/takeoff-detail.tsx',
  'apps/web/src/screens/projects/takeoff-list.tsx',
  'apps/web/src/screens/projects/takeoff-summary.tsx',
  'apps/web/src/screens/projects/takeoff-tag-sheet.tsx',
  'apps/web/src/screens/rentals/barcode-scanner.tsx',
  'apps/web/src/screens/rentals/detail.tsx',
  'apps/web/src/screens/rentals/rental-requests-queue.tsx',
  'apps/web/src/screens/rentals/rental-return-sheet.tsx',
  'apps/web/src/screens/rentals/rental-transfer-sheet.tsx',
  'apps/web/src/screens/scaffold/project-boms.tsx',
  'apps/web/src/screens/scaffold/scaffold-designer.tsx',
  'apps/web/src/screens/worker/photo-log.tsx',
]

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
                'components/mobile is retired — use components/m. Porting this file? Also remove it from LEGACY_KIT_ALLOWLIST in eslint.config.mjs (see ~/notes/sitelayer-legacy-kit-retirement-campaign-2026-06-13.md).',
            },
          ],
        },
      ],
    },
  },
)

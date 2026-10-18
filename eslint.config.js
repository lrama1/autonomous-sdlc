import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.terraform/**',
      'spikes/**',
      'designs/**',
      'demo/**',
      'test-results/**',
      'playwright-report/**',
      '.dev-data/**',
      'packages/db/migrations/**',
      // A stand-in engine for tests, plain Node script.
      'apps/runner/src/testing/**',
      'apps/runner/build.mjs',
      'apps/runner/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);

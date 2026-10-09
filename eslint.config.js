import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'data/**', 'coverage/**', 'ui/dist/**', 'site/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['scripts/**', 'src/main.ts', 'src/startup-log.ts', 'src/vault/main.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Vendored shadcn/ui components: kept as the CLI writes them, so a re-add diffs cleanly.
    files: ['ui/src/components/ui/**'],
    rules: { 'react-hooks/purity': 'off', 'max-lines': 'off' },
  },
);

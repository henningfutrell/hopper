import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'data/**', 'coverage/**', 'src/ui/**/*.js'] },
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
    files: ['scripts/**', 'src/main.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/ui/**/*.js'],
    languageOptions: { globals: { document: 'readonly', window: 'readonly', EventSource: 'readonly', fetch: 'readonly' } },
  },
);

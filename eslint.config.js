// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['app/**/*.js'],
    languageOptions: { globals: Object.fromEntries([
      'AbortController', 'Blob', 'ClipboardItem', 'document', 'getComputedStyle', 'Image', 'innerWidth',
      'matchMedia', 'navigator', 'ResizeObserver', 'setInterval', 'clearInterval', 'setTimeout', 'URL', 'XMLSerializer',
    ].map(name => [name, 'readonly'])) },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);

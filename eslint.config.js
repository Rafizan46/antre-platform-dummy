import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['**/dist/', '**/coverage/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // Skrip Node di scripts/ (ESM biasa): global bawaan Node 22.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        WebSocket: 'readonly',
        Buffer: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
]);

// ESLint v9 flat config untuk apps/api.
// Dibutuhkan karena skrip `lint` menjalankan eslint pada src/**, dan ESLint v9
// tidak lagi membaca .eslintrc.* — wajib ada eslint.config.(js|mjs).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Abaikan hasil build dan Prisma client yang di-generate.
  { ignores: ['dist/**', 'node_modules/**', 'src/generated/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        // Decorator dipakai NestJS; projectService tidak wajib untuk lint biasa.
        ecmaVersion: 2023,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      // `any` dipakai terbatas pada batas integrasi pihak ketiga.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Parameter yang tidak dipakai umum pada method hook NestJS (onModuleInit).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);

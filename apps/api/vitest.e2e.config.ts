import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Konfigurasi test e2e: memanggil layanan eksternal sungguhan (Resend) dan
 * tidak memakai PostgreSQL, jadi globalSetup/setup env tidak dipasang.
 * File e2e memuat sendiri .env root repo dan melewati suite bila
 * `RESEND_E2E=1` tidak di-set.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2023',
      },
      module: { type: 'es6' },
    }),
  ],
});

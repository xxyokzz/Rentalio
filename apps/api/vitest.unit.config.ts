import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Konfigurasi unit test: tanpa globalSetup database.
 *
 * Global setup pada `vitest.config.ts` mereset database test dan menjalankan
 * migrasi — diperlukan integration test, tetapi membuat unit test gagal hanya
 * karena PostgreSQL tidak berjalan. Unit test harus tetap cepat dan tidak
 * bergantung pada layanan eksternal (dokumen 12 S0-04).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    testTimeout: 30_000,
    sequence: { concurrent: false },
  },
  plugins: [
    // SWC diperlukan untuk `emitDecoratorMetadata` (DI NestJS).
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

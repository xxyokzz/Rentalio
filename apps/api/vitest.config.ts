import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // E2E memanggil layanan eksternal (Resend) dan punya config sendiri:
    // `vitest.e2e.config.ts`. Jangan ikut dijalankan bersama suite ini.
    exclude: ['test/e2e/**'],
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Integration test butuh PostgreSQL; unit test tetap cepat.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Berurutan agar test yang berbagi bucket rate limit deterministik.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  plugins: [
    // Vite/esbuild tidak mendukung `emitDecoratorMetadata`; tanpa metadata
    // itu NestJS tidak bisa meresolusi dependensi constructor (DI) dan
    // inisialisasi aplikasi menggantung. SWC meng-emit metadata tersebut.
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

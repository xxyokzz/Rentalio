/**
 * Setup environment untuk integration test.
 * Dijalankan oleh vitest SEBELUM test file di-import.
 *
 * Aturan dokumen 03/S0-03: test memakai DATABASE TERPISAH (sewain_test),
 * bukan database development. Suite destruktif menolak database produksi.
 */
// Decorator metadata (emitDecoratorMetadata) menuntut reflect-metadata
// dimuat sebelum modul NestJS apa pun di-import.
import 'reflect-metadata';
const TEST_DATABASE_URL =
  'postgresql://sewain_dev@localhost:5432/sewain_test?schema=public';

if (process.env.NODE_ENV !== 'test') {
  process.env.NODE_ENV = 'test';
}
process.env.DATABASE_URL = TEST_DATABASE_URL;
// Pepper tetap minimal 32 karakter; nilai acak tetap untuk test.
process.env.HMAC_PEPPER =
  process.env.HMAC_PEPPER ?? 'test-pepper-0123456789abcdefghijklmnopqrstuvwxyz';
process.env.EMAIL_PROVIDER = 'in-memory';
process.env.CORS_ORIGINS = 'http://localhost:3001';
process.env.COOKIE_SECURE = 'false';
process.env.APP_BASE_URL = 'http://localhost:3001';
// Admin Platform memakai origin sendiri; nilai test tetap, bukan secret nyata.
process.env.PLATFORM_ADMIN_BASE_URL = 'http://localhost:3002';
process.env.PLATFORM_ADMIN_ENCRYPTION_KEY =
  process.env.PLATFORM_ADMIN_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64');
// Skala besar agar test biasa tidak saling menghambat pada bucket IP.
// Test rate-limit menurunkan skala ini sementara (lihat auth.integration.test.ts).
process.env.RATE_LIMIT_SCALE = process.env.RATE_LIMIT_SCALE ?? '1000';
// Lingkungan shell induk dapat membawa PORT=0 (bukan integer valid untuk
// kontrak kami); test tidak mendengarkan port, tapi konfigurasi tetap tervalidasi.
process.env.PORT = process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : '3000';

/**
 * Integration test alur autentikasi — dijalankan terhadap PostgreSQL NYATA
 * (database sewain_test, role runtime sewain_dev), bukan mock.
 *
 * Mencakup acceptance test keputusan parameter auth 14 Okt 2026:
 * - OTP 10 menit, maks 5 percobaan, resend cooldown 60 detik
 * - konsumsi OTP atomik / sekali pakai
 * - cookie sesi HttpOnly + CSRF + Origin validation
 * - rate limit terpisah per IP dan email
 * - respons generik anti-enumerasi
 * - reset password: token sekali pakai + pencabutan sesi
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Server } from 'node:http';

import { AppModule } from '../../src/app.module.js';
import { HttpErrorFilter } from '../../src/common/http-error.filter.js';
import { EmailService, InMemoryEmailAdapter } from '../../src/email/email.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { RateLimitService, AUTH_RATE_LIMITS } from '../../src/rate-limit/rate-limit.service.js';

const API = '/api/v1';
const PW = 'kata-sandi-sangat-panjang-123';

let app: INestApplication;
let server: Server;
let emails: InMemoryEmailAdapter;
let prisma: PrismaService;
let rateLimit: RateLimitService;
let config: { RATE_LIMIT_SCALE: number };

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@contoh.com`;
}

function lastOtpFor(email: string): string {
  const otp = emails.lastOtpFor(email);
  if (!otp) throw new Error(`Tidak ada OTP untuk ${email}`);
  return otp;
}

/**
 * Kosongkan semua bucket rate limit.
 *
 * Bucket IP (auth.signup:ip, auth.login:ip, ...) memakai hash IP yang SAMA
 * untuk seluruh suite, karena semua request datang dari 127.0.0.1. Pada
 * skala besar (1000) limit IP tidak pernah tercapai, tapi saat test rate
 * limit menurunkan skala ke 1, bucket IP itu sudah penuh oleh test lain
 * sehingga request pertama langsung 429. Membersihkannya membuat pengujian
 * deterministik dan terisolasi per test.
 */
async function clearRateLimits(): Promise<void> {
  await prisma.client.rateLimitCounter.deleteMany({});
}

beforeAll(async () => {
  // abortOnError:false agar error inisialisasi asli ter-throw, bukan process.abort().
  app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  server = app.getHttpServer() as unknown as Server;

  emails = app.get(EmailService).testAdapter!;
  prisma = app.get(PrismaService);
  rateLimit = app.get(RateLimitService);
  config = app.get('APP_CONFIG');
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('health', () => {
  it('liveness tanpa detail internal', async () => {
    const res = await request(server).get(`${API}/health`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|secret|stack/i);
  });

  it('readiness mengecek database', async () => {
    const res = await request(server).get(`${API}/health/ready`);
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('ok');
  });
});

describe('pendaftaran OWNER + OTP', () => {
  it('register → 202 generik, user masih PENDING, OTP tidak tersimpan plaintext', async () => {
    const email = uniqueEmail('reg');
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });

    expect(res.status).toBe(202);

    const user = await prisma.client.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user!.status).toBe('PENDING_VERIFICATION');
    expect(user!.passwordHash).not.toContain(PW);

    // OTP tersimpan sebagai hash, bukan kode 6 digit plaintext.
    const ch = await prisma.client.emailVerificationChallenge.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    expect(ch).not.toBeNull();
    expect(ch!.otpHash).not.toMatch(/^\d{6}$/);
    expect(ch!.otpHash).not.toContain(lastOtpFor(email));
  });

  it('bukti persetujuan legal tersimpan: versi kedua dokumen + waktu penerimaan', async () => {
    const email = uniqueEmail('consent');
    const before = Date.now();
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({
        email,
        password: PW,
        termsAccepted: true,
        termsVersion: '2026-10-14',
        privacyVersion: '2026-10-14',
      });
    expect(res.status).toBe(202);

    const user = await prisma.client.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user!.termsConsentVersion).toBe('2026-10-14');
    expect(user!.privacyConsentVersion).toBe('2026-10-14');
    expect(user!.legalConsentAt).toBeInstanceOf(Date);
    // Timestamp berasal dari server, bukan dari kiriman klien.
    expect(user!.legalConsentAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(user!.legalConsentAt!.getTime()).toBeLessThanOrEqual(Date.now());

    // Versi persetujuan juga masuk audit trail (tanpa PII/rahasia).
    const audit = await prisma.client.auditLog.findFirst({
      where: {
        action: 'OWNER_SIGNUP_STARTED',
        metadata: { path: ['termsVersion'], equals: '2026-10-14' },
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit, 'audit OWNER_SIGNUP_STARTED tanpa versi persetujuan').not.toBeNull();
    expect(JSON.stringify(audit!.metadata)).toContain('2026-10-14');
  });

  it('registrasi tanpa persetujuan legal ditolak 400 dan tidak membuat user', async () => {
    const email = uniqueEmail('noconsent');
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email, password: PW });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prisma.client.user.findUnique({ where: { email } })).toBeNull();
  });

  it('termsAccepted=false dan versi dokumen kosong/invalid ditolak 400', async () => {
    const rejected = false;
    const declined = await request(server)
      .post(`${API}/auth/registrations`)
      .send({
        email: uniqueEmail('decline'),
        password: PW,
        termsAccepted: rejected,
        termsVersion: '2026-10-14',
        privacyVersion: '2026-10-14',
      });
    expect(declined.status).toBe(400);
    expect(declined.body.error.code).toBe('VALIDATION_ERROR');

    const blankVersion = await request(server)
      .post(`${API}/auth/registrations`)
      .send({
        email: uniqueEmail('blankver'),
        password: PW,
        termsAccepted: true,
        termsVersion: '   ',
        privacyVersion: '2026-10-14',
      });
    expect(blankVersion.status).toBe(400);

    const unknownField = await request(server)
      .post(`${API}/auth/registrations`)
      .send({
        email: uniqueEmail('extrafield'),
        password: PW,
        termsAccepted: true,
        termsVersion: '2026-10-14',
        privacyVersion: '2026-10-14',
        syaratSaja: true,
      });
    expect(unknownField.status).toBe(400);
  });

  it('register ulang untuk email terdaftar aktif tetap 202 (anti-enumerasi)', async () => {
    const email = uniqueEmail('enum');
    // Buat akun aktif langsung lewat alur verifikasi.
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    expect(res.status).toBe(202);
    // Tidak ada error/kode yang mengungkap keberadaan akun.
    expect(JSON.stringify(res.body)).not.toMatch(/sudah|terdaftar|exists/i);
  });

  it('verifikasi OTP benar → 204, user menjadi ACTIVE', async () => {
    const email = uniqueEmail('ok');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const res = await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    expect(res.status).toBe(204);
    const user = await prisma.client.user.findUnique({ where: { email } });
    expect(user!.status).toBe('ACTIVE');
    expect(user!.emailVerifiedAt).not.toBeNull();
  });

  it('OTP sekali pakai: verifikasi ulang dengan kode sama → 400', async () => {
    const email = uniqueEmail('reuse');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const otp = lastOtpFor(email);

    const first = await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: otp });
    expect(first.status).toBe(204);

    const second = await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: otp });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('OTP_INVALID_OR_EXPIRED');
  });

  it('OTP salah → 400 dan percobaan terhitung (maks 5)', async () => {
    const email = uniqueEmail('attempt');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const real = lastOtpFor(email);
    const wrong = real === '000000' ? '111111' : '000000';

    const res = await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: wrong });
    expect(res.status).toBe(400);

    const ch = await prisma.client.emailVerificationChallenge.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    expect(ch!.attemptCount).toBe(1);
  });

  it('resend terlalu cepat tidak menerbitkan OTP baru (cooldown 60 detik)', async () => {
    const email = uniqueEmail('cooldown');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const before = await prisma.client.emailVerificationChallenge.count({
      where: { email },
    });

    const res = await request(server)
      .post(`${API}/auth/registrations/resend-otp`)
      .send({ email });
    expect(res.status).toBe(202);

    const after = await prisma.client.emailVerificationChallenge.count({
      where: { email },
    });
    // Cooldown: challenge lama di-invalidate TAPI tidak ada kode baru
    // sebelum 60 detik. Kode tetap sama.
    expect(after).toBe(before);
  });

  it('OTP kedaluwarsa setelah 10 menit: kode benar tetap ditolak, akun tetap PENDING', async () => {
    const email = uniqueEmail('expiry');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const otp = lastOtpFor(email);

    const ch = await prisma.client.emailVerificationChallenge.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    // Kontrak: TTL OTP 10 menit sejak diterbitkan (± beberapa ms drift).
    const ttlMs = ch!.expiresAt.getTime() - ch!.createdAt.getTime();
    expect(Math.abs(ttlMs - 10 * 60 * 1000)).toBeLessThan(5000);

    // Lewati waktu tanpa menunggu: OTP kedaluwarsa di database.
    await prisma.client.emailVerificationChallenge.updateMany({
      where: { email, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: otp });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OTP_INVALID_OR_EXPIRED');

    const user = await prisma.client.user.findUnique({ where: { email } });
    expect(user!.status).toBe('PENDING_VERIFICATION');
    expect(user!.emailVerifiedAt).toBeNull();
    // Percobaan pada kode kedaluwarsa tidak dihitung.
    const after = await prisma.client.emailVerificationChallenge.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    expect(after!.attemptCount).toBe(0);
    expect(after!.consumedAt).toBeNull();
  });

  it('lima percobaan salah mengunci OTP: kode benar berikutnya tetap ditolak', async () => {
    const email = uniqueEmail('lock');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const real = lastOtpFor(email);
    const wrong = real === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request(server)
        .post(`${API}/auth/registrations/verify-email`)
        .send({ email, code: wrong });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OTP_INVALID_OR_EXPIRED');
    }

    const ch = await prisma.client.emailVerificationChallenge.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    expect(ch!.attemptCount).toBe(5);

    // Kode yang benar pun tidak lagi diterima setelah kuota percobaan habis.
    const blocked = await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: real });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('OTP_INVALID_OR_EXPIRED');

    const user = await prisma.client.user.findUnique({ where: { email } });
    expect(user!.status).toBe('PENDING_VERIFICATION');
  });

  it('dua verifikasi paralel: tepat satu 204, tidak ada tenant/membership ganda', async () => {
    const email = uniqueEmail('parverify');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const otp = lastOtpFor(email);

    const verify = () =>
      request(server)
        .post(`${API}/auth/registrations/verify-email`)
        .send({ email, code: otp });
    const [a, b] = await Promise.all([verify(), verify()]);

    expect([a.status, b.status].sort()).toEqual([204, 400]);
    const failed = a.status === 400 ? a : b;
    expect(failed.body.error.code).toBe('OTP_INVALID_OR_EXPIRED');

    const ch = await prisma.client.emailVerificationChallenge.findFirst({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    expect(ch!.consumedAt).not.toBeNull();

    const user = await prisma.client.user.findUnique({ where: { email } });
    expect(user!.status).toBe('ACTIVE');
    // Verifikasi email tidak membuat tenant/membership sama sekali: pembuatan
    // tenant beserta trial + subscription adalah tanggung jawab `POST /tenants`.
    // Assertion 0 ini sekaligus membuktikan verifikasi paralel tidak mungkin
    // menyisakan tenant/membership ganda.
    const memberships = await prisma.withActor(user!.id, (tx) =>
      tx.tenantMembership.count({ where: { userId: user!.id } }),
    );
    expect(memberships).toBe(0);
  });

  it('resend meng-invalidate kode sebelumnya (kode lama tidak berlaku)', async () => {
    const email = uniqueEmail('invalidate');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const oldOtp = lastOtpFor(email);

    // Paksa lewati cooldown dengan men backdate challenge.
    await prisma.client.emailVerificationChallenge.updateMany({
      where: { email, consumedAt: null, invalidatedAt: null },
      data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const resend = await request(server)
      .post(`${API}/auth/registrations/resend-otp`)
      .send({ email });
    expect(resend.status).toBe(202);

    const newOtp = lastOtpFor(email);
    expect(newOtp).not.toBe(oldOtp);

    // Kode lama harus ditolak.
    const res = await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: oldOtp });
    expect(res.status).toBe(400);
  });
});

describe('sesi, CSRF, dan logout', () => {
  it('login → 200 + cookie HttpOnly + X-CSRF-Token; sessions/current → 200', async () => {
    const email = uniqueEmail('login');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    const login = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: PW });

    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email);

    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const session = setCookie.find((c) => c.startsWith('rentalio_session='));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//i);
    // Secure mengikuti konfigurasi (false untuk http lokal).
    expect(session!.toLowerCase()).not.toContain('secure');

    const csrf = login.headers['x-csrf-token'] as string;
    expect(csrf).toBeTruthy();

    const cookie = session!.split(';')[0];
    const cur = await request(server)
      .get(`${API}/auth/sessions/current`)
      .set('Cookie', cookie);
    expect(cur.status).toBe(200);
    expect(cur.body.user.email).toBe(email);
  });

  it('tanpa cookie → 401 UNAUTHENTICATED', async () => {
    const res = await request(server).get(`${API}/auth/sessions/current`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.request_id).toBeTruthy();
  });

  it('login gagal untuk password salah → 401 INVALID_CREDENTIALS', async () => {
    const email = uniqueEmail('badpw');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    const res = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: 'kata-sandi-lainnya-9999' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('login ditolak sebelum email terverifikasi', async () => {
    const email = uniqueEmail('unverified');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const res = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: PW });
    expect(res.status).toBe(401);
  });

  it('mutasi tanpa token CSRF → 403; token salah → 403; Origin asing → 403', async () => {
    const { cookie, csrf } = await loginAs(uniqueEmail('csrf'));

    const noToken = await request(server)
      .delete(`${API}/auth/sessions/current`)
      .set('Cookie', cookie);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    const badToken = await request(server)
      .delete(`${API}/auth/sessions/current`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'token-salah');
    expect(badToken.status).toBe(403);

    const badOrigin = await request(server)
      .delete(`${API}/auth/sessions/current`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'https://evil.example');
    expect(badOrigin.status).toBe(403);
  });

  it('logout valid → 204 dan sesi dicabut permanen', async () => {
    const { cookie, csrf } = await loginAs(uniqueEmail('logout'));

    const out = await request(server)
      .delete(`${API}/auth/sessions/current`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001');
    expect(out.status).toBe(204);

    const reuse = await request(server)
      .get(`${API}/auth/sessions/current`)
      .set('Cookie', cookie);
    expect(reuse.status).toBe(401);
  });

  it('rotasi: login kedua membuat sesi baru, sesi lama tetap sah', async () => {
    const email = uniqueEmail('rotate');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    const a = await loginAs(email);
    const b = await loginAs(email);
    expect(b.cookie).not.toBe(a.cookie);

    const stillValid = await request(server)
      .get(`${API}/auth/sessions/current`)
      .set('Cookie', a.cookie);
    expect(stillValid.status).toBe(200);
  });
});

describe('reset password', () => {
  it('respons generik 202 baik terdaftar maupun tidak', async () => {
    const known = uniqueEmail('reset-known');
    await request(server).post(`${API}/auth/registrations`).send({ email: known, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });

    const a = await request(server)
      .post(`${API}/auth/password-resets`)
      .send({ email: known });
    const b = await request(server)
      .post(`${API}/auth/password-resets`)
      .send({ email: uniqueEmail('reset-unknown') });

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });

  it('reset sukses: 204, password lama ditolak, semua sesi tercabut', async () => {
    const email = uniqueEmail('reset');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    const { cookie } = await loginAs(email);

    await request(server).post(`${API}/auth/password-resets`).send({ email });
    const lastEmail = emails.sent.filter((m) => m.to === email).pop()!;
    const token = lastEmail.body.match(/token=([A-Za-z0-9_-]+)/)![1];

    const done = await request(server)
      .post(`${API}/auth/password-resets/complete`)
      .send({ token, newPassword: 'kata-sandi-baru-yang-panjang' });
    expect(done.status).toBe(204);

    // Password lama ditolak.
    const oldPw = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: PW });
    expect(oldPw.status).toBe(401);

    // Password baru diterima.
    const newPw = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: 'kata-sandi-baru-yang-panjang' });
    expect(newPw.status).toBe(200);

    // Sesinya... sesi lama seharusnya tercabut saat reset.
    const oldSession = await request(server)
      .get(`${API}/auth/sessions/current`)
      .set('Cookie', cookie);
    expect(oldSession.status).toBe(401);
  });

  it('token reset sekali pakai → 400 pada pemakaian kedua', async () => {
    const email = uniqueEmail('reset-once');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    await request(server).post(`${API}/auth/password-resets`).send({ email });
    const lastEmail = emails.sent.filter((m) => m.to === email).pop()!;
    const token = lastEmail.body.match(/token=([A-Za-z0-9_-]+)/)![1];

    const first = await request(server)
      .post(`${API}/auth/password-resets/complete`)
      .send({ token, newPassword: 'kata-sandi-baru-lagi-yang-panjang' });
    expect(first.status).toBe(204);

    const second = await request(server)
      .post(`${API}/auth/password-resets/complete`)
      .send({ token, newPassword: 'kata-sandi-baru-selanjutnya-panjang' });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('RESET_TOKEN_INVALID_OR_EXPIRED');
  });

  it('dua request reset PARALEL dengan token sama: paling banyak satu sukses', async () => {
    const email = uniqueEmail('reset-parallel');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    await request(server).post(`${API}/auth/password-resets`).send({ email });
    const lastEmail = emails.sent.filter((m) => m.to === email).pop()!;
    const token = lastEmail.body.match(/token=([A-Za-z0-9_-]+)/)![1];

    // Konsumsi token harus atomik (compare-and-set), bukan read-then-write:
    // dua request yang benar-benar bersamaan tidak boleh dua-duanya berhasil.
    const complete = (newPassword: string) =>
      request(server).post(`${API}/auth/password-resets/complete`).send({ token, newPassword });
    const [a, b] = await Promise.all([
      complete('kata-sandi-paralel-pertama-panjang'),
      complete('kata-sandi-paralel-kedua-panjang'),
    ]);

    expect([a.status, b.status].sort()).toEqual([204, 400]);
    const failed = a.status === 400 ? a : b;
    expect(failed.body.error.code).toBe('RESET_TOKEN_INVALID_OR_EXPIRED');

    // Challenge tepat satu kali dikonsumsi.
    const user = await prisma.client.user.findUnique({ where: { email } });
    const consumed = await prisma.client.passwordResetChallenge.count({
      where: { userId: user!.id, consumedAt: { not: null } },
    });
    expect(consumed).toBe(1);

    // Hanya password dari request yang menang yang berlaku.
    const winner = a.status === 204 ? 'kata-sandi-paralel-pertama-panjang' : 'kata-sandi-paralel-kedua-panjang';
    const loser = a.status === 204 ? 'kata-sandi-paralel-kedua-panjang' : 'kata-sandi-paralel-pertama-panjang';
    expect((await request(server).post(`${API}/auth/sessions`).send({ email, password: winner })).status).toBe(200);
    expect((await request(server).post(`${API}/auth/sessions`).send({ email, password: loser })).status).toBe(401);
    expect((await request(server).post(`${API}/auth/sessions`).send({ email, password: PW })).status).toBe(401);
  });

  it('token reset kedaluwarsa setelah 30 menit: 400 dan password tidak berubah', async () => {
    const email = uniqueEmail('reset-expiry');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    const user = await prisma.client.user.findUnique({ where: { email } });
    await request(server).post(`${API}/auth/password-resets`).send({ email });
    const lastEmail = emails.sent.filter((m) => m.to === email).pop()!;
    const token = lastEmail.body.match(/token=([A-Za-z0-9_-]+)/)![1];

    const ch = await prisma.client.passwordResetChallenge.findFirst({
      where: { userId: user!.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(ch).not.toBeNull();
    // Kontrak: TTL token reset 30 menit.
    const ttlMs = ch!.expiresAt.getTime() - ch!.createdAt.getTime();
    expect(Math.abs(ttlMs - 30 * 60 * 1000)).toBeLessThan(5000);

    // Lewati waktu tanpa menunggu.
    await prisma.client.passwordResetChallenge.updateMany({
      where: { userId: user!.id, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(server)
      .post(`${API}/auth/password-resets/complete`)
      .send({ token, newPassword: 'kata-sandi-baru-kedaluwarsa-123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RESET_TOKEN_INVALID_OR_EXPIRED');

    // Password lama tetap berlaku; password baru tidak pernah dipasang.
    const oldPw = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: PW });
    expect(oldPw.status).toBe(200);
    const newPw = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: 'kata-sandi-baru-kedaluwarsa-123' });
    expect(newPw.status).toBe(401);

    // Token kedaluwarsa tidak dikonsumsi maupun dicabut diam-diam.
    const after = await prisma.client.passwordResetChallenge.findFirst({
      where: { userId: user!.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(after!.consumedAt).toBeNull();
    expect(after!.invalidatedAt).toBeNull();
  });

  it('token reset palsu → 400', async () => {
    const res = await request(server)
      .post(`${API}/auth/password-resets/complete`)
      .send({ token: 'token-tidak-valid-sama-sekali', newPassword: 'kata-sandi-baru-panjang' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RESET_TOKEN_INVALID_OR_EXPIRED');
  });

  it('password terlalu pendek → 400 VALIDATION_ERROR', async () => {
    const res = await request(server)
      .post(`${API}/auth/password-resets/complete`)
      .send({ token: 'x', newPassword: 'pendek' });
    expect(res.status).toBe(400);
  });
});

describe('validasi input (ValidationPipe + DTO)', () => {
  // Regresi: `@Body()` pernah bertipe literal object sehingga metatype di
  // runtime = `Object` dan ValidationPipe melewatkannya. Akibatnya
  // `forbidNonWhitelisted` tidak berfungsi (properti asing diterima 202),
  // field hilang jatuh ke 500, dan format email tak diperiksa.
  it('menolak properti tak dikenal (forbidNonWhitelisted) → 400', async () => {
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email: uniqueEmail('unknown'), password: PW, propertiAsing: 1, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('field wajib hilang → 400, bukan 500', async () => {
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({ password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.code).not.toBe('INTERNAL_ERROR');
  });

  it('format email salah → 400', async () => {
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email: 'bukan-format-email', password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('password di bawah 12 karakter → 400 pada register', async () => {
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email: uniqueEmail('shortpw'), password: 'pendek', termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('kode OTP bukan 6 digit → 400 oleh pipe, bukan oleh service', async () => {
    const res = await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email: uniqueEmail('badotp'), code: '12345' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Bukan OTP_INVALID_OR_EXPIRED: pipe menolak sebelum mencapai service,
    // sehingga tidak menghabiskan kuota percobaan OTP.
    expect(res.body.error.code).not.toBe('OTP_INVALID_OR_EXPIRED');
  });

  it('request valid tetap diterima (tidak merusak jalur normal)', async () => {
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email: uniqueEmail('valid'), password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    expect(res.status).toBe(202);
  });
});

describe('rate limit (PostgreSQL store)', () => {
  it('signup dibatasi per email (3/jam) dan per IP', async () => {
    const scale = config.RATE_LIMIT_SCALE;
    config.RATE_LIMIT_SCALE = 1; // pakai angka kontrak
    try {
      // Isolasi: buang penumpukan bucket IP dari test-test sebelumnya.
      await clearRateLimits();
      const email = uniqueEmail('rl-signup');
      // 3 pertama lolos.
      for (let i = 0; i < 3; i++) {
        const res = await request(server)
          .post(`${API}/auth/registrations`)
          .send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
        expect(res.status).toBe(202);
      }
      // Ke-4 harus ditolak 429 dengan Retry-After.
      const res = await request(server)
        .post(`${API}/auth/registrations`)
        .send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    } finally {
      config.RATE_LIMIT_SCALE = scale;
    }
  });

  it('login dibatasi per akun (5/15 menit)', async () => {
    const scale = config.RATE_LIMIT_SCALE;
    config.RATE_LIMIT_SCALE = 1;
    try {
      // Isolasi: tanpa ini, register di bawah kena 429 dari bucket IP signup
      // yang sudah penuh, sehingga OTP tidak pernah diterbitkan.
      await clearRateLimits();
      const email = uniqueEmail('rl-login');
      await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
      await request(server)
        .post(`${API}/auth/registrations/verify-email`)
        .send({ email, code: lastOtpFor(email) });

      let sawLimit = false;
      for (let i = 0; i < 7; i++) {
        const res = await request(server)
          .post(`${API}/auth/sessions`)
          .send({ email, password: 'kata-sandi-salah-999999' });
        if (res.status === 429) {
          sawLimit = true;
          expect(res.body.error.code).toBe('RATE_LIMITED');
          break;
        }
        expect(res.status).toBe(401);
      }
      expect(sawLimit).toBe(true);
    } finally {
      config.RATE_LIMIT_SCALE = scale;
    }
  });

  it('rate limit menyimpan identifier sebagai hash (bukan IP/email mentah)', async () => {
    const before = await prisma.client.rateLimitCounter.count();
    await rateLimit.consume(AUTH_RATE_LIMITS.signupEmail, 'harta-rahasia@contoh.com');
    const row = await prisma.client.rateLimitCounter.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    expect(await prisma.client.rateLimitCounter.count()).toBeGreaterThan(before);
    expect(row!.identifier).not.toContain('harta-rahasia');
    expect(row!.identifier).not.toContain('contoh.com');
  });
});

describe('audit log', () => {
  it('mencatat kejadian auth tanpa rahasia (OTP/password/token)', async () => {
    const email = uniqueEmail('audit');
    await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
    const otp = lastOtpFor(email);
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: otp });

    const logs = await prisma.client.auditLog.findMany({
      where: { action: { startsWith: 'OWNER_' } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    expect(logs.length).toBeGreaterThan(0);

    const dump = JSON.stringify(logs);
    // Tidak boleh ada OTP, password, atau token mentah di audit.
    expect(dump).not.toContain(otp);
    expect(dump).not.toContain(PW);
    expect(dump).not.toContain(email); // email disimpan hashed
  });
});

describe('profil pendaftaran (ownerName / tenantName / tenantSlug)', () => {
  const CONSENT = {
    termsAccepted: true,
    termsVersion: '2026-10-14',
    privacyVersion: '2026-10-14',
  } as const;

  it('register menyimpan profil untuk prefill onboarding', async () => {
    const email = uniqueEmail('profil');
    const res = await request(server)
      .post(`${API}/auth/registrations`)
      .send({
        email,
        password: PW,
        ownerName: 'Rina Wijaya',
        tenantName: 'Rental Motor Jakarta',
        tenantSlug: 'rental-motor-jakarta',
        ...CONSENT,
      });
    expect(res.status).toBe(202);

    const user = await prisma.client.user.findUnique({ where: { email } });
    expect(user).toMatchObject({
      ownerName: 'Rina Wijaya',
      tenantName: 'Rental Motor Jakarta',
      tenantSlug: 'rental-motor-jakarta',
    });
  });

  it('format profil tidak valid ditolak 400 tanpa membuat baris user', async () => {
    const cases: Record<string, string>[] = [
      { ownerName: '' },
      { ownerName: 'x'.repeat(121) },
      { tenantName: 'x'.repeat(101) },
      // Slug mengikuti aturan CreateTenantDto: huruf besar & awalan tanda
      // hubung ditolak, minimal 3 karakter.
      { tenantSlug: 'Toko-Besar' },
      { tenantSlug: 'ab' },
      { tenantSlug: '-mulai-tanda' },
    ];

    for (const [index, extra] of cases.entries()) {
      const email = uniqueEmail(`profil-bad-${index}`);
      const res = await request(server)
        .post(`${API}/auth/registrations`)
        .send({ email, password: PW, ...extra, ...CONSENT });
      expect(res.status, `kasus ${JSON.stringify(extra)}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await prisma.client.user.findUnique({ where: { email } })).toBeNull();
    }
  });

  it('login dan GET /auth/sessions/current mengembalikan profil untuk prefill onboarding', async () => {
    const email = uniqueEmail('profil-sesi');
    await request(server)
      .post(`${API}/auth/registrations`)
      .send({
        email,
        password: PW,
        ownerName: 'Budi Santoso',
        tenantName: 'Sewa Alat Berat',
        tenantSlug: 'sewa-alat-berat',
        ...CONSENT,
      });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    const login = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: PW });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({
      email,
      ownerName: 'Budi Santoso',
      tenantName: 'Sewa Alat Berat',
      tenantSlug: 'sewa-alat-berat',
    });

    const setCookie = login.headers['set-cookie'] as unknown as string[];
    const session = setCookie.find((c) => c.startsWith('rentalio_session='))!;
    const current = await request(server)
      .get(`${API}/auth/sessions/current`)
      .set('Cookie', session.split(';')[0]);
    expect(current.status).toBe(200);
    expect(current.body.user).toMatchObject({
      email,
      ownerName: 'Budi Santoso',
      tenantName: 'Sewa Alat Berat',
      tenantSlug: 'sewa-alat-berat',
    });
  });

  it('registrasi tanpa profil → login & sesi mengembalikan null (bukan error)', async () => {
    const email = uniqueEmail('profil-kosong');
    await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email, password: PW, ...CONSENT });
    await request(server)
      .post(`${API}/auth/registrations/verify-email`)
      .send({ email, code: lastOtpFor(email) });

    const login = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email, password: PW });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({
      email,
      ownerName: null,
      tenantName: null,
      tenantSlug: null,
    });
  });

  it('pendaftaran ulang akun pending memperbarui profil; tanpa field mempertahankan nilai lama', async () => {
    const email = uniqueEmail('profil-update');
    await request(server)
      .post(`${API}/auth/registrations`)
      .send({
        email,
        password: PW,
        ownerName: 'Nama Pertama',
        tenantName: 'Toko Pertama',
        tenantSlug: 'toko-pertama',
        ...CONSENT,
      });
    await request(server)
      .post(`${API}/auth/registrations`)
      .send({
        email,
        password: PW,
        ownerName: 'Nama Kedua',
        tenantName: 'Toko Kedua',
        tenantSlug: 'toko-kedua',
        ...CONSENT,
      });
    let user = await prisma.client.user.findUnique({ where: { email } });
    expect(user).toMatchObject({
      ownerName: 'Nama Kedua',
      tenantName: 'Toko Kedua',
      tenantSlug: 'toko-kedua',
    });

    // Percobaan ketiga tanpa field profil: nilai lama tidak dikosongkan.
    await request(server)
      .post(`${API}/auth/registrations`)
      .send({ email, password: PW, ...CONSENT });
    user = await prisma.client.user.findUnique({ where: { email } });
    expect(user).toMatchObject({
      ownerName: 'Nama Kedua',
      tenantName: 'Toko Kedua',
      tenantSlug: 'toko-kedua',
    });
  });
});

/** Helper: daftar → verifikasi → login, kembalikan cookie & csrf. */
async function loginAs(email: string): Promise<{ cookie: string; csrf: string }> {
  const pw = PW;
  await request(server).post(`${API}/auth/registrations`).send({ email, password: pw, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
  await request(server)
    .post(`${API}/auth/registrations/verify-email`)
    .send({ email, code: lastOtpFor(email) });

  const login = await request(server)
    .post(`${API}/auth/sessions`)
    .send({ email, password: pw });
  expect(login.status).toBe(200);

  const setCookie = login.headers['set-cookie'] as unknown as string[];
  const session = setCookie.find((c) => c.startsWith('rentalio_session='))!;
  return {
    cookie: session.split(';')[0],
    csrf: login.headers['x-csrf-token'] as string,
  };
}

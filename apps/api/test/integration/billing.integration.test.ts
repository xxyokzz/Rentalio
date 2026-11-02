/**
 * Integration test: billing langganan lewat QRIS dinamis.
 *
 * QRIS dinamis tidak punya provider/callback. Yang diuji di sini adalah alur
 * nyata end-to-end:
 *   - QRIS statis platform diubah menjadi QRIS dinamis bernominal (CRC valid),
 *   - tagihan PENDING disimpan sekali (klik ganda memakai baris yang sama),
 *   - operator Admin Platform menandai lunas → langganan diperpanjang sekali,
 *   - replay settle ditolak dan tidak menambah periode,
 *   - permission/CSRF/isolasi identitas tetap ditegakkan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { calculateCRC16, parseQRIS, validateQRIS } from '../../src/billing/qris/index.js';
import { TOTP_STEP_MS, totpCodeForStep } from '../../src/platform-admin/platform-admin.crypto.js';
import { hashPassword } from '../../src/common/crypto.js';

const API = '/api/v1';
const ADMIN_ORIGIN = 'http://localhost:3002';
const PW = 'kata-sandi-billing-testing-001';
const PRICE = 149_000;
const PERIOD_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

let app: INestApplication;
let server: Server;
let prisma: PrismaService;
let emails: InMemoryEmailAdapter;

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function tlv(tag: string, value: string): string {
  return `${tag}${value.length.toString().padStart(2, '0')}${value}`;
}

/** QRIS statis merchant Rentalio (fixture uji, CRC dihitung library). */
const STATIC_QRIS = (() => {
  const body = [
    tlv('00', '01'),
    tlv('01', '11'),
    tlv('26', tlv('00', 'ID.CO.QRIS.WWW') + tlv('01', '9360000001')),
    tlv('52', '5812'),
    tlv('53', '360'),
    tlv('58', 'ID'),
    tlv('59', 'RENTALIO'),
    tlv('60', 'JAKARTA'),
  ].join('');
  const withoutCrc = `${body}6304`;
  return withoutCrc + calculateCRC16(withoutCrc);
})();

async function register(email: string): Promise<{ cookie: string; csrf: string; userId: string }> {
  await request(server)
    .post(`${API}/auth/registrations`)
    .send({
      email,
      password: PW,
      termsAccepted: true,
      termsVersion: '2026-10-14',
      privacyVersion: '2026-10-14',
    });
  const otp = emails.lastOtpFor(email);
  if (!otp) throw new Error(`Tidak ada OTP untuk ${email}`);
  await request(server).post(`${API}/auth/registrations/verify-email`).send({ email, code: otp });
  const login = await request(server).post(`${API}/auth/sessions`).send({ email, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const user = await prisma.client.user.findUnique({ where: { email } });
  return {
    cookie: session.split(';')[0]!,
    csrf: login.headers['x-csrf-token'] as string,
    userId: user!.id,
  };
}

async function createTenant(cookie: string, csrf: string): Promise<string> {
  const slug = `billing-${Date.now() % 100000}-${Math.floor(Math.random() * 1000)}`;
  const res = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', 'http://localhost:3001')
    .send({ name: 'Toko Billing', slug });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

function createInvoiceRequest(tenantId: string, session: { cookie: string; csrf: string }) {
  return request(server)
    .post(`${API}/tenants/${tenantId}/subscription-invoices`)
    .set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf)
    .set('Origin', 'http://localhost:3001');
}

function adminCookieOf(response: { headers: Record<string, unknown> }): string {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const session = cookies?.find((c) => c.startsWith('rentalio_platform_admin='));
  if (!session) throw new Error('cookie admin tidak ditemukan');
  return session;
}

async function createAdminWithPermission(email: string, permissionCode: string): Promise<void> {
  const permission = await prisma.client.platformPermission.findUnique({
    where: { code: permissionCode },
  });
  if (!permission) throw new Error(`permission ${permissionCode} tidak ada di seed`);
  const role = await prisma.client.platformRole.create({
    data: {
      code: `TEST_${uid('ROLE').replace(/[^A-Z0-9_]/gi, '').slice(0, 40).toUpperCase()}`,
      name: 'test role',
      permissions: { create: { permissionId: permission.id } },
    },
  });
  const admin = await prisma.client.platformAdminUser.create({
    data: { email, passwordHash: hashPassword('kata-sandi-admin-platform-123') },
  });
  await prisma.client.platformAdminRole.create({
    data: { adminUserId: admin.id, roleId: role.id },
  });
}

async function loginAdmin(email: string): Promise<{ cookie: string; csrf: string }> {
  const first = await request(server)
    .post(`${API}/platform-admin/auth/login`)
    .send({ email, password: 'kata-sandi-admin-platform-123' });
  expect(first.status).toBe(200);
  expect(first.body.status).toBe('MFA_ENROLLMENT_REQUIRED');
  const secret = new URL(first.body.challenge.provisioningUri as string).searchParams.get('secret')!;
  const mfa = await request(server)
    .post(`${API}/platform-admin/auth/mfa`)
    .send({
      challengeToken: first.body.challenge.challengeToken,
      code: totpCodeForStep(secret, Math.floor(Date.now() / TOTP_STEP_MS)),
    });
  expect(mfa.status).toBe(200);
  return { cookie: adminCookieOf(mfa).split(';')[0]!, csrf: mfa.body.csrfToken as string };
}

function settleRequest(
  tenantId: string,
  invoiceId: string,
  session: { cookie: string; csrf: string },
) {
  return request(server)
    .post(
      `${API}/platform-admin/tenants/${tenantId}/subscription-invoices/${invoiceId}/settle`,
    )
    .set('Cookie', session.cookie)
    .set('x-platform-admin-csrf', session.csrf)
    .set('Origin', ADMIN_ORIGIN)
    .send({ reason: 'Mutasi QRIS tervalidasi 1234567890' });
}

beforeAll(async () => {
  process.env.PLATFORM_QRIS_STATIC_PAYLOAD = STATIC_QRIS;
  process.env.SUBSCRIPTION_PRICE_AMOUNT = String(PRICE);
  process.env.SUBSCRIPTION_PERIOD_DAYS = String(PERIOD_DAYS);
  process.env.SUBSCRIPTION_INVOICE_DURATION_SECONDS = '86400';

  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  server = app.getHttpServer() as unknown as Server;
  prisma = app.get(PrismaService);
  emails = app.get(EmailService).testAdapter!;
}, 120_000);

afterAll(async () => {
  await app?.close();
  delete process.env.PLATFORM_QRIS_STATIC_PAYLOAD;
  delete process.env.SUBSCRIPTION_PRICE_AMOUNT;
  delete process.env.SUBSCRIPTION_PERIOD_DAYS;
  delete process.env.SUBSCRIPTION_INVOICE_DURATION_SECONDS;
});

describe('Billing langganan (QRIS dinamis)', () => {
  it('POST membuat QRIS dinamis bernominal sekali; klik ulang memakai tagihan yang sama', async () => {
    const owner = await register(`${uid('qris-owner')}@contoh.com`);
    const tenantId = await createTenant(owner.cookie, owner.csrf);

    const first = await createInvoiceRequest(tenantId, owner);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      status: 'PENDING',
      amount: String(PRICE),
      currency: 'IDR',
      provider: 'qris',
    });

    const payload = first.body.data.qrPayload as string;
    expect(validateQRIS(payload).valid).toBe(true);
    const parsed = parseQRIS(payload);
    expect(parsed.method).toBe('dynamic');
    expect(parsed.amount).toBe(String(PRICE));
    expect(parsed.merchantName).toBe('RENTALIO');
    expect(first.body.data.qrImageDataUrl).toMatch(/^data:image\/png;base64,/);

    const second = await createInvoiceRequest(tenantId, owner);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.qrPayload).toBe(payload);

    const list = await request(server)
      .get(`${API}/tenants/${tenantId}/subscription-invoices`)
      .set('Cookie', owner.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: first.body.data.id,
      status: 'PENDING',
      qrImageDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    });
  });

  it('operator Admin Platform menandai lunas: langganan aktif satu periode, replay ditolak', async () => {
    const owner = await register(`${uid('qris-paid')}@contoh.com`);
    const tenantId = await createTenant(owner.cookie, owner.csrf);
    const created = await createInvoiceRequest(tenantId, owner);
    expect(created.status).toBe(201);

    const adminEmail = `${uid('qris-admin')}@contoh.com`;
    await createAdminWithPermission(adminEmail, 'platform.subscriptions.settle');
    const admin = await loginAdmin(adminEmail);

    const settle = await settleRequest(tenantId, created.body.data.id, admin);
    expect(settle.status).toBe(200);
    expect(settle.body.data).toMatchObject({
      id: created.body.data.id,
      status: 'PAID',
      amount: String(PRICE),
      paidAmount: String(PRICE),
    });

    const detail = await request(server)
      .get(`${API}/tenants/${tenantId}`)
      .set('Cookie', owner.cookie);
    expect(detail.body.data.subscription.status).toBe('ACTIVE');
    expect(detail.body.data.billing).toMatchObject({
      paymentEnabled: true,
      priceAmount: String(PRICE),
      periodDays: PERIOD_DAYS,
    });

    const subscription = await prisma.withTenant(tenantId, (tx) =>
      tx.subscription.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
    expect(subscription?.status).toBe('ACTIVE');
    expect(subscription!.periodEnd!.getTime() - subscription!.periodStart!.getTime()).toBe(
      PERIOD_DAYS * DAY_MS,
    );

    const storedInvoice = await prisma.withTenant(tenantId, (tx) =>
      tx.subscriptionInvoice.findUnique({ where: { id: created.body.data.id } }),
    );
    expect(storedInvoice?.status).toBe('PAID');
    expect(storedInvoice?.paymentChannel).toBe('QRIS');
    expect(storedInvoice?.paidAmount?.toString()).toBe(String(PRICE));

    // Replay: tagihan sudah PAID → 409, periode tidak bertambah.
    const replay = await settleRequest(tenantId, created.body.data.id, admin);
    expect(replay.status).toBe(409);

    const afterReplay = await prisma.withTenant(tenantId, (tx) =>
      tx.subscription.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    );
    expect(afterReplay!.periodEnd!.getTime()).toBe(subscription!.periodEnd!.getTime());
  });

  it('role admin tanpa platform.subscriptions.settle ditolak 403 dan tidak mengubah tagihan', async () => {
    const owner = await register(`${uid('qris-denied')}@contoh.com`);
    const tenantId = await createTenant(owner.cookie, owner.csrf);
    const created = await createInvoiceRequest(tenantId, owner);

    const adminEmail = `${uid('qris-readonly')}@contoh.com`;
    await createAdminWithPermission(adminEmail, 'platform.dashboard.read');
    const admin = await loginAdmin(adminEmail);

    const denied = await settleRequest(tenantId, created.body.data.id, admin);
    expect(denied.status).toBe(403);

    const stored = await prisma.withTenant(tenantId, (tx) =>
      tx.subscriptionInvoice.findUnique({ where: { id: created.body.data.id } }),
    );
    expect(stored?.status).toBe('PENDING');
  });

  it('cookie tenant tidak dapat dipakai ke endpoint settle admin', async () => {
    const owner = await register(`${uid('qris-mixed')}@contoh.com`);
    const tenantId = await createTenant(owner.cookie, owner.csrf);
    const created = await createInvoiceRequest(tenantId, owner);

    const res = await request(server)
      .post(
        `${API}/platform-admin/tenants/${tenantId}/subscription-invoices/${created.body.data.id}/settle`,
      )
      .set('Cookie', owner.cookie)
      .set('x-platform-admin-csrf', owner.csrf)
      .set('Origin', ADMIN_ORIGIN)
      .send({ reason: 'Mencoba memakai cookie tenant' });
    expect(res.status).toBe(401);
  });

  it('tagihan kedaluwarsa ditutup EXPIRED saat tagihan baru dibuat', async () => {
    const owner = await register(`${uid('qris-expired')}@contoh.com`);
    const tenantId = await createTenant(owner.cookie, owner.csrf);
    const created = await createInvoiceRequest(tenantId, owner);

    await prisma.withTenant(tenantId, (tx) =>
      tx.subscriptionInvoice.update({
        where: { id: created.body.data.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );

    const fresh = await createInvoiceRequest(tenantId, owner);
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.id).not.toBe(created.body.data.id);

    const old = await prisma.withTenant(tenantId, (tx) =>
      tx.subscriptionInvoice.findUnique({ where: { id: created.body.data.id } }),
    );
    expect(old?.status).toBe('EXPIRED');
  });

  it('anggota non-owner tidak boleh membuat tagihan', async () => {
    const owner = await register(`${uid('qris-owner2')}@contoh.com`);
    const tenantId = await createTenant(owner.cookie, owner.csrf);

    const manager = await register(`${uid('qris-manager')}@contoh.com`);
    await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.create({
        data: {
          tenantId,
          userId: manager.userId,
          role: 'MANAGER',
          status: 'ACTIVE',
          permissions: [],
        },
      }),
    );

    const res = await createInvoiceRequest(tenantId, manager);
    expect(res.status).toBe(403);
  });

  it('bila QRIS platform belum dikonfigurasi, pembuatan tagihan ditolak 503', async () => {
    const owner = await register(`${uid('qris-unconfigured')}@contoh.com`);
    const tenantId = await createTenant(owner.cookie, owner.csrf);

    const saved = process.env.PLATFORM_QRIS_STATIC_PAYLOAD;
    delete process.env.PLATFORM_QRIS_STATIC_PAYLOAD;

    const isolated = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    isolated.setGlobalPrefix('api/v1');
    isolated.use(cookieParser());
    isolated.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    isolated.useGlobalFilters(new HttpErrorFilter());
    await isolated.init();
    const isolatedServer = isolated.getHttpServer() as unknown as Server;

    try {
      const res = await request(isolatedServer)
        .post(`${API}/tenants/${tenantId}/subscription-invoices`)
        .set('Cookie', owner.cookie)
        .set('X-CSRF-Token', owner.csrf)
        .set('Origin', 'http://localhost:3001');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('BILLING_NOT_CONFIGURED');
    } finally {
      await isolated.close();
      if (saved === undefined) delete process.env.PLATFORM_QRIS_STATIC_PAYLOAD;
      else process.env.PLATFORM_QRIS_STATIC_PAYLOAD = saved;
    }
  });
});

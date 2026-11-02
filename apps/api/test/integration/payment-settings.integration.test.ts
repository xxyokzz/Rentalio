/**
 * Integration test: pengaturan metode pembayaran per tenant.
 *
 * Mencakup:
 * - GET/PUT /tenants/:tenantId/payment-methods (matriks 3 konteks × 3 metode)
 * - default aktif untuk baris yang belum ada
 * - validasi minimal satu metode aktif per konteks
 * - penolakan metode nonaktif pada POST /orders/:id/payments (422)
 * - snapshot konteks pada payment
 * - isolasi tenant (RLS + permission) dan audit perubahan
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
import { EmailService } from '../../src/email/email.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const API = '/api/v1';
const PW = 'kata-sandi-payment-settings-001';
const ORIGIN = 'http://localhost:3001';

let app: INestApplication;
let server: Server;
let emailSvc: InstanceType<typeof EmailService>;
let prisma: PrismaService;

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
function em(prefix: string) {
  return `${uid(prefix)}@contoh.com`;
}
function slug(prefix: string) {
  return `${prefix.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now() % 1000000}`;
}
function base(tenantId: string) {
  return `${API}/tenants/${tenantId}`;
}
function auth(req: request.Test, fx: { cookie: string; csrf: string }): request.Test {
  return req.set('Cookie', fx.cookie).set('X-CSRF-Token', fx.csrf).set('Origin', ORIGIN);
}

interface Actor {
  cookie: string;
  csrf: string;
  userId: string;
}

interface Fixture {
  owner: Actor;
  tenantId: string;
  orderId: string;
}

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  server = app.getHttpServer() as unknown as Server;
  emailSvc = app.get(EmailService);
  prisma = app.get(PrismaService);
}, 120_000);

afterAll(() => app?.close());

async function registerAndLogin(emailAddr: string): Promise<Actor> {
  await request(server).post(`${API}/auth/registrations`).send({ email: emailAddr, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
  const otp = emailSvc.testAdapter!.lastOtpFor(emailAddr);
  if (!otp) throw new Error(`OTP tidak ada untuk ${emailAddr}`);
  await request(server)
    .post(`${API}/auth/registrations/verify-email`)
    .send({ email: emailAddr, code: otp });
  return freshLogin(emailAddr);
}

async function freshLogin(emailAddr: string): Promise<Actor> {
  const login = await request(server).post(`${API}/auth/sessions`).send({ email: emailAddr, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const user = await prisma.client.user.findUnique({ where: { email: emailAddr.toLowerCase() } });
  return {
    cookie: session.split(';')[0],
    csrf: login.headers['x-csrf-token'] as string,
    userId: user!.id,
  };
}

function lastInviteToken(to: string): string {
  const sent = emailSvc.testAdapter!.sent;
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (sent[i].to.toLowerCase() === to.toLowerCase()) {
      const match = sent[i].body.match(/token=([A-Za-z0-9_\-]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  }
  throw new Error(`Tidak ada token undangan untuk ${to}`);
}

async function inviteManager(owner: Actor, tenantId: string, prefix: string): Promise<Actor> {
  const staffEmail = em(prefix);
  const invite = await auth(request(server).post(`${base(tenantId)}/members`), owner).send({
    email: staffEmail,
    role: 'MANAGER',
  });
  if (invite.status !== 201) throw new Error(JSON.stringify(invite.body));
  const accept = await request(server)
    .post(`${API}/auth/invitations/accept`)
    .send({ token: lastInviteToken(staffEmail), password: PW });
  if (accept.status !== 200) throw new Error(JSON.stringify(accept.body));
  return freshLogin(staffEmail);
}

async function setup(prefix: string): Promise<Fixture> {
  const owner = await registerAndLogin(em(prefix));
  const tenant = await auth(request(server).post(`${API}/tenants`), owner).send({
    name: `Tenant ${prefix}`,
    slug: slug(prefix),
  });
  if (tenant.status !== 201) throw new Error(JSON.stringify(tenant.body));
  const tenantId = tenant.body.data.id as string;

  await auth(request(server).patch(`${base(tenantId)}/settings`), owner).send({
    bookingMode: 'AUTOMATIC',
  });
  const product = await auth(request(server).post(`${base(tenantId)}/products`), owner).send({
    name: `Produk ${prefix}`,
    stockMode: 'QUANTITY',
    capacity: 10,
  });
  if (product.status !== 201) throw new Error(JSON.stringify(product.body));
  const productId = product.body.data.id as string;
  await auth(request(server).post(`${base(tenantId)}/products/${productId}/rates`), owner).send({
    perDayAmount: 50_000,
  });
  const reservation = await auth(
    request(server).post(`${base(tenantId)}/reservations`),
    owner,
  ).send({
    startAt: '2026-12-01T00:00:00.000Z',
    endAt: '2026-12-03T00:00:00.000Z',
    items: [{ productId, quantity: 1 }],
  });
  if (reservation.status !== 201) throw new Error(JSON.stringify(reservation.body));
  const convert = await auth(
    request(server).post(`${base(tenantId)}/reservations/${reservation.body.data.id}/convert-to-order`),
    owner,
  );
  if (convert.status !== 201) throw new Error(JSON.stringify(convert.body));

  return { owner, tenantId, orderId: convert.body.data.id as string };
}

describe('Payment settings — matriks per konteks', () => {
  it('default: 9 kombinasi aktif bila belum ada konfigurasi', async () => {
    const fx = await setup('psdefault');
    const res = await auth(
      request(server).get(`${base(fx.tenantId)}/payment-methods`),
      fx.owner,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.settings).toHaveLength(9);
    expect(res.body.data.settings.every((row: { enabled: boolean }) => row.enabled)).toBe(true);
    expect(
      new Set(res.body.data.settings.map((row: { context: string }) => row.context)),
    ).toEqual(new Set(['NEW_BOOKING', 'ADD_UNIT', 'EXTENSION']));
  });

  it('menonaktifkan QRIS NEW_BOOKING menolak payment QRIS, tetapi konteks lain tetap boleh', async () => {
    const fx = await setup('psdisable');
    const update = await auth(
      request(server).put(`${base(fx.tenantId)}/payment-methods`),
      fx.owner,
    ).send({
      settings: [{ context: 'NEW_BOOKING', method: 'QRIS', enabled: false }],
    });
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    const qrisNewBooking = update.body.data.settings.find(
      (row: { context: string; method: string }) =>
        row.context === 'NEW_BOOKING' && row.method === 'QRIS',
    );
    expect(qrisNewBooking.enabled).toBe(false);

    const denied = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '50000', currency: 'IDR', method: 'QRIS', context: 'NEW_BOOKING' });
    expect(denied.status).toBe(422);
    expect(denied.body.error.code).toBe('PAYMENT_METHOD_DISABLED');

    const cash = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '50000', currency: 'IDR', method: 'CASH', context: 'NEW_BOOKING' });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.context).toBe('NEW_BOOKING');

    // Konteks EXTENSION belum diubah → QRIS masih aktif.
    const extension = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '25000', currency: 'IDR', method: 'QRIS', context: 'EXTENSION' });
    expect(extension.status, JSON.stringify(extension.body)).toBe(201);
    expect(extension.body.data.context).toBe('EXTENSION');
  });

  it('konfigurasi yang menghapus semua metode aktif pada satu konteks ditolak 422', async () => {
    const fx = await setup('psalloff');
    const res = await auth(
      request(server).put(`${base(fx.tenantId)}/payment-methods`),
      fx.owner,
    ).send({
      settings: [
        { context: 'NEW_BOOKING', method: 'CASH', enabled: false },
        { context: 'NEW_BOOKING', method: 'BANK_TRANSFER', enabled: false },
        { context: 'NEW_BOOKING', method: 'QRIS', enabled: false },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    const current = await auth(
      request(server).get(`${base(fx.tenantId)}/payment-methods`),
      fx.owner,
    );
    expect(
      current.body.data.settings
        .filter((row: { context: string }) => row.context === 'NEW_BOOKING')
        .every((row: { enabled: boolean }) => row.enabled),
    ).toBe(true);
  });

  it('dua perubahan paralel tidak dapat menyisakan nol metode aktif', async () => {
    const fx = await setup('psrace');
    const disableOne = () =>
      auth(request(server).put(`${base(fx.tenantId)}/payment-methods`), fx.owner).send({
        settings: [{ context: 'NEW_BOOKING', method: 'CASH', enabled: false }],
      });
    const disableRest = () =>
      auth(request(server).put(`${base(fx.tenantId)}/payment-methods`), fx.owner).send({
        settings: [
          { context: 'NEW_BOOKING', method: 'BANK_TRANSFER', enabled: false },
          { context: 'NEW_BOOKING', method: 'QRIS', enabled: false },
        ],
      });

    // Kedua request mulai tanpa saling menunggu; row lock tenant membuat
    // salah satunya melihat perubahan yang lain lalu ditolak 422.
    const results = await Promise.all([disableOne(), disableRest()]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 422]);

    const matrix = await auth(
      request(server).get(`${base(fx.tenantId)}/payment-methods`),
      fx.owner,
    );
    const active = matrix.body.data.settings.filter(
      (row: { context: string; enabled: boolean }) =>
        row.context === 'NEW_BOOKING' && row.enabled,
    );
    expect(active.length).toBeGreaterThanOrEqual(1);
  });

  it('duplikat konteks+metode ditolak 400', async () => {
    const fx = await setup('psdup');
    const res = await auth(
      request(server).put(`${base(fx.tenantId)}/payment-methods`),
      fx.owner,
    ).send({
      settings: [
        { context: 'NEW_BOOKING', method: 'CASH', enabled: false },
        { context: 'NEW_BOOKING', method: 'CASH', enabled: true },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('perubahan dicatat audit dan hanya terlihat pada tenant sendiri (RLS)', async () => {
    const a = await setup('psisoa');
    const b = await setup('psisob');

    const update = await auth(
      request(server).put(`${base(a.tenantId)}/payment-methods`),
      a.owner,
    ).send({ settings: [{ context: 'ADD_UNIT', method: 'BANK_TRANSFER', enabled: false }] });
    expect(update.status).toBe(200);

    const audit = await prisma.withTenant(a.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: a.tenantId, action: 'PAYMENT_METHOD_SETTINGS_UPDATED' },
      }),
    );
    expect(audit).toHaveLength(1);

    // RLS: konteks tenant B tidak melihat baris tenant A.
    const rowsA = await prisma.withTenant(a.tenantId, (tx) =>
      tx.tenantPaymentMethodSetting.findMany({ where: { tenantId: a.tenantId } }),
    );
    const rowsB = await prisma.withTenant(b.tenantId, (tx) =>
      tx.tenantPaymentMethodSetting.findMany({ where: { tenantId: a.tenantId } }),
    );
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(0);

    const crossRead = await auth(
      request(server).get(`${base(a.tenantId)}/payment-methods`),
      b.owner,
    );
    expect(crossRead.status).toBe(403);
    const crossWrite = await auth(
      request(server).put(`${base(a.tenantId)}/payment-methods`),
      b.owner,
    ).send({ settings: [{ context: 'ADD_UNIT', method: 'BANK_TRANSFER', enabled: true }] });
    expect(crossWrite.status).toBe(403);

    const bList = await auth(
      request(server).get(`${base(b.tenantId)}/payment-methods`),
      b.owner,
    );
    expect(bList.body.data.settings.every((row: { enabled: boolean }) => row.enabled)).toBe(true);
  });

  it('MANAGER boleh membaca tetapi tidak boleh mengubah tanpa permission khusus', async () => {
    const fx = await setup('psperm');
    const manager = await inviteManager(fx.owner, fx.tenantId, 'psperm-mgr');

    const read = await auth(
      request(server).get(`${base(fx.tenantId)}/payment-methods`),
      manager,
    );
    expect(read.status).toBe(200);

    const write = await auth(
      request(server).put(`${base(fx.tenantId)}/payment-methods`),
      manager,
    ).send({ settings: [{ context: 'ADD_UNIT', method: 'QRIS', enabled: false }] });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('PERMISSION_DENIED');
  });
});

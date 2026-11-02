/**
 * Integration test: subscription guard & restricted mode.
 *
 * Kontrak docs/openapi.yaml + dokumen 04/10:
 * - Trial 72 jam dari activatedAt; tanpa subscription aktif → restricted.
 * - Renewal gagal → grace 3 hari kalender; setelah grace → restricted.
 * - Restricted: 403 TENANT_RESTRICTED untuk booking/order/POS baru dan
 *   perubahan katalog/harga/inventaris.
 * - Tetap diizinkan: baca data, pembatalan reservasi, penyelesaian order aktif
 *   (serah-terima, pembayaran, return/inspection, refund/deposit).
 *
 * Berjalan terhadap PostgreSQL sewain_test dengan role runtime (RLS aktif).
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Server } from 'node:http';
import { Prisma } from '@rentalio/database';

import { AppModule } from '../../src/app.module.js';
import { HttpErrorFilter } from '../../src/common/http-error.filter.js';
import { EmailService } from '../../src/email/email.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const API = '/api/v1';
const PW = 'kata-sandi-subscription-guard-001';
const ORIGIN = 'http://localhost:3001';
const DAY = 24 * 3600 * 1000;

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

interface Actor {
  cookie: string;
  csrf: string;
  userId: string;
}
interface Fixture {
  owner: Actor;
  tenantId: string;
}

function auth(req: request.Test, actor: Actor): request.Test {
  return req.set('Cookie', actor.cookie).set('X-CSRF-Token', actor.csrf).set('Origin', ORIGIN);
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
  const login = await request(server).post(`${API}/auth/sessions`).send({
    email: emailAddr,
    password: PW,
  });
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

async function setupTenant(prefix: string): Promise<Fixture> {
  const owner = await registerAndLogin(em(prefix));
  const tenant = await auth(request(server).post(`${API}/tenants`), owner).send({
    name: `Tenant ${prefix}`,
    slug: slug(prefix),
  });
  if (tenant.status !== 201) throw new Error(JSON.stringify(tenant.body));
  return { owner, tenantId: tenant.body.data.id as string };
}

async function createQuantityProduct(fx: Fixture, name: string): Promise<string> {
  const product = await auth(
    request(server).post(`${base(fx.tenantId)}/products`),
    fx.owner,
  ).send({ name, stockMode: 'QUANTITY', capacity: 10 });
  if (product.status !== 201) throw new Error(JSON.stringify(product.body));
  const productId = product.body.data.id as string;
  const rate = await auth(
    request(server).post(`${base(fx.tenantId)}/products/${productId}/rates`),
    fx.owner,
  ).send({ perDayAmount: 50_000 });
  if (rate.status !== 200) throw new Error(JSON.stringify(rate.body));
  return productId;
}

async function setBookingMode(fx: Fixture, bookingMode: 'MANUAL' | 'AUTOMATIC'): Promise<void> {
  const res = await auth(
    request(server).patch(`${base(fx.tenantId)}/settings`),
    fx.owner,
  ).send({ bookingMode });
  if (res.status !== 204) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
}

async function createReservation(
  fx: Fixture,
  productId: string,
  startAt: string,
  endAt: string,
): Promise<{ status: number; id?: string; body: unknown }> {
  const res = await auth(request(server).post(`${base(fx.tenantId)}/reservations`), fx.owner).send({
    startAt,
    endAt,
    items: [{ productId, quantity: 1 }],
  });
  return { status: res.status, id: res.body?.data?.id as string | undefined, body: res.body };
}

/** Trial tenant (dan subscription trial bila ada) dibuat sudah berakhir. */
async function expireTrial(tenantId: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await prisma.withTenant(tenantId, async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { trialEndsAt: past } });
    await tx.subscription.updateMany({
      where: { tenantId },
      data: { trialEndsAt: past, status: 'TRIALING' },
    });
  });
}

type SubscriptionPatch = {
  status?: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'RESTRICTED' | 'CANCELLED' | 'EXPIRED';
  trialEndsAt?: Date | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  graceStartedAt?: Date | null;
  graceEndsAt?: Date | null;
};

/** Buat/perbarui subscription tenant (termasuk plan platform-wide bila belum ada). */
async function setSubscription(tenantId: string, patch: SubscriptionPatch): Promise<void> {
  await prisma.withTenant(tenantId, async (tx) => {
    let plan = await tx.plan.findFirst({ where: { tenantId: null, code: 'free' } });
    if (!plan) {
      plan = await tx.plan.create({ data: { code: 'free', name: 'Free' } });
    }
    const existing = await tx.subscription.findFirst({ where: { tenantId } });
    if (existing) {
      await tx.subscription.update({
        where: { id: existing.id },
        data: patch as Prisma.SubscriptionUncheckedUpdateInput,
      });
      return;
    }
    await tx.subscription.create({
      data: {
        tenantId,
        planId: plan.id,
        ...patch,
      } as Prisma.SubscriptionUncheckedCreateInput,
    });
  });
}

function expectRestricted(res: { status: number; body?: { error?: { code?: string } } }): void {
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expect(res.body?.error?.code).toBe('TENANT_RESTRICTED');
}

describe('Subscription guard — restricted mode', () => {
  it('trial aktif mengizinkan pembuatan katalog dan reservasi', async () => {
    const fx = await setupTenant('subactive');
    const productId = await createQuantityProduct(fx, 'Produk Aktif');
    expect(productId).toBeTruthy();

    const reservation = await createReservation(
      fx,
      productId,
      '2027-01-10T00:00:00.000Z',
      '2027-01-12T00:00:00.000Z',
    );
    expect(reservation.status, JSON.stringify(reservation.body)).toBe(201);
  });

  it('trial berakhir menolak transaksi baru dan perubahan katalog, tetapi baca & cancel tetap boleh', async () => {
    const fx = await setupTenant('subexpired');
    const productId = await createQuantityProduct(fx, 'Produk Expired');

    // Reservasi CONFIRMED sebelum trial habis (untuk uji konversi).
    await setBookingMode(fx, 'AUTOMATIC');
    const confirmed = await createReservation(
      fx,
      productId,
      '2027-02-01T00:00:00.000Z',
      '2027-02-03T00:00:00.000Z',
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);

    // Reservasi PENDING_APPROVAL sebelum trial habis (untuk uji confirm).
    await setBookingMode(fx, 'MANUAL');
    const pending = await createReservation(
      fx,
      productId,
      '2027-03-01T00:00:00.000Z',
      '2027-03-03T00:00:00.000Z',
    );
    expect(pending.status, JSON.stringify(pending.body)).toBe(201);

    await expireTrial(fx.tenantId);

    // Baca tetap tersedia.
    const list = await auth(request(server).get(`${base(fx.tenantId)}/products`), fx.owner);
    expect(list.status, JSON.stringify(list.body)).toBe(200);

    // Katalog/harga/inventaris baru ditolak.
    expectRestricted(
      await auth(request(server).post(`${base(fx.tenantId)}/products`), fx.owner).send({
        name: 'Produk Baru',
        stockMode: 'QUANTITY',
        capacity: 1,
      }),
    );
    expectRestricted(
      await auth(
        request(server).patch(`${base(fx.tenantId)}/products/${productId}`),
        fx.owner,
      ).send({ name: 'Produk Diubah' }),
    );
    expectRestricted(
      await auth(
        request(server).post(`${base(fx.tenantId)}/products/${productId}/rates`),
        fx.owner,
      ).send({ perDayAmount: 99_000 }),
    );
    expectRestricted(
      await auth(request(server).post(`${base(fx.tenantId)}/categories`), fx.owner).send({
        name: 'Kategori Baru',
      }),
    );

    // Booking baru & konfirmasi (menambah komitmen stok) ditolak.
    expectRestricted(
      await auth(request(server).post(`${base(fx.tenantId)}/reservations`), fx.owner).send({
        startAt: '2027-04-01T00:00:00.000Z',
        endAt: '2027-04-03T00:00:00.000Z',
        items: [{ productId, quantity: 1 }],
      }),
    );
    expectRestricted(
      await auth(
        request(server).post(`${base(fx.tenantId)}/reservations/${pending.id}/confirm`),
        fx.owner,
      ).send({}),
    );

    // Konversi reservasi yang sudah CONFIRMED juga membuat order baru.
    expectRestricted(
      await auth(
        request(server).post(
          `${base(fx.tenantId)}/reservations/${confirmed.id}/convert-to-order`,
        ),
        fx.owner,
      ).send({ reservationId: confirmed.id }),
    );

    // Pembatalan reservasi melepas komitmen — tetap diizinkan.
    const cancel = await auth(
      request(server).post(`${base(fx.tenantId)}/reservations/${confirmed.id}/cancel`),
      fx.owner,
    ).send({ reason: 'Trial berakhir, reservasi dibatalkan.' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
  });

  it('order aktif tetap dapat diselesaikan dan dibayar dalam restricted mode', async () => {
    const fx = await setupTenant('suborder');
    const productId = await createQuantityProduct(fx, 'Produk Order');
    await setBookingMode(fx, 'AUTOMATIC');
    const reservation = await createReservation(
      fx,
      productId,
      '2027-05-01T00:00:00.000Z',
      '2027-05-03T00:00:00.000Z',
    );
    expect(reservation.status, JSON.stringify(reservation.body)).toBe(201);
    const convert = await auth(
      request(server).post(
        `${base(fx.tenantId)}/reservations/${reservation.id}/convert-to-order`,
      ),
      fx.owner,
    );
    expect(convert.status, JSON.stringify(convert.body)).toBe(201);
    const orderId = convert.body.data.id as string;

    await expireTrial(fx.tenantId);

    // Order baru tetap ditolak (POST /orders alias konversi).
    expectRestricted(
      await auth(request(server).post(`${base(fx.tenantId)}/orders`), fx.owner).send({
        reservationId: reservation.id,
      }),
    );

    // Penyelesaian order aktif tetap diizinkan.
    const ready = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${orderId}/ready-for-handover`),
      fx.owner,
    ).send({});
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);

    // Rekonsiliasi pembayaran yang sudah ada tetap diizinkan.
    const payment = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${orderId}/payments`),
      fx.owner,
    ).send({ amount: '50000', currency: 'IDR', method: 'CASH', context: 'NEW_BOOKING' });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  });

  it('subscription ACTIVE mengembalikan akses transaksi setelah trial habis', async () => {
    const fx = await setupTenant('subpaid');
    await createQuantityProduct(fx, 'Produk Paid');
    await expireTrial(fx.tenantId);

    // Masih restricted sebelum subscription aktif.
    expectRestricted(
      await auth(request(server).post(`${base(fx.tenantId)}/products`), fx.owner).send({
        name: 'Sebelum Bayar',
        stockMode: 'QUANTITY',
        capacity: 1,
      }),
    );

    const now = new Date();
    await setSubscription(fx.tenantId, {
      status: 'ACTIVE',
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * DAY),
      graceStartedAt: null,
      graceEndsAt: null,
    });

    const allowed = await auth(
      request(server).post(`${base(fx.tenantId)}/products`),
      fx.owner,
    ).send({ name: 'Sesudah Bayar', stockMode: 'QUANTITY', capacity: 1 });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });

  it('PAST_DUE masih boleh selama grace, lalu ditolak setelah grace berakhir', async () => {
    const fx = await setupTenant('subgrace');
    await createQuantityProduct(fx, 'Produk Grace');
    await expireTrial(fx.tenantId);

    const now = new Date();
    await setSubscription(fx.tenantId, {
      status: 'PAST_DUE',
      periodStart: new Date(now.getTime() - 30 * DAY),
      periodEnd: now,
      graceStartedAt: now,
      graceEndsAt: new Date(now.getTime() + 2 * DAY),
    });

    const inGrace = await auth(
      request(server).post(`${base(fx.tenantId)}/products`),
      fx.owner,
    ).send({ name: 'Dalam Grace', stockMode: 'QUANTITY', capacity: 1 });
    expect(inGrace.status, JSON.stringify(inGrace.body)).toBe(201);

    await setSubscription(fx.tenantId, {
      graceEndsAt: new Date(now.getTime() - 60_000),
    });

    expectRestricted(
      await auth(request(server).post(`${base(fx.tenantId)}/products`), fx.owner).send({
        name: 'Setelah Grace',
        stockMode: 'QUANTITY',
        capacity: 1,
      }),
    );
  });
});

/**
 * Integration test: perpanjangan sewa & override konflik Opsi B (ADR-001 §8).
 *
 * Mencakup:
 * - pengajuan tidak mengubah periode/alokasi;
 * - Opsi A menolak approval saat konflik (409) dan menolak override (422);
 * - Opsi B menolak approval konflik tanpa override (409 + daftar konflik);
 * - override memerlukan permission `rental.extension.override_conflict`,
 *   alasan, dan riskConfirmed;
 * - override sukses membuat alokasi, flag order/booking, relasi tugas, audit,
 *   dan memperbarui periode/biaya dalam satu transaksi;
 * - retry Idempotency-Key mengembalikan hasil sama tanpa mutasi ganda;
 * - trigger PostgreSQL menolak overlap yang tidak tercatat (23P01);
 * - dua override paralel pada unit yang sama: tepat satu berhasil.
 *
 * Berjalan terhadap PostgreSQL sewain_test (migrasi dari nol, RLS aktif).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const PW = 'kata-sandi-extension-test-001';
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
  const login = await request(server)
    .post(`${API}/auth/sessions`)
    .send({ email: emailAddr, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const user = await prisma.client.user.findUnique({
    where: { email: emailAddr.toLowerCase() },
  });
  return { cookie: session.split(';')[0], csrf: login.headers['x-csrf-token'] as string, userId: user!.id };
}

function lastInviteToken(to: string): string {
  const sent = emailSvc.testAdapter!.sent;
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (sent[i].to.toLowerCase() === to.toLowerCase()) {
      const match = sent[i].body.match(/token=([A-Za-z0-9_-]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  }
  throw new Error(`Tidak ada token undangan untuk ${to}`);
}

async function inviteRole(
  owner: Actor,
  tenantId: string,
  prefix: string,
  role: 'MANAGER' | 'STAFF' | 'CASHIER',
): Promise<Actor> {
  const email = em(prefix);
  const invite = await auth(request(server).post(`${base(tenantId)}/members`), owner).send({
    email,
    role,
  });
  if (invite.status !== 201) throw new Error(`Gagal undang ${role}: ${JSON.stringify(invite.body)}`);
  const accept = await request(server)
    .post(`${API}/auth/invitations/accept`)
    .send({ token: lastInviteToken(email), password: PW });
  if (accept.status !== 200) throw new Error(`Gagal menerima undangan: ${JSON.stringify(accept.body)}`);
  return registerLoginExisting(email);
}

async function inviteManager(owner: Actor, tenantId: string, prefix: string): Promise<Actor> {
  return inviteRole(owner, tenantId, prefix, 'MANAGER');
}

async function registerLoginExisting(emailAddr: string): Promise<Actor> {
  const login = await request(server)
    .post(`${API}/auth/sessions`)
    .send({ email: emailAddr, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const user = await prisma.client.user.findUnique({
    where: { email: emailAddr.toLowerCase() },
  });
  return { cookie: session.split(';')[0], csrf: login.headers['x-csrf-token'] as string, userId: user!.id };
}

interface TenantFixture {
  owner: Actor;
  manager: Actor;
  tenantId: string;
  productId: string;
  assetId: string;
}

async function setupTenant(
  prefix: string,
  policy: 'CHECK_AVAILABILITY' | 'SKIP_AVAILABILITY',
): Promise<TenantFixture> {
  const owner = await registerAndLogin(em(prefix));
  const tenant = await auth(request(server).post(`${API}/tenants`), owner).send({
    name: `Tenant ${prefix}`,
    slug: slug(prefix),
  });
  if (tenant.status !== 201) throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.data.id as string;

  const settings = await auth(request(server).patch(`${base(tenantId)}/settings`), owner).send({
    bookingMode: 'AUTOMATIC',
    catalogPolicy: policy,
    rentalExtensionEnabled: true,
  });
  if (settings.status !== 204) throw new Error(`Gagal set settings: ${JSON.stringify(settings.body)}`);

  const product = await auth(request(server).post(`${base(tenantId)}/products`), owner).send({
    name: `Produk ${prefix}`,
    stockMode: 'INDIVIDUAL_UNITS',
  });
  if (product.status !== 201) throw new Error(`Gagal buat produk: ${JSON.stringify(product.body)}`);
  const productId = product.body.data.id as string;

  const asset = await auth(
    request(server).post(`${base(tenantId)}/products/${productId}/assets`),
    owner,
  ).send({ code: `UNIT-${uid(prefix)}` });
  if (asset.status !== 201) throw new Error(`Gagal buat unit: ${JSON.stringify(asset.body)}`);

  const rate = await auth(
    request(server).post(`${base(tenantId)}/products/${productId}/rates`),
    owner,
  ).send({ perDayAmount: 100_000 });
  if (rate.status !== 201 && rate.status !== 200) {
    throw new Error(`Gagal set rate: ${JSON.stringify(rate.body)}`);
  }

  const manager = await inviteManager(owner, tenantId, `${prefix}-mgr`);
  return { owner, manager, tenantId, productId, assetId: asset.body.data.id as string };
}

async function setupQuantityTenant(prefix: string): Promise<TenantFixture> {
  const owner = await registerAndLogin(em(prefix));
  const tenant = await auth(request(server).post(`${API}/tenants`), owner).send({
    name: `Tenant ${prefix}`,
    slug: slug(prefix),
  });
  if (tenant.status !== 201) throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.data.id as string;
  const settings = await auth(request(server).patch(`${base(tenantId)}/settings`), owner).send({
    bookingMode: 'AUTOMATIC',
    catalogPolicy: 'SKIP_AVAILABILITY',
    rentalExtensionEnabled: true,
  });
  if (settings.status !== 204) throw new Error(`Gagal set settings: ${JSON.stringify(settings.body)}`);

  const product = await auth(request(server).post(`${base(tenantId)}/products`), owner).send({
    name: `Produk ${prefix}`,
    stockMode: 'QUANTITY',
    capacity: 1,
  });
  if (product.status !== 201) throw new Error(`Gagal buat produk: ${JSON.stringify(product.body)}`);
  const productId = product.body.data.id as string;
  const rate = await auth(
    request(server).post(`${base(tenantId)}/products/${productId}/rates`),
    owner,
  ).send({ perDayAmount: 100_000 });
  if (rate.status !== 201 && rate.status !== 200) {
    throw new Error(`Gagal set rate: ${JSON.stringify(rate.body)}`);
  }
  const manager = await inviteManager(owner, tenantId, `${prefix}-mgr`);
  return { owner, manager, tenantId, productId, assetId: '' };
}

async function createActiveOrder(
  fx: TenantFixture,
  startAt: string,
  endAt: string,
): Promise<{ orderId: string; reservationId: string; totalAmount: string }> {
  const reservation = await auth(
    request(server).post(`${base(fx.tenantId)}/reservations`),
    fx.owner,
  ).send({ startAt, endAt, items: [{ productId: fx.productId, quantity: 1 }] });
  if (reservation.status !== 201) {
    throw new Error(`Gagal buat reservasi: ${JSON.stringify(reservation.body)}`);
  }
  expect(reservation.body.data.status).toBe('CONFIRMED');
  const reservationId = reservation.body.data.id as string;

  const convert = await auth(
    request(server).post(`${base(fx.tenantId)}/reservations/${reservationId}/convert-to-order`),
    fx.owner,
  );
  if (convert.status !== 201) throw new Error(`Gagal konversi: ${JSON.stringify(convert.body)}`);
  const orderId = convert.body.data.id as string;

  const ready = await auth(
    request(server).post(`${base(fx.tenantId)}/orders/${orderId}/ready-for-handover`),
    fx.owner,
  ).send({});
  expect(ready.status).toBe(200);
  const handover = await auth(
    request(server).post(`${base(fx.tenantId)}/orders/${orderId}/handover`),
    fx.owner,
  ).send({});
  expect(handover.status).toBe(200);
  expect(handover.body.data.status).toBe('ACTIVE');

  return {
    orderId,
    reservationId,
    totalAmount: convert.body.data.totalAmount as string,
  };
}

async function requestExtension(
  fx: TenantFixture,
  orderId: string,
  requestedEndAt: string,
  actor: Actor = fx.owner,
) {
  return auth(
    request(server).post(`${base(fx.tenantId)}/orders/${orderId}/extensions`),
    actor,
  ).send({ requestedEndAt });
}

async function getOrder(fx: TenantFixture, orderId: string) {
  const res = await auth(
    request(server).get(`${base(fx.tenantId)}/orders/${orderId}`),
    fx.owner,
  );
  expect(res.status).toBe(200);
  return res.body.data;
}

// ============================================================
// Opsi B — alur utama
// ============================================================

describe('Perpanjangan sewa — Opsi B & override konflik', () => {
  it('pengajuan tidak mengubah periode; approval konflik butuh override; override sukses atomik', async () => {
    const fx = await setupTenant('extb', 'SKIP_AVAILABILITY');
    const current = await createActiveOrder(fx, '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    const conflicting = await createActiveOrder(
      fx,
      '2026-11-03T00:00:00.000Z',
      '2026-11-05T00:00:00.000Z',
    );

    const requested = await requestExtension(fx, current.orderId, '2026-11-04T00:00:00.000Z');
    expect(requested.status).toBe(201);
    expect(requested.body.data.status).toBe('PENDING_APPROVAL');
    expect(requested.body.data.previousEndAt).toBe('2026-11-03T00:00:00.000Z');
    expect(requested.body.data.requestedEndAt).toBe('2026-11-04T00:00:00.000Z');
    expect(requested.body.data.amount).toBe('100000');
    const extensionId = requested.body.data.id as string;

    // Pengajuan tidak mengubah order/periode/alokasi.
    const orderBefore = await getOrder(fx, current.orderId);
    expect(orderBefore.items[0].endAt).toBe('2026-11-03T00:00:00.000Z');
    expect(orderBefore.totalAmount).toBe(current.totalAmount);
    expect(orderBefore.hasOpenConflict).toBe(false);

    // Tanpa override: 409 + daftar konflik yang dihitung server.
    const approve = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/approve`,
      ),
      fx.owner,
    ).send({});
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('AVAILABILITY_CONFLICT');
    expect(approve.body.error.details.requiresOverride).toBe(true);
    expect(approve.body.error.details.conflicts).toHaveLength(1);
    expect(approve.body.error.details.conflicts[0]).toMatchObject({
      reservationId: conflicting.reservationId,
      assetId: fx.assetId,
      reason: 'ASSET_OVERLAP',
    });

    // Konfirmasi risiko wajib.
    const noRisk = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/override-conflict`,
      ),
      fx.owner,
    ).send({ reason: 'Pelanggan memperpanjang, unit lain menyusul', riskConfirmed: false });
    expect(noRisk.status).toBe(422);
    expect(noRisk.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    // Permission override tidak otomatis untuk MANAGER.
    const managerOverride = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/override-conflict`,
      ),
      fx.manager,
    ).send({ reason: 'Coba override oleh manager', riskConfirmed: true });
    expect(managerOverride.status).toBe(403);
    expect(managerOverride.body.error.code).toBe('PERMISSION_DENIED');

    // override + Idempotency-Key.
    const key = `ovr-${randomUUID()}`;
    const override = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/override-conflict`,
      ).set('Idempotency-Key', key),
      fx.owner,
    ).send({ reason: 'Pelanggan memperpanjang, unit lain menyusul', riskConfirmed: true });
    expect(override.status).toBe(200);
    expect(override.body.data.status).toBe('APPROVED');
    expect(override.body.data.override).toMatchObject({
      policy: 'SKIP_AVAILABILITY',
      conflictCount: 1,
    });
    expect(override.body.data.operationalTasks).toHaveLength(1);
    expect(override.body.data.operationalTasks[0].status).toBe('OPEN');

    // Order/periode/biaya berubah bersama alokasi.
    const orderAfter = await getOrder(fx, current.orderId);
    expect(orderAfter.items[0].endAt).toBe('2026-11-04T00:00:00.000Z');
    expect(orderAfter.totalAmount).toBe('300000'); // 200.000 + 100.000 (1 hari)
    expect(orderAfter.hasOpenConflict).toBe(true);

    // Booking terdampak ditandai tanpa perubahan lifecycle.
    const affected = await auth(
      request(server).get(`${base(fx.tenantId)}/reservations/${conflicting.reservationId}`),
      fx.owner,
    );
    expect(affected.body.data.hasOpenConflict).toBe(true);
    expect(affected.body.data.status).toBe('CONVERTED_TO_ORDER');
    const affectedOrder = await getOrder(fx, conflicting.orderId);
    expect(affectedOrder.hasOpenConflict).toBe(true);
    expect(affectedOrder.status).toBe('ACTIVE');

    // Alokasi periode tambahan bertanda override.
    const allocations = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.reservationAllocation.findMany({
        where: { tenantId: fx.tenantId, extensionId },
      }),
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0].overrideId).not.toBeNull();
    expect(allocations[0].startAt.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(allocations[0].endAt.toISOString()).toBe('2026-11-04T00:00:00.000Z');

    // Audit override menyimpan alasan, policy, periode, biaya, dan konflik.
    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: fx.tenantId, action: 'ORDER_EXTENSION_CONFLICT_OVERRIDDEN' },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe('Pelanggan memperpanjang, unit lain menyusul');
    expect(audits[0].metadata).toMatchObject({
      policy: 'SKIP_AVAILABILITY',
      riskAcknowledged: true,
    });

    // Replay idempotent: hasil sama, tidak menambah alokasi/audit.
    const replay = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/override-conflict`,
      ).set('Idempotency-Key', key),
      fx.owner,
    ).send({ reason: 'Pelanggan memperpanjang, unit lain menyusul', riskConfirmed: true });
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(extensionId);

    const allocationCount = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.reservationAllocation.count({ where: { tenantId: fx.tenantId, extensionId } }),
    );
    expect(allocationCount).toBe(1);
    const auditCount = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({
        where: { tenantId: fx.tenantId, action: 'ORDER_EXTENSION_CONFLICT_OVERRIDDEN' },
      }),
    );
    expect(auditCount).toBe(1);

    // Enforcement PostgreSQL: alokasi normal yang overlap dengan alokasi
    // override ditolak (23P01) walau tanpa melalui service.
    const bluntReservationId = randomUUID();
    await prisma.withTenant(fx.tenantId, (tx) =>
      tx.reservation.create({
        data: {
          id: bluntReservationId,
          tenantId: fx.tenantId,
          status: 'CONFIRMED',
          bookingMode: 'AUTOMATIC',
          startAt: new Date('2026-11-03T12:00:00.000Z'),
          endAt: new Date('2026-11-03T18:00:00.000Z'),
        },
      }),
    );
    await expect(
      prisma.withTenant(fx.tenantId, (tx) =>
        tx.reservationAllocation.create({
          data: {
            tenantId: fx.tenantId,
            productId: fx.productId,
            assetId: fx.assetId,
            reservationId: bluntReservationId,
            quantity: 1,
            startAt: new Date('2026-11-03T12:00:00.000Z'),
            endAt: new Date('2026-11-03T18:00:00.000Z'),
            status: 'ACTIVE',
          },
        }),
      ),
    ).rejects.toThrow(/23P01|bertabrakan/i);
  });
});

// ============================================================
// Opsi A
// ============================================================

describe('Perpanjangan sewa — Opsi A', () => {
  it('approval konflik ditolak dan override tidak berlaku untuk Opsi A', async () => {
    const fx = await setupTenant('exta', 'CHECK_AVAILABILITY');
    const current = await createActiveOrder(fx, '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    await createActiveOrder(fx, '2026-11-03T00:00:00.000Z', '2026-11-05T00:00:00.000Z');

    const requested = await requestExtension(fx, current.orderId, '2026-11-04T00:00:00.000Z');
    expect(requested.status).toBe(201);
    const extensionId = requested.body.data.id as string;

    const approve = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/approve`,
      ),
      fx.owner,
    ).send({});
    expect(approve.status).toBe(409);
    expect(approve.body.error.details.policy).toBe('CHECK_AVAILABILITY');
    expect(approve.body.error.details.requiresOverride).toBe(false);

    const override = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/override-conflict`,
      ),
      fx.owner,
    ).send({ reason: 'Tidak boleh untuk opsi A', riskConfirmed: true });
    expect(override.status).toBe(422);
    expect(override.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    const unchanged = await getOrder(fx, current.orderId);
    expect(unchanged.items[0].endAt).toBe('2026-11-03T00:00:00.000Z');
    expect(unchanged.hasOpenConflict).toBe(false);
  });
});

// ============================================================
// Stok kuantitas — kapasitas puncak
// ============================================================

describe('Perpanjangan sewa — kapasitas kuantitas', () => {
  it('override mencatat konflik kapasitas; trigger menolak alokasi normal yang melampaui kapasitas', async () => {
    const fx = await setupQuantityTenant('extqty');
    const current = await createActiveOrder(fx, '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    await createActiveOrder(fx, '2026-11-03T00:00:00.000Z', '2026-11-05T00:00:00.000Z');

    const requested = await requestExtension(fx, current.orderId, '2026-11-04T00:00:00.000Z');
    expect(requested.status).toBe(201);
    const extensionId = requested.body.data.id as string;

    const approve = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/approve`,
      ),
      fx.owner,
    ).send({});
    expect(approve.status).toBe(409);
    expect(approve.body.error.details.conflicts[0].reason).toBe('CAPACITY_EXCEEDED');

    const override = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/override-conflict`,
      ),
      fx.owner,
    ).send({ reason: 'Stok unit tambahan menyusul', riskConfirmed: true });
    expect(override.status).toBe(200);
    expect(override.body.data.override.conflictCount).toBe(1);

    // Alokasi normal pada rentang yang sama ditolak trigger kapasitas.
    const bluntReservationId = randomUUID();
    await prisma.withTenant(fx.tenantId, (tx) =>
      tx.reservation.create({
        data: {
          id: bluntReservationId,
          tenantId: fx.tenantId,
          status: 'CONFIRMED',
          bookingMode: 'AUTOMATIC',
          startAt: new Date('2026-11-03T12:00:00.000Z'),
          endAt: new Date('2026-11-04T00:00:00.000Z'),
        },
      }),
    );
    await expect(
      prisma.withTenant(fx.tenantId, (tx) =>
        tx.reservationAllocation.create({
          data: {
            tenantId: fx.tenantId,
            productId: fx.productId,
            reservationId: bluntReservationId,
            quantity: 1,
            startAt: new Date('2026-11-03T12:00:00.000Z'),
            endAt: new Date('2026-11-04T00:00:00.000Z'),
            status: 'ACTIVE',
          },
        }),
      ),
    ).rejects.toThrow(/23P01|bertabrakan|kapasitas/i);
  });
});

// ============================================================
// Concurrency
// ============================================================

describe('Perpanjangan sewa — concurrency override', () => {
  it('dua override paralel pada unit yang sama: tepat satu berhasil, tanpa state menggantung', async () => {
    const fx = await setupTenant('extpar', 'SKIP_AVAILABILITY');
    const first = await createActiveOrder(fx, '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    const second = await createActiveOrder(fx, '2026-11-03T00:00:00.000Z', '2026-11-05T00:00:00.000Z');
    await createActiveOrder(fx, '2026-11-05T00:00:00.000Z', '2026-11-07T00:00:00.000Z');

    const firstRequest = await requestExtension(fx, first.orderId, '2026-11-06T00:00:00.000Z');
    const secondRequest = await requestExtension(fx, second.orderId, '2026-11-06T00:00:00.000Z');
    expect(firstRequest.status).toBe(201);
    expect(secondRequest.status).toBe(201);
    const firstExtensionId = firstRequest.body.data.id as string;
    const secondExtensionId = secondRequest.body.data.id as string;

    const call = (orderId: string, extensionId: string, tag: string) =>
      auth(
        request(server).post(
          `${base(fx.tenantId)}/orders/${orderId}/extensions/${extensionId}/override-conflict`,
        ).set('Idempotency-Key', `par-${tag}-${randomUUID()}`),
        fx.owner,
      ).send({ reason: `Override paralel ${tag}`, riskConfirmed: true });

    const [a, b] = await Promise.all([
      call(first.orderId, firstExtensionId, 'a'),
      call(second.orderId, secondExtensionId, 'b'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const failed = a.status === 409 ? a : b;
    expect(failed.body.error.code).toBe('AVAILABILITY_CONFLICT');

    const overrides = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.extensionOverride.findMany({ where: { tenantId: fx.tenantId } }),
    );
    expect(overrides).toHaveLength(1);
    const allocations = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.reservationAllocation.findMany({
        where: { tenantId: fx.tenantId, overrideId: { not: null } },
      }),
    );
    expect(allocations).toHaveLength(1);

    // Extension yang kalah tetap PENDING dan tidak punya relasi konflik.
    const loserId = failed === a ? firstExtensionId : secondExtensionId;
    const loser = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.orderExtension.findUniqueOrThrow({ where: { tenantId_id: { tenantId: fx.tenantId, id: loserId } } }),
    );
    expect(loser.status).toBe('PENDING_APPROVAL');
    const loserConflicts = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.extensionConflict.count({ where: { tenantId: fx.tenantId, extensionId: loserId } }),
    );
    expect(loserConflicts).toBe(0);
  }, 60_000);
});

// ============================================================
// Konkurensi PostgreSQL & rollback atomik
// ============================================================

/**
 * Snapshot state yang ditulis command override SEBELUM alokasi dibuat.
 * Dipakai untuk membuktikan transaksi yang gagal tidak meninggalkan jejak.
 */
async function overrideTrace(fx: TenantFixture, extensionId: string) {
  return prisma.withTenant(fx.tenantId, async (tx) => ({
    extension: await tx.orderExtension.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: fx.tenantId, id: extensionId } },
    }),
    overrides: await tx.extensionOverride.count({ where: { tenantId: fx.tenantId, extensionId } }),
    conflicts: await tx.extensionConflict.count({ where: { tenantId: fx.tenantId, extensionId } }),
    allocations: await tx.reservationAllocation.count({
      where: { tenantId: fx.tenantId, extensionId },
    }),
    overrideAudits: await tx.auditLog.count({
      where: { tenantId: fx.tenantId, action: 'ORDER_EXTENSION_CONFLICT_OVERRIDDEN' },
    }),
  }));
}

function postOverride(
  fx: TenantFixture,
  orderId: string,
  extensionId: string,
  reason: string,
  key?: string,
) {
  const req = request(server)
    .post(`${base(fx.tenantId)}/orders/${orderId}/extensions/${extensionId}/override-conflict`)
    .set('Origin', ORIGIN)
    .set('Cookie', fx.owner.cookie)
    .set('X-CSRF-Token', fx.owner.csrf);
  if (key) req.set('Idempotency-Key', key);
  return req.send({ reason, riskConfirmed: true });
}

describe('Perpanjangan sewa — unit fisik: konkurensi & rollback', () => {
  it('dua override paralel untuk extension yang sama: satu 200, satu 409, tanpa mutasi ganda', async () => {
    const fx = await setupTenant('extsame', 'SKIP_AVAILABILITY');
    const current = await createActiveOrder(
      fx,
      '2026-11-01T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    );
    await createActiveOrder(fx, '2026-11-03T00:00:00.000Z', '2026-11-05T00:00:00.000Z');

    const requested = await requestExtension(fx, current.orderId, '2026-11-04T00:00:00.000Z');
    expect(requested.status).toBe(201);
    const extensionId = requested.body.data.id as string;

    // Dua command untuk extension yang SAMA, key idempotensi berbeda:
    // unique index extensionId memaksa tepat satu keputusan tersimpan.
    const [a, b] = await Promise.all([
      postOverride(fx, current.orderId, extensionId, 'Override paralel A', `same-a-${randomUUID()}`),
      postOverride(fx, current.orderId, extensionId, 'Override paralel B', `same-b-${randomUUID()}`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const failed = a.status === 409 ? a : b;
    expect(failed.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const trace = await overrideTrace(fx, extensionId);
    expect(trace.extension.status).toBe('APPROVED');
    expect(trace.overrides).toBe(1);
    expect(trace.conflicts).toBe(1);
    expect(trace.allocations).toBe(1);
    expect(trace.overrideAudits).toBe(1);

    // Biaya hanya ditambahkan sekali (200.000 + 100.000 satu hari).
    const order = await getOrder(fx, current.orderId);
    expect(order.totalAmount).toBe('300000');
  }, 60_000);

  it('keputusan override yang sudah tersimpan → 409 INVALID_STATE_TRANSITION, bukan 500', async () => {
    const fx = await setupTenant('extdup', 'SKIP_AVAILABILITY');
    const current = await createActiveOrder(
      fx,
      '2026-11-01T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    );
    await createActiveOrder(fx, '2026-11-03T00:00:00.000Z', '2026-11-05T00:00:00.000Z');

    const requested = await requestExtension(fx, current.orderId, '2026-11-04T00:00:00.000Z');
    expect(requested.status).toBe(201);
    const extensionId = requested.body.data.id as string;

    // Sisa balapan dua command: baris override sudah ada (unique index
    // extensionId) sementara extension masih PENDING. Command berikutnya
    // harus memetakan pelanggaran unique itu ke 409, bukan 500.
    await prisma.withTenant(fx.tenantId, (tx) =>
      tx.extensionOverride.create({
        data: {
          tenantId: fx.tenantId,
          extensionId,
          orderId: current.orderId,
          policy: 'SKIP_AVAILABILITY',
          reason: 'Keputusan paralel yang sudah tersimpan',
          riskAcknowledgedAt: new Date(),
          actorUserId: fx.owner.userId,
          previousEndAt: new Date('2026-11-03T00:00:00.000Z'),
          requestedEndAt: new Date('2026-11-04T00:00:00.000Z'),
          amountSnapshot: 100_000n,
          currency: 'IDR',
          conflictCount: 1,
        },
      }),
    );

    const res = await postOverride(
      fx,
      current.orderId,
      extensionId,
      'Percobaan kedua setelah keputusan tersimpan',
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');

    // Tidak ada mutasi tambahan: konflik, alokasi, audit, dan biaya tetap.
    const trace = await overrideTrace(fx, extensionId);
    expect(trace.overrides).toBe(1);
    expect(trace.conflicts).toBe(0);
    expect(trace.allocations).toBe(0);
    expect(trace.overrideAudits).toBe(0);
    expect((await getOrder(fx, current.orderId)).totalAmount).toBe(current.totalAmount);
  }, 60_000);

  it('override yang ditolak trigger tidak meninggalkan jejak (rollback atomik)', async () => {
    const fx = await setupTenant('extrb', 'SKIP_AVAILABILITY');
    const first = await createActiveOrder(
      fx,
      '2026-11-01T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    );
    const second = await createActiveOrder(
      fx,
      '2026-11-03T00:00:00.000Z',
      '2026-11-05T00:00:00.000Z',
    );

    // Override pertama sukses dan meninggalkan alokasi override di unit ini.
    const firstRequest = await requestExtension(fx, first.orderId, '2026-11-06T00:00:00.000Z');
    expect(firstRequest.status).toBe(201);
    const winner = await postOverride(
      fx,
      first.orderId,
      firstRequest.body.data.id as string,
      'Override pertama pada unit yang sama',
    );
    expect(winner.status).toBe(200);

    const before = await getOrder(fx, second.orderId);
    expect(before.hasOpenConflict).toBe(true);

    const secondRequest = await requestExtension(fx, second.orderId, '2026-11-09T00:00:00.000Z');
    expect(secondRequest.status).toBe(201);
    const secondExtensionId = secondRequest.body.data.id as string;

    // Trigger menolak karena alokasi override lain sudah menempati rentang ini.
    const rejected = await postOverride(
      fx,
      second.orderId,
      secondExtensionId,
      'Override kedua yang harus ditolak',
    );
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('AVAILABILITY_CONFLICT');

    // Seluruh tulisan sebelum kegagalan harus di-rollback.
    const trace = await overrideTrace(fx, secondExtensionId);
    expect(trace.extension.status).toBe('PENDING_APPROVAL');
    expect(trace.extension.decidedAt).toBeNull();
    expect(trace.extension.decisionReason).toBeNull();
    expect(trace.overrides).toBe(0);
    expect(trace.conflicts).toBe(0);
    expect(trace.allocations).toBe(0);
    // Hanya audit override pertama yang tercatat.
    expect(trace.overrideAudits).toBe(1);

    const after = await getOrder(fx, second.orderId);
    expect(after.totalAmount).toBe(before.totalAmount);
    expect(after.items[0].endAt).toBe(before.items[0].endAt);
    expect(after.hasOpenConflict).toBe(true);
  }, 90_000);
});

describe('Perpanjangan sewa — stok kuantitas: konkurensi & rollback', () => {
  it('dua override paralel pada produk berkapasitas 1: tepat satu lolos', async () => {
    const fx = await setupQuantityTenant('extqpar');
    const first = await createActiveOrder(
      fx,
      '2026-11-01T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    );
    const second = await createActiveOrder(
      fx,
      '2026-11-03T00:00:00.000Z',
      '2026-11-05T00:00:00.000Z',
    );
    // Booking ketiga menjamin kedua extension punya konflik normal
    // (tidak bergantung pada override lawan yang belum commit).
    await createActiveOrder(fx, '2026-11-05T00:00:00.000Z', '2026-11-07T00:00:00.000Z');

    const firstRequest = await requestExtension(fx, first.orderId, '2026-11-06T00:00:00.000Z');
    const secondRequest = await requestExtension(fx, second.orderId, '2026-11-09T00:00:00.000Z');
    expect(firstRequest.status).toBe(201);
    expect(secondRequest.status).toBe(201);
    const firstExtensionId = firstRequest.body.data.id as string;
    const secondExtensionId = secondRequest.body.data.id as string;

    const beforeFirst = await getOrder(fx, first.orderId);
    const beforeSecond = await getOrder(fx, second.orderId);

    const [a, b] = await Promise.all([
      postOverride(fx, first.orderId, firstExtensionId, 'Override kuantitas A'),
      postOverride(fx, second.orderId, secondExtensionId, 'Override kuantitas B'),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winnerIsFirst = a.status === 200;
    const failed = winnerIsFirst ? b : a;
    expect(failed.body.error.code).toBe('AVAILABILITY_CONFLICT');

    const winnerExtensionId = winnerIsFirst ? firstExtensionId : secondExtensionId;
    const loserExtensionId = winnerIsFirst ? secondExtensionId : firstExtensionId;

    const winnerTrace = await overrideTrace(fx, winnerExtensionId);
    expect(winnerTrace.extension.status).toBe('APPROVED');
    expect(winnerTrace.overrides).toBe(1);
    expect(winnerTrace.allocations).toBe(1);
    expect(winnerTrace.overrideAudits).toBe(1);

    const loserTrace = await overrideTrace(fx, loserExtensionId);
    expect(loserTrace.extension.status).toBe('PENDING_APPROVAL');
    expect(loserTrace.overrides).toBe(0);
    expect(loserTrace.conflicts).toBe(0);
    expect(loserTrace.allocations).toBe(0);

    // Order pemenang bertambah tepat sekali; order yang kalah tidak berubah.
    const afterFirst = await getOrder(fx, first.orderId);
    const afterSecond = await getOrder(fx, second.orderId);
    if (winnerIsFirst) {
      expect(afterFirst.totalAmount).toBe('500000'); // 200.000 + 3 hari × 100.000
      expect(afterSecond.totalAmount).toBe(beforeSecond.totalAmount);
      expect(afterSecond.items[0].endAt).toBe(beforeSecond.items[0].endAt);
    } else {
      expect(afterSecond.totalAmount).toBe('600000'); // 200.000 + 4 hari × 100.000
      expect(afterFirst.totalAmount).toBe(beforeFirst.totalAmount);
      expect(afterFirst.items[0].endAt).toBe(beforeFirst.items[0].endAt);
    }
  }, 90_000);

  it('override yang ditolak trigger kapasitas tidak meninggalkan jejak (rollback atomik)', async () => {
    const fx = await setupQuantityTenant('extqrb');
    const first = await createActiveOrder(
      fx,
      '2026-11-01T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    );
    const second = await createActiveOrder(
      fx,
      '2026-11-03T00:00:00.000Z',
      '2026-11-05T00:00:00.000Z',
    );
    await createActiveOrder(fx, '2026-11-05T00:00:00.000Z', '2026-11-07T00:00:00.000Z');

    const firstRequest = await requestExtension(fx, first.orderId, '2026-11-06T00:00:00.000Z');
    expect(firstRequest.status).toBe(201);
    const winner = await postOverride(
      fx,
      first.orderId,
      firstRequest.body.data.id as string,
      'Override kapasitas pertama',
    );
    expect(winner.status).toBe(200);

    const before = await getOrder(fx, second.orderId);
    const secondRequest = await requestExtension(fx, second.orderId, '2026-11-09T00:00:00.000Z');
    expect(secondRequest.status).toBe(201);
    const secondExtensionId = secondRequest.body.data.id as string;

    const rejected = await postOverride(
      fx,
      second.orderId,
      secondExtensionId,
      'Override kapasitas kedua yang harus ditolak',
    );
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('AVAILABILITY_CONFLICT');

    const trace = await overrideTrace(fx, secondExtensionId);
    expect(trace.extension.status).toBe('PENDING_APPROVAL');
    expect(trace.extension.decidedAt).toBeNull();
    expect(trace.overrides).toBe(0);
    expect(trace.conflicts).toBe(0);
    expect(trace.allocations).toBe(0);
    expect(trace.overrideAudits).toBe(1);

    const after = await getOrder(fx, second.orderId);
    expect(after.totalAmount).toBe(before.totalAmount);
    expect(after.items[0].endAt).toBe(before.items[0].endAt);
    expect(after.hasOpenConflict).toBe(true);
  }, 90_000);
});

// ============================================================
// Ringkasan operasional konflik
// ============================================================

describe('Ringkasan konflik perpanjangan', () => {
  it('menampilkan order & reservasi ber-flag beserta detail konflik', async () => {
    const fx = await setupTenant('extdash', 'SKIP_AVAILABILITY');
    const current = await createActiveOrder(
      fx,
      '2026-12-01T00:00:00.000Z',
      '2026-12-03T00:00:00.000Z',
    );
    const conflicting = await createActiveOrder(
      fx,
      '2026-12-03T00:00:00.000Z',
      '2026-12-05T00:00:00.000Z',
    );
    const requested = await requestExtension(fx, current.orderId, '2026-12-04T00:00:00.000Z');
    expect(requested.status).toBe(201);
    const extensionId = requested.body.data.id as string;
    const override = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/override-conflict`,
      ),
      fx.owner,
    ).send({ reason: 'Unit pengganti disiapkan', riskConfirmed: true });
    expect(override.status).toBe(200);

    const overview = await auth(
      request(server).get(`${base(fx.tenantId)}/extension-conflicts`),
      fx.owner,
    );
    expect(overview.status).toBe(200);
    const data = overview.body.data;
    expect(data.filter).toBe('OPEN');
    expect(data.summary).toMatchObject({
      openConflicts: 1,
      resolvedConflicts: 0,
      flaggedOrders: 2,
      flaggedReservations: 1,
    });

    const flaggedOrder = data.orders.find((order: { id: string }) => order.id === current.orderId);
    expect(flaggedOrder).toMatchObject({
      status: 'ACTIVE',
      hasOpenConflict: true,
      openConflictCount: 1,
      totalAmount: '300000',
    });
    expect(flaggedOrder.conflicts).toHaveLength(1);
    expect(flaggedOrder.conflicts[0].extension).toMatchObject({
      id: extensionId,
      status: 'APPROVED',
      requestedEndAt: '2026-12-04T00:00:00.000Z',
      overrideReason: 'Unit pengganti disiapkan',
    });
    expect(flaggedOrder.conflicts[0].summary).toMatchObject({
      reservationId: conflicting.reservationId,
      assetId: fx.assetId,
      reason: 'ASSET_OVERLAP',
      startAt: '2026-12-03T00:00:00.000Z',
      endAt: '2026-12-05T00:00:00.000Z',
    });

    const affectedOrder = data.orders.find(
      (order: { id: string }) => order.id === conflicting.orderId,
    );
    expect(affectedOrder.hasOpenConflict).toBe(true);
    expect(affectedOrder.conflicts).toHaveLength(1);
    expect(data.reservations).toHaveLength(1);
    expect(data.reservations[0]).toMatchObject({
      id: conflicting.reservationId,
      status: 'CONVERTED_TO_ORDER',
      hasOpenConflict: true,
      openConflictCount: 1,
    });

    // Data dilindungi sesi + permission.
    const anonymous = await request(server).get(`${base(fx.tenantId)}/extension-conflicts`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    const outsider = await registerAndLogin(em('extdash-outsider'));
    const denied = await auth(
      request(server).get(`${base(fx.tenantId)}/extension-conflicts`),
      outsider,
    );
    expect(denied.status).toBe(403);
  }, 60_000);
});

// ============================================================
// Penyelesaian konflik & pembersihan flag
// ============================================================

describe('Penyelesaian konflik perpanjangan', () => {
  it('menandai konflik selesai dan membersihkan flag hanya setelah semua konflik order selesai', async () => {
    const fx = await setupTenant('extres', 'SKIP_AVAILABILITY');
    const staff = await inviteRole(fx.owner, fx.tenantId, 'extres-staff', 'STAFF');
    const current = await createActiveOrder(
      fx,
      '2026-12-01T00:00:00.000Z',
      '2026-12-03T00:00:00.000Z',
    );
    const second = await createActiveOrder(
      fx,
      '2026-12-03T00:00:00.000Z',
      '2026-12-05T00:00:00.000Z',
    );
    const third = await createActiveOrder(
      fx,
      '2026-12-05T00:00:00.000Z',
      '2026-12-07T00:00:00.000Z',
    );

    const requested = await requestExtension(fx, current.orderId, '2026-12-08T00:00:00.000Z');
    expect(requested.status).toBe(201);
    const extensionId = requested.body.data.id as string;
    const override = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/override-conflict`,
      ),
      fx.owner,
    ).send({ reason: 'Dua unit menyusul', riskConfirmed: true });
    expect(override.status).toBe(200);
    expect(override.body.data.operationalTasks).toHaveLength(2);

    const taskFor = (reservationId: string) =>
      override.body.data.operationalTasks.find(
        (task: { conflictingReservationId: string }) =>
          task.conflictingReservationId === reservationId,
      );
    const secondTask = taskFor(second.reservationId);
    const thirdTask = taskFor(third.reservationId);
    expect(secondTask).toBeTruthy();
    expect(thirdTask).toBeTruthy();

    const resolvePath = (task: { id: string }) =>
      `${base(fx.tenantId)}/orders/${current.orderId}/extensions/${extensionId}/conflicts/${task.id}/resolve`;

    // Permission: STAFF tidak memiliki `rental.extension.resolve_conflict`.
    const staffDenied = await auth(
      request(server).post(resolvePath(secondTask)),
      staff,
    ).send({ resolutionNote: 'Coba selesaikan oleh staff' });
    expect(staffDenied.status).toBe(403);
    expect(staffDenied.body.error.code).toBe('PERMISSION_DENIED');

    // Origin lintas situs yang tidak di allowlist tetap ditolak.
    const crossOrigin = await request(server)
      .post(resolvePath(secondTask))
      .set('Cookie', fx.owner.cookie)
      .set('X-CSRF-Token', fx.owner.csrf)
      .set('Origin', 'http://evil.example')
      .send({ resolutionNote: 'Coba dari origin asing' });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    // Origin allowlist + CSRF valid → konflik pertama selesai.
    const firstResolve = await auth(
      request(server).post(resolvePath(secondTask)),
      fx.owner,
    ).send({ resolutionNote: 'Unit pengganti untuk booking kedua sudah siap' });
    expect(firstResolve.status).toBe(200);
    expect(firstResolve.body.data.conflict.status).toBe('RESOLVED');
    expect(firstResolve.body.data.openConflictsRemaining).toBe(1);
    expect(firstResolve.body.data.hasOpenConflict.orders).toEqual(
      expect.arrayContaining([
        { id: current.orderId, hasOpenConflict: true, openConflicts: 1 },
        { id: second.orderId, hasOpenConflict: false, openConflicts: 0 },
      ]),
    );
    expect(firstResolve.body.data.hasOpenConflict.reservation).toMatchObject({
      id: second.reservationId,
      hasOpenConflict: false,
    });

    // Flag belum boleh bersih selama masih ada konflik OPEN pada order.
    expect((await getOrder(fx, current.orderId)).hasOpenConflict).toBe(true);
    expect((await getOrder(fx, second.orderId)).hasOpenConflict).toBe(false);
    expect((await getOrder(fx, third.orderId)).hasOpenConflict).toBe(true);
    const thirdReservationBefore = await auth(
      request(server).get(`${base(fx.tenantId)}/reservations/${third.reservationId}`),
      fx.owner,
    );
    expect(thirdReservationBefore.body.data.hasOpenConflict).toBe(true);

    // Selesaikan konflik terakhir → semua flag terkait bersih.
    const lastResolve = await auth(
      request(server).post(resolvePath(thirdTask)),
      fx.owner,
    ).send({ resolutionNote: 'Booking ketiga memakai unit lain' });
    expect(lastResolve.status).toBe(200);
    expect(lastResolve.body.data.openConflictsRemaining).toBe(0);
    expect(lastResolve.body.data.hasOpenConflict.orders).toEqual(
      expect.arrayContaining([
        { id: current.orderId, hasOpenConflict: false, openConflicts: 0 },
        { id: third.orderId, hasOpenConflict: false, openConflicts: 0 },
      ]),
    );

    expect((await getOrder(fx, current.orderId)).hasOpenConflict).toBe(false);
    expect((await getOrder(fx, third.orderId)).hasOpenConflict).toBe(false);
    const thirdReservationAfter = await auth(
      request(server).get(`${base(fx.tenantId)}/reservations/${third.reservationId}`),
      fx.owner,
    );
    expect(thirdReservationAfter.body.data.hasOpenConflict).toBe(false);

    // Audit dan catatan penyelesaian tersimpan.
    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: fx.tenantId, action: 'ORDER_EXTENSION_CONFLICT_RESOLVED' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audits).toHaveLength(2);
    expect(audits[0].reason).toBe('Unit pengganti untuk booking kedua sudah siap');
    expect(audits[1].reason).toBe('Booking ketiga memakai unit lain');

    // Idempoten: konflik yang sudah selesai tidak menambah audit.
    const replay = await auth(
      request(server).post(resolvePath(thirdTask)),
      fx.owner,
    ).send({ resolutionNote: 'Booking ketiga memakai unit lain' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.alreadyResolved).toBe(true);
    expect(replay.body.data.openConflictsRemaining).toBe(0);
    const auditCount = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({
        where: { tenantId: fx.tenantId, action: 'ORDER_EXTENSION_CONFLICT_RESOLVED' },
      }),
    );
    expect(auditCount).toBe(2);

    // Ringkasan mencerminkan status akhir: tidak ada lagi order ber-flag.
    const openOverview = await auth(
      request(server).get(`${base(fx.tenantId)}/extension-conflicts`),
      fx.owner,
    );
    expect(openOverview.body.data.summary).toMatchObject({
      openConflicts: 0,
      resolvedConflicts: 2,
      flaggedOrders: 0,
      flaggedReservations: 0,
    });
    expect(openOverview.body.data.orders).toHaveLength(0);

    const allOverview = await auth(
      request(server).get(`${base(fx.tenantId)}/extension-conflicts?status=ALL`),
      fx.owner,
    );
    expect(allOverview.body.data.orders).toHaveLength(3);
    // Satu konflik tampil pada kedua order yang bertabrakan; dedupe per id.
    const resolvedConflicts = new Map<string, { status: string; resolutionNote: string }>();
    for (const order of allOverview.body.data.orders as {
      conflicts: { id: string; status: string; resolutionNote: string }[];
    }[]) {
      for (const conflict of order.conflicts) resolvedConflicts.set(conflict.id, conflict);
    }
    expect(resolvedConflicts.size).toBe(2);
    expect([...resolvedConflicts.values()].every((row) => row.status === 'RESOLVED')).toBe(
      true,
    );

    // Konflik yang tidak ada pada extension/order ini → 404.
    const missing = await auth(
      request(server).post(resolvePath({ id: randomUUID() })),
      fx.owner,
    ).send({ resolutionNote: 'Konflik tidak dikenal' });
    expect(missing.status).toBe(404);
  }, 90_000);
});

// ============================================================
// Antrean permintaan lintas order (halaman Pesanan staf)
// ============================================================

describe('Antrean permintaan perpanjangan lintas order', () => {
  it('menampilkan hanya permintaan PENDING milik tenant, plus konteks order', async () => {
    const fx = await setupTenant('extq', 'CHECK_AVAILABILITY');
    const other = await setupTenant('extq2', 'CHECK_AVAILABILITY');

    const first = await createActiveOrder(fx, '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    const second = await createActiveOrder(fx, '2026-11-10T00:00:00.000Z', '2026-11-12T00:00:00.000Z');
    const foreign = await createActiveOrder(
      other,
      '2026-11-01T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    );

    const firstExt = await requestExtension(fx, first.orderId, '2026-11-04T00:00:00.000Z');
    const secondExt = await requestExtension(fx, second.orderId, '2026-11-14T00:00:00.000Z');
    await requestExtension(other, foreign.orderId, '2026-11-04T00:00:00.000Z');
    expect(firstExt.status).toBe(201);
    expect(secondExt.status).toBe(201);

    const queue = await auth(
      request(server).get(`${base(fx.tenantId)}/extensions`),
      fx.owner,
    );
    expect(queue.status).toBe(200);
    const rows = queue.body.data as {
      id: string;
      orderId: string;
      status: string;
      order: { orderNumber: string; status: string; customerName: string | null };
    }[];
    // Terlama lebih dulu, hanya milik tenant ini, semua masih menunggu.
    expect(rows.map((row) => row.orderId)).toEqual([first.orderId, second.orderId]);
    expect(rows.every((row) => row.status === 'PENDING_APPROVAL')).toBe(true);
    expect(rows.map((row) => row.orderId)).not.toContain(foreign.orderId);
    expect(rows[0]!.order).toMatchObject({ status: 'ACTIVE' });
    expect(rows[0]!.order.orderNumber).toEqual(expect.any(String));

    // Keputusan tetap lewat command approve per order → baris hilang dari antrean.
    const approve = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${first.orderId}/extensions/${rows[0]!.id}/approve`,
      ),
      fx.owner,
    ).send({});
    expect(approve.status).toBe(200);

    const after = await auth(
      request(server).get(`${base(fx.tenantId)}/extensions`),
      fx.owner,
    );
    expect((after.body.data as { orderId: string }[]).map((row) => row.orderId)).toEqual([
      second.orderId,
    ]);

    const all = await auth(
      request(server).get(`${base(fx.tenantId)}/extensions?status=ALL`),
      fx.owner,
    );
    expect(all.body.data).toHaveLength(2);

    // Status acak ditolak validasi; tanpa sesi ditolak 401.
    const invalid = await auth(
      request(server).get(`${base(fx.tenantId)}/extensions?status=BOGUS`),
      fx.owner,
    );
    expect(invalid.status).toBe(400);
    const anonymous = await request(server).get(`${base(fx.tenantId)}/extensions`);
    expect(anonymous.status).toBe(401);
  }, 90_000);
});

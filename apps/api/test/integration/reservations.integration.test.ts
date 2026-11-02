/**
 * Integration test: Reservasi & Ketersediaan (anti double-booking)
 *
 * Mencakup kontrak docs/openapi.yaml (tag "reservation") + ADR-001 §1:
 * - GET  /tenants/:t/availability                  → cek ketersediaan
 * - POST /tenants/:t/reservations                  → manual: PENDING_APPROVAL;
 *                                                    otomatis: check-and-allocate atomik
 * - GET  /tenants/:t/reservations/:id              → detail + item + alokasi
 * - POST /tenants/:t/reservations/:id/confirm      → cek ulang + alokasi atomik
 * - POST /tenants/:t/reservations/:id/reject       → PENDING → REJECTED
 * - POST /tenants/:t/reservations/:id/cancel       → lepas alokasi atomik
 *
 * Fokus utama: MEMASTIKAN TIDAK PERNAH TERJADI DOUBLE BOOKING —
 * baik pada request paralel (SELECT FOR UPDATE) maupun sebagai tameng
 * terakhir exclusion constraint PostgreSQL (btree_gist + tsrange '[)').
 *
 * Berjalan terhadap PostgreSQL sewain_test (migrasi penuh dari nol).
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
const PW = 'kata-sandi-reservasi-testing-001';
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

// ============================================================
// Fixtures
// ============================================================

async function registerAndLogin(
  emailAddr: string,
): Promise<{ cookie: string; csrf: string; userId: string }> {
  await request(server)
    .post(`${API}/auth/registrations`)
    .send({ email: emailAddr, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
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
  return {
    cookie: session.split(';')[0],
    csrf: login.headers['x-csrf-token'] as string,
    userId: user!.id,
  };
}

async function setupOwnerAndTenant(prefix: string) {
  const { cookie, csrf, userId } = await registerAndLogin(em(prefix));
  const tenant = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', ORIGIN)
    .send({ name: `Tenant ${prefix}`, slug: slug(prefix) });
  if (tenant.status !== 201) {
    throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  }
  return { cookie, csrf, userId, tenantId: tenant.body.data.id as string };
}

interface Fixture {
  cookie: string;
  csrf: string;
  userId: string;
  tenantId: string;
  productId: string;
  assetIds: string[];
}

function base(tenantId: string) {
  return `${API}/tenants/${tenantId}`;
}

function auth(f: { cookie: string; csrf: string }) {
  return { Cookie: f.cookie, 'X-CSRF-Token': f.csrf, Origin: ORIGIN };
}

/** Tenant + produk + unit fisik lewat API. */
async function setupProduct(
  prefix: string,
  opts: { stockMode?: 'QUANTITY' | 'INDIVIDUAL_UNITS'; capacity?: number; assets?: number } = {},
): Promise<Fixture> {
  const stockMode = opts.stockMode ?? 'INDIVIDUAL_UNITS';
  const { cookie, csrf, userId, tenantId } = await setupOwnerAndTenant(prefix);

  const product = await request(server)
    .post(`${base(tenantId)}/products`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', ORIGIN)
    .send({
      name: `Produk ${prefix}`,
      stockMode,
      capacity: stockMode === 'QUANTITY' ? (opts.capacity ?? 10) : 0,
    });
  if (product.status !== 201) {
    throw new Error(`Gagal buat produk: ${JSON.stringify(product.body)}`);
  }
  const productId = product.body.data.id as string;

  const assetIds: string[] = [];
  const assetCount = opts.assets ?? (stockMode === 'INDIVIDUAL_UNITS' ? 1 : 0);
  for (let i = 0; i < assetCount; i += 1) {
    const asset = await request(server)
      .post(`${base(tenantId)}/products/${productId}/assets`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', ORIGIN)
      .send({ code: `UNIT-${prefix}-${i}-${Date.now() % 1000000}` });
    if (asset.status !== 201) {
      throw new Error(`Gagal buat asset: ${JSON.stringify(asset.body)}`);
    }
    assetIds.push(asset.body.data.id as string);
  }

  return { cookie, csrf, userId, tenantId, productId, assetIds };
}

function periods(offsetHours = 0) {
  const start = new Date(Date.now() + (24 + offsetHours) * 3600_000);
  const end = new Date(start.getTime() + 4 * 3600_000);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

async function activeAllocations(tenantId: string) {
  return prisma.withTenant(tenantId, (tx) =>
    tx.reservationAllocation.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

// ============================================================
// Ketersediaan
// ============================================================

describe('Reservasi — ketersediaan', () => {
  it('GET /availability → kapasitas penuh sebelum ada reservasi', async () => {
    const f = await setupProduct('avail1', { stockMode: 'QUANTITY', capacity: 3 });
    const p = periods();
    const res = await request(server)
      .get(`${base(f.tenantId)}/availability`)
      .query({ productId: f.productId, ...p })
      .set('Cookie', f.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      productId: f.productId,
      stockMode: 'QUANTITY',
      capacity: 3,
      allocated: 0,
      available: 3,
    });
  });

  it('GET /availability → unit dalam maintenance tidak dihitung bebas', async () => {
    const f = await setupProduct('avail2', { assets: 1 });
    const p = periods();

    await request(server)
      .post(`${base(f.tenantId)}/assets/${f.assetIds[0]}/maintenance`)
      .set(auth(f))
      .send(p);

    const res = await request(server)
      .get(`${base(f.tenantId)}/availability`)
      .query({ productId: f.productId, ...p })
      .set('Cookie', f.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(0);
    expect(res.body.data.maintenanceBlocked).toBe(1);
  });

  it('GET /availability dengan periode tidak valid → 400 VALIDATION_ERROR', async () => {
    const f = await setupProduct('avail3');
    const p = periods();
    const res = await request(server)
      .get(`${base(f.tenantId)}/availability`)
      .query({ productId: f.productId, startAt: p.endAt, endAt: p.startAt })
      .set('Cookie', f.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ============================================================
// Create — mode booking tenant
// ============================================================

describe('Reservasi — create', () => {
  it('Mode AUTOMATIC + stok tersedia → CONFIRMED dengan alokasi atomik', async () => {
    const f = await setupProduct('autocreate');
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC' });

    const res = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...periods(), items: [{ productId: f.productId, quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('CONFIRMED');
    expect(res.body.data.allocations).toHaveLength(1);
    expect(res.body.data.allocations[0].status).toBe('ACTIVE');
    expect(res.body.data.items[0].priceSnapshot).toBeTypeOf('string');

    // Unit fisik ditandai RESERVED.
    const asset = await prisma.withTenant(f.tenantId, (tx) =>
      tx.asset.findUnique({ where: { id: f.assetIds[0] } }),
    );
    expect(asset!.status).toBe('RESERVED');
  });

  it('Mode MANUAL (default) → PENDING_APPROVAL tanpa alokasi permanen', async () => {
    const f = await setupProduct('manualcreate');
    const res = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...periods(), items: [{ productId: f.productId, quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING_APPROVAL');
    expect(res.body.data.allocations).toHaveLength(0);

    const asset = await prisma.withTenant(f.tenantId, (tx) =>
      tx.asset.findUnique({ where: { id: f.assetIds[0] } }),
    );
    expect(asset!.status).toBe('AVAILABLE');
  });

  it('Mode AUTOMATIC + Opsi B (SKIP_AVAILABILITY) + stok kosong → 409 AVAILABILITY_CONFLICT', async () => {
    const f = await setupProduct('optbcreate', { assets: 1 });
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC', catalogPolicy: 'SKIP_AVAILABILITY' });

    const p = periods();
    // Reservasi pertama mengunci satu-satunya unit.
    const first = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    expect(first.body.data.status).toBe('CONFIRMED');

    const second = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('AVAILABILITY_CONFLICT');

    // Tidak ada alokasi parsial: hanya 1 alokasi ACTIVE di database.
    expect(await activeAllocations(f.tenantId)).toHaveLength(1);
  });

  it('Mode AUTOMATIC + Opsi A (CHECK_AVAILABILITY) + stok kosong → PENDING tanpa alokasi', async () => {
    const f = await setupProduct('optacreate', { assets: 1 });
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC', catalogPolicy: 'CHECK_AVAILABILITY' });

    const p = periods();
    const first = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    expect(first.body.data.status).toBe('CONFIRMED');

    // Opsi A: permintaan diterima sebagai PENDING tanpa alokasi, bukan ditolak.
    const second = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    expect(second.status).toBe(201);
    expect(second.body.data.status).toBe('PENDING_APPROVAL');
    expect(second.body.data.allocations).toHaveLength(0);
    expect(await activeAllocations(f.tenantId)).toHaveLength(1);
  });

  it('Periode tidak valid (startAt >= endAt) → 400 VALIDATION_ERROR', async () => {
    const f = await setupProduct('badperiod');
    const p = periods();
    const res = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ startAt: p.endAt, endAt: p.startAt, items: [{ productId: f.productId, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('Tanpa X-CSRF-Token → 403 (mutasi berbasis sesi wajib CSRF)', async () => {
    const f = await setupProduct('csrfresv');
    const res = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set('Cookie', f.cookie)
      .set('Origin', ORIGIN)
      .send({ ...periods(), items: [{ productId: f.productId, quantity: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });
});

// ============================================================
// Lifecycle: confirm / reject / cancel
// ============================================================

describe('Reservasi — lifecycle (ADR-001 §1)', () => {
  it('Confirm PENDING → CONFIRMED; confirm lagi → 409 INVALID_STATE_TRANSITION', async () => {
    const f = await setupProduct('lifecycle1');
    const create = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...periods(), items: [{ productId: f.productId, quantity: 1 }] });
    const id = create.body.data.id as string;

    const confirm = await request(server)
      .post(`${base(f.tenantId)}/reservations/${id}/confirm`)
      .set(auth(f))
      .send({ note: 'Stok siap' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.status).toBe('CONFIRMED');
    expect(confirm.body.data.allocations).toHaveLength(1);

    const again = await request(server)
      .post(`${base(f.tenantId)}/reservations/${id}/confirm`)
      .set(auth(f))
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('Confirm saat stok sudah diambil → 409 AVAILABILITY_CONFLICT, state tetap PENDING', async () => {
    const f = await setupProduct('conflictcf', { assets: 1 });
    const p = periods();

    // PENDING pertama (manual mode) tidak mengunci unit.
    const p1 = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    const p2 = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });

    const c1 = await request(server)
      .post(`${base(f.tenantId)}/reservations/${p1.body.data.id}/confirm`)
      .set(auth(f))
      .send({});
    expect(c1.status).toBe(200);

    const c2 = await request(server)
      .post(`${base(f.tenantId)}/reservations/${p2.body.data.id}/confirm`)
      .set(auth(f))
      .send({});
    expect(c2.status).toBe(409);
    expect(c2.body.error.code).toBe('AVAILABILITY_CONFLICT');

    // PENDING kedua tidak berubah state dan tidak membuat alokasi parsial.
    const detail = await request(server)
      .get(`${base(f.tenantId)}/reservations/${p2.body.data.id}`)
      .set('Cookie', f.cookie);
    expect(detail.body.data.status).toBe('PENDING_APPROVAL');
    expect(detail.body.data.allocations).toHaveLength(0);
    expect(await activeAllocations(f.tenantId)).toHaveLength(1);
  });

  it('Reject PENDING → REJECTED (terminal); confirm setelah reject → 409', async () => {
    const f = await setupProduct('rejectcase');
    const create = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...periods(), items: [{ productId: f.productId, quantity: 1 }] });
    const id = create.body.data.id as string;

    const reject = await request(server)
      .post(`${base(f.tenantId)}/reservations/${id}/reject`)
      .set(auth(f))
      .send({ reason: 'Tidak ada stok' });
    expect(reject.status).toBe(200);
    expect(reject.body.data.status).toBe('REJECTED');

    const confirm = await request(server)
      .post(`${base(f.tenantId)}/reservations/${id}/confirm`)
      .set(auth(f))
      .send({});
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('Cancel CONFIRMED → alokasi dilepas, unit kembali AVAILABLE, periode bisa dibooking ulang', async () => {
    const f = await setupProduct('cancelcase', { assets: 1 });
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC' });

    const p = periods();
    const create = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    expect(create.body.data.status).toBe('CONFIRMED');
    expect(await activeAllocations(f.tenantId)).toHaveLength(1);

    const cancel = await request(server)
      .post(`${base(f.tenantId)}/reservations/${create.body.data.id}/cancel`)
      .set(auth(f))
      .send({ reason: 'Penyewa membatalkan' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(cancel.body.data.allocations.every((a: { status: string }) => a.status === 'RELEASED')).toBe(true);

    const asset = await prisma.withTenant(f.tenantId, (tx) =>
      tx.asset.findUnique({ where: { id: f.assetIds[0] } }),
    );
    expect(asset!.status).toBe('AVAILABLE');

    // Idempoten terhadap pembatalan ganda: cancel kedua → 409 (state terminal).
    const cancel2 = await request(server)
      .post(`${base(f.tenantId)}/reservations/${create.body.data.id}/cancel`)
      .set(auth(f))
      .send({});
    expect(cancel2.status).toBe(409);

    // Periode yang sama sekarang bebas dibooking ulang.
    const rebook = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    expect(rebook.status).toBe(201);
    expect(rebook.body.data.status).toBe('CONFIRMED');
  });

  it('Cancel PENDING → CANCELLED tanpa alokasi', async () => {
    const f = await setupProduct('cancelpending');
    const create = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...periods(), items: [{ productId: f.productId, quantity: 1 }] });
    const cancel = await request(server)
      .post(`${base(f.tenantId)}/reservations/${create.body.data.id}/cancel`)
      .set(auth(f))
      .send({ reason: 'Berubah rencana' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect(await activeAllocations(f.tenantId)).toHaveLength(0);
  });
});

// ============================================================
// ANTI DOUBLE-BOOKING — kasus balapan (inti Sprint 2)
// ============================================================

describe('Reservasi — anti double-booking (balapan paralel)', () => {
  it('6 create paralel, 1 unit fisik, mode AUTOMATIC+Opsi B → tepat 1 CONFIRMED, 5×409', async () => {
    const f = await setupProduct('raceunit', { assets: 1 });
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC', catalogPolicy: 'SKIP_AVAILABILITY' });

    const p = periods();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(server)
          .post(`${base(f.tenantId)}/reservations`)
          .set(auth(f))
          .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(5);
    for (const r of conflicted) {
      expect(r.body.error.code).toBe('AVAILABILITY_CONFLICT');
    }

    // Invariant database: TIDAK PERNAH lebih dari 1 alokasi ACTIVE per unit.
    const allocations = await activeAllocations(f.tenantId);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].status).toBe('ACTIVE');
  });

  it('6 create paralel, stok kuantitas capacity=2 → hanya 2 yang CONFIRMED', async () => {
    const f = await setupProduct('raceqty', { stockMode: 'QUANTITY', capacity: 2 });
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC', catalogPolicy: 'SKIP_AVAILABILITY' });

    const p = periods();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(server)
          .post(`${base(f.tenantId)}/reservations`)
          .set(auth(f))
          .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);

    const allocations = await activeAllocations(f.tenantId);
    const total = allocations.reduce((sum, a) => sum + a.quantity, 0);
    expect(total).toBeLessThanOrEqual(2);
  });

  it('6 create paralel melebihi kapasitas (capacity=1, quantity=2) → 409 semua, tanpa alokasi', async () => {
    const f = await setupProduct('raceover', { stockMode: 'QUANTITY', capacity: 1 });
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC', catalogPolicy: 'SKIP_AVAILABILITY' });

    const p = periods();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(server)
          .post(`${base(f.tenantId)}/reservations`)
          .set(auth(f))
          .send({ ...p, items: [{ productId: f.productId, quantity: 2 }] }),
      ),
    );

    for (const r of results) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('AVAILABILITY_CONFLICT');
    }
    expect(await activeAllocations(f.tenantId)).toHaveLength(0);
  });

  it('4 confirm paralel pada reservasi berbeda, 1 unit → tepat 1 CONFIRMED', async () => {
    const f = await setupProduct('raceconfirm', { assets: 1 });
    const p = periods();

    // 4 reservasi PENDING (manual mode) untuk unit & periode sama.
    const creates = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(server)
          .post(`${base(f.tenantId)}/reservations`)
          .set(auth(f))
          .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] }),
      ),
    );
    for (const c of creates) expect(c.body.data.status).toBe('PENDING_APPROVAL');

    const confirms = await Promise.all(
      creates.map((c) =>
        request(server)
          .post(`${base(f.tenantId)}/reservations/${c.body.data.id}/confirm`)
          .set(auth(f))
          .send({}),
      ),
    );

    expect(confirms.filter((r) => r.status === 200)).toHaveLength(1);
    expect(confirms.filter((r) => r.status === 409)).toHaveLength(3);
    for (const r of confirms.filter((x) => x.status === 409)) {
      expect(['AVAILABILITY_CONFLICT', 'INVALID_STATE_TRANSITION']).toContain(
        r.body.error.code,
      );
    }

    const allocations = await activeAllocations(f.tenantId);
    expect(allocations).toHaveLength(1);
  });

  it('6 create paralel multi-produk parsial (1 tersedia, 1 tidak) → ditolak semua, tanpa alokasi parsial', async () => {
    const f = await setupProduct('racemulti', { stockMode: 'QUANTITY', capacity: 2 });
    const second = await request(server)
      .post(`${base(f.tenantId)}/products`)
      .set(auth(f))
      .send({ name: 'Produk Kedua', stockMode: 'QUANTITY', capacity: 0 });
    const secondId = second.body.data.id as string;
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC', catalogPolicy: 'SKIP_AVAILABILITY' });

    const p = periods();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(server)
          .post(`${base(f.tenantId)}/reservations`)
          .set(auth(f))
          .send({
            ...p,
            items: [
              { productId: f.productId, quantity: 1 },   // tersedia
              { productId: secondId, quantity: 1 },      // tidak tersedia (capacity 0)
            ],
          }),
      ),
    );

    for (const r of results) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('AVAILABILITY_CONFLICT');
    }
    // Tidak ada alokasi parsial untuk produk pertama.
    expect(await activeAllocations(f.tenantId)).toHaveLength(0);
  });
});

// ============================================================
// Tameng database: exclusion constraint
// ============================================================

describe('Reservasi — exclusion constraint (defense-in-depth)', () => {
  it('Insert manual dua alokasi ACTIVE tumpang tindih pada unit sama → DITOLAK PostgreSQL', async () => {
    const f = await setupProduct('constraint', { assets: 1 });
    // Mode AUTOMATIC agar reservasi pertama benar-benar membuat alokasi ACTIVE.
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC' });
    const p = periods();

    // Buat reservasi pertama lewat API agar row reservasi valid.
    const create = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    expect(create.status).toBe(201);
    expect(create.body.data.status).toBe('CONFIRMED');
    expect(await activeAllocations(f.tenantId)).toHaveLength(1);
    const reservationId = create.body.data.id as string;

    // Sisipkan alokasi KEDUA langsung via SQL — melewati seluruh lapisan aplikasi.
    // Exclusion constraint (btree_gist + tsrange '[)') harus menolaknya.
    await expect(
      prisma.withTenant(f.tenantId, async (tx) => {
        await tx.reservation.create({
          data: {
            tenantId: f.tenantId,
            status: 'CONFIRMED',
            bookingMode: 'AUTOMATIC',
            startAt: new Date(p.startAt),
            endAt: new Date(p.endAt),
          },
        });
        return tx.reservationAllocation.create({
          data: {
            tenantId: f.tenantId,
            productId: f.productId,
            assetId: f.assetIds[0],
            reservationId,
            quantity: 1,
            startAt: new Date(p.startAt),
            endAt: new Date(p.endAt),
            status: 'ACTIVE',
          },
        });
      }),
    ).rejects.toThrow();

    // Alokasi ACTIVE tetap hanya 1.
    expect(await activeAllocations(f.tenantId)).toHaveLength(1);
  });

  it('Rentang bersebelahan half-open [10,14) dan [14,18) TIDAK dianggap bentrok', async () => {
    const f = await setupProduct('halfopen', { assets: 1 });
    await request(server)
      .patch(`${base(f.tenantId)}/settings`)
      .set(auth(f))
      .send({ bookingMode: 'AUTOMATIC', catalogPolicy: 'SKIP_AVAILABILITY' });

    const start = new Date(Date.now() + 48 * 3600_000);
    const mid = new Date(start.getTime() + 4 * 3600_000);
    const end = new Date(start.getTime() + 8 * 3600_000);

    const first = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({
        startAt: start.toISOString(),
        endAt: mid.toISOString(),
        items: [{ productId: f.productId, quantity: 1 }],
      });
    expect(first.status).toBe(201);

    // Bersebelahan: endAt pertama == startAt kedua → bukan bentrok.
    const second = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({
        startAt: mid.toISOString(),
        endAt: end.toISOString(),
        items: [{ productId: f.productId, quantity: 1 }],
      });
    expect(second.status).toBe(201);
    expect(await activeAllocations(f.tenantId)).toHaveLength(2);

    // Tumpang tindih 1 menit di titik batas → 409.
    const overlap = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({
        startAt: new Date(mid.getTime() - 60_000).toISOString(),
        endAt: new Date(mid.getTime() + 60_000).toISOString(),
        items: [{ productId: f.productId, quantity: 1 }],
      });
    expect(overlap.status).toBe(409);
  });
});

// ============================================================
// Idempotency-Key (dokumen 10 — create booking kritis & idempoten)
// ============================================================

describe('Reservasi — idempotency', () => {
  it('replay dengan Idempotency-Key sama → hasil sama, hanya satu reservasi', async () => {
    const f = await setupProduct('idem1');
    const p = periods();
    const body = { ...p, items: [{ productId: f.productId, quantity: 1 }] };
    const key = `booking-${Date.now()}-aa`;

    const first = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .set('Idempotency-Key', key)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.status).toBe(first.body.data.status);

    const count = await prisma.withTenant(f.tenantId, (tx) =>
      tx.reservation.count({ where: { tenantId: f.tenantId } }),
    );
    expect(count).toBe(1);

    const record = await prisma.withTenant(f.tenantId, (tx) =>
      tx.idempotencyRecord.findFirst({
        where: { tenantId: f.tenantId, scope: 'create-reservation', key },
      }),
    );
    expect(record).not.toBeNull();
    expect(record!.state).toBe('COMPLETED');
    expect(record!.responseStatus).toBe(201);
  });

  it('key dipakai ulang dengan payload berbeda → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const f = await setupProduct('idem2');
    const key = `booking-${Date.now()}-bb`;

    const first = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .set('Idempotency-Key', key)
      .send({ ...periods(), items: [{ productId: f.productId, quantity: 1 }] });
    expect(first.status).toBe(201);

    const second = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .set('Idempotency-Key', key)
      .send({ ...periods(6), items: [{ productId: f.productId, quantity: 1 }] });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const count = await prisma.withTenant(f.tenantId, (tx) =>
      tx.reservation.count({ where: { tenantId: f.tenantId } }),
    );
    expect(count).toBe(1);
  });

  it('Idempotency-Key tidak valid → 400 VALIDATION_ERROR', async () => {
    const f = await setupProduct('idem3');
    const res = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .set('Idempotency-Key', 'pendek')
      .send({ ...periods(), items: [{ productId: f.productId, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('request paralel dengan key sama → satu reservasi, kedua respons sama', async () => {
    const f = await setupProduct('idem4');
    const body = { ...periods(), items: [{ productId: f.productId, quantity: 1 }] };
    const key = `booking-${Date.now()}-cc`;

    const send = () =>
      request(server)
        .post(`${base(f.tenantId)}/reservations`)
        .set(auth(f))
        .set('Idempotency-Key', key)
        .send(body);

    const [a, b, c] = await Promise.all([send(), send(), send()]);
    // Duplikat menunggu index unik sampai transaksi pemenang commit, lalu
    // diputar ulang dari record — semuanya 201 dengan id yang sama.
    for (const res of [a, b, c]) {
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const ids = new Set([a, b, c].map((r) => r.body.data.id as string));
    expect(ids.size).toBe(1);

    const count = await prisma.withTenant(f.tenantId, (tx) =>
      tx.reservation.count({ where: { tenantId: f.tenantId } }),
    );
    expect(count).toBe(1);
  });
});

// ============================================================
// Isolasi tenant & akses
// ============================================================

describe('Reservasi — isolasi tenant & akses', () => {
  it('Reservasi tenant A tidak terlihat/dapat diakses dari tenant B → 404', async () => {
    const a = await setupProduct('isoA');
    const b = await setupOwnerAndTenant('isoB');

    const create = await request(server)
      .post(`${base(a.tenantId)}/reservations`)
      .set(auth(a))
      .send({ ...periods(), items: [{ productId: a.productId, quantity: 1 }] });
    const id = create.body.data.id as string;

    const detail = await request(server)
      .get(`${base(b.tenantId)}/reservations/${id}`)
      .set('Cookie', b.cookie);
    expect(detail.status).toBe(404);

    const confirm = await request(server)
      .post(`${base(b.tenantId)}/reservations/${id}/confirm`)
      .set('Cookie', b.cookie)
      .set('X-CSRF-Token', b.csrf)
      .set('Origin', ORIGIN)
      .send({});
    expect(confirm.status).toBe(404);
  });

  it('Tanpa sesi → 401 UNAUTHENTICATED', async () => {
    const f = await setupProduct('noauth');
    const res = await request(server).get(`${base(f.tenantId)}/reservations`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('Bukan member tenant → 403 PERMISSION_DENIED', async () => {
    const owner = await setupProduct('notmember');
    const stranger = await registerAndLogin(em('stranger'));
    const res = await request(server)
      .get(`${base(owner.tenantId)}/reservations`)
      .set('Cookie', stranger.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('List & detail reservasi mengembalikan item + alokasi', async () => {
    const f = await setupProduct('readcase');
    const p = periods();
    const create = await request(server)
      .post(`${base(f.tenantId)}/reservations`)
      .set(auth(f))
      .send({ ...p, items: [{ productId: f.productId, quantity: 1 }] });
    const id = create.body.data.id as string;

    const list = await request(server)
      .get(`${base(f.tenantId)}/reservations`)
      .set('Cookie', f.cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.some((r: { id: string }) => r.id === id)).toBe(true);

    const detail = await request(server)
      .get(`${base(f.tenantId)}/reservations/${id}`)
      .set('Cookie', f.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data.items).toHaveLength(1);
    expect(detail.body.data.items[0].productId).toBe(f.productId);
    expect(detail.body.data.items[0].startAt).toBeTruthy();
    expect(detail.body.data).toHaveProperty('allocations');
  });
});

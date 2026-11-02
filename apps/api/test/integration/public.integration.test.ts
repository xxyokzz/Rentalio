/**
 * Integration test: alur penyewa publik (Notion 14)
 *
 * Kontrak docs/openapi.yaml:
 * - GET  /public/:slug/catalog
 * - GET  /public/:slug/products/:productId
 * - GET  /public/:slug/availability
 * - POST /public/:slug/bookings
 * - GET  /portal/orders/:token
 *
 * Fokus:
 * - tenant diresolusi dari slug; UUID tenant tidak bocor;
 * - booking tamu memakai jalur reservasi yang sama (harga server, alokasi atomik);
 * - policy Opsi A/B ditegakkan server, bukan hanya UI;
 * - token portal hash-only, satu pesanan, kedaluwarsa/dicabut → 404;
 * - Idempotency-Key tidak membuat booking ganda;
 * - isolasi tenant: katalog/portal tenant A tidak pernah membuka data tenant B.
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
const PW = 'kata-sandi-publik-testing-001';
const ORIGIN = 'http://localhost:3001';
const TERMS = { accepted: true, version: '2026-10-21' } as const;

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
  return `${prefix.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now() % 1000000}-${Math.floor(
    Math.random() * 1000,
  )}`;
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

interface Fixture {
  cookie: string;
  csrf: string;
  tenantId: string;
  tenantSlug: string;
  productId: string;
  assetIds: string[];
  rate: number;
}

function base(tenantId: string) {
  return `${API}/tenants/${tenantId}`;
}

function auth(f: { cookie: string; csrf: string }) {
  return { Cookie: f.cookie, 'X-CSRF-Token': f.csrf, Origin: ORIGIN };
}

/** Tenant + kategori + produk + tarif (+ unit fisik) melalui API tenant. */
async function setupFixture(
  prefix: string,
  opts: {
    stockMode?: 'QUANTITY' | 'INDIVIDUAL_UNITS';
    capacity?: number;
    assets?: number;
    rate?: number;
    isActive?: boolean;
  } = {},
): Promise<Fixture> {
  const stockMode = opts.stockMode ?? 'QUANTITY';
  const { cookie, csrf } = await registerAndLogin(em(prefix));
  const tenantSlug = slug(prefix);

  const tenant = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', ORIGIN)
    .send({ name: `Tenant ${prefix}`, slug: tenantSlug });
  if (tenant.status !== 201) {
    throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  }
  const tenantId = tenant.body.data.id as string;

  const category = await request(server)
    .post(`${base(tenantId)}/categories`)
    .set({ Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN })
    .send({ name: `Kategori ${prefix}` });
  if (category.status !== 201) {
    throw new Error(`Gagal buat kategori: ${JSON.stringify(category.body)}`);
  }

  const product = await request(server)
    .post(`${base(tenantId)}/products`)
    .set({ Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN })
    .send({
      name: `Produk ${prefix}`,
      description: `Deskripsi ${prefix}`,
      categoryId: category.body.data.id,
      stockMode,
      capacity: stockMode === 'QUANTITY' ? (opts.capacity ?? 5) : 0,
      isActive: opts.isActive ?? true,
    });
  if (product.status !== 201) {
    throw new Error(`Gagal buat produk: ${JSON.stringify(product.body)}`);
  }
  const productId = product.body.data.id as string;
  const rate = opts.rate ?? 150_000;

  const rateResponse = await request(server)
    .post(`${base(tenantId)}/products/${productId}/rates`)
    .set({ Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN })
    .send({ perDayAmount: rate, perWeekAmount: rate * 6, perMonthAmount: rate * 24 });
  if (rateResponse.status !== 200 && rateResponse.status !== 201) {
    throw new Error(`Gagal buat tarif: ${JSON.stringify(rateResponse.body)}`);
  }

  const assetIds: string[] = [];
  const assetCount = opts.assets ?? (stockMode === 'INDIVIDUAL_UNITS' ? 1 : 0);
  for (let i = 0; i < assetCount; i += 1) {
    const asset = await request(server)
      .post(`${base(tenantId)}/products/${productId}/assets`)
      .set({ Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN })
      .send({ code: `UNIT-${prefix}-${i}-${Date.now() % 1000000}` });
    if (asset.status !== 201) {
      throw new Error(`Gagal buat asset: ${JSON.stringify(asset.body)}`);
    }
    assetIds.push(asset.body.data.id as string);
  }

  return { cookie, csrf, tenantId, tenantSlug, productId, assetIds, rate };
}

async function updateSettings(f: Fixture, body: Record<string, unknown>) {
  const response = await request(server)
    .patch(`${base(f.tenantId)}/settings`)
    .set(auth(f))
    .send(body);
  if (response.status !== 200 && response.status !== 204) {
    throw new Error(`Gagal update settings: ${JSON.stringify(response.body)}`);
  }
}

function periods(offsetHours = 0) {
  const start = new Date(Date.now() + (24 + offsetHours) * 3600_000);
  const end = new Date(start.getTime() + 24 * 3600_000);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function guest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Penyewa Uji',
    phone: '+628123456789',
    email: 'penyewa@contoh.com',
    ...overrides,
  };
}

function bookingBody(
  f: Fixture,
  overrides: { quantity?: number; period?: { startAt: string; endAt: string }; guest?: unknown; terms?: unknown } = {},
) {
  const period = overrides.period ?? periods();
  return {
    ...period,
    items: [{ productId: f.productId, quantity: overrides.quantity ?? 1 }],
    guest: overrides.guest ?? guest(),
    terms: overrides.terms ?? TERMS,
  };
}

async function postBooking(
  f: Fixture,
  body: object,
  idempotencyKey?: string,
) {
  const req = request(server).post(`${API}/public/${f.tenantSlug}/bookings`).send(body);
  if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
  return req;
}

async function tokenRows(tenantId: string, reservationId: string) {
  return prisma.withTenant(tenantId, (tx) =>
    tx.publicOrderAccess.findMany({
      where: { tenantId, reservationId },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

// ============================================================
// Katalog publik
// ============================================================

describe('Publik — katalog', () => {
  it('GET /public/:slug/catalog → tenant aktif, produk aktif, tanpa UUID tenant', async () => {
    const f = await setupFixture('pubcat');
    const response = await request(server).get(`${API}/public/${f.tenantSlug}/catalog`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const data = response.body.data;
    expect(data.tenant).toMatchObject({
      slug: f.tenantSlug,
      name: expect.stringContaining('Tenant'),
      bookingMode: 'MANUAL',
      catalogPolicy: 'CHECK_AVAILABILITY',
    });
    expect(data.tenant.id).toBeUndefined();
    expect(data.categories).toHaveLength(1);
    expect(data.products).toHaveLength(1);
    expect(data.products[0]).toMatchObject({
      id: f.productId,
      name: expect.stringContaining('Produk'),
      capacity: 5,
      rate: {
        perDayAmount: '150000',
        perWeekAmount: '900000',
        perMonthAmount: '3600000',
      },
    });
  });

  it('produk nonaktif tidak pernah muncul di katalog atau detail publik', async () => {
    const f = await setupFixture('pubinactive', { isActive: false });

    const catalog = await request(server).get(`${API}/public/${f.tenantSlug}/catalog`);
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.products).toHaveLength(0);

    const detail = await request(server).get(
      `${API}/public/${f.tenantSlug}/products/${f.productId}`,
    );
    expect(detail.status).toBe(404);
  });

  it('slug tidak dikenal dan tenant non-aktif → 404 yang sama (tanpa bocor status)', async () => {
    const f = await setupFixture('pubsusp');
    await prisma.withTenant(f.tenantId, (tx) =>
      tx.tenant.update({ where: { id: f.tenantId }, data: { status: 'SUSPENDED' } }),
    );

    const missing = await request(server).get(`${API}/public/tidak-ada-${Date.now()}/catalog`);
    const suspended = await request(server).get(`${API}/public/${f.tenantSlug}/catalog`);
    expect(missing.status).toBe(404);
    expect(suspended.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect(suspended.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /availability publik menghitung kapasitas tanpa membocorkan daftar unit', async () => {
    const f = await setupFixture('pubavail', {
      stockMode: 'INDIVIDUAL_UNITS',
      assets: 2,
    });
    const p = periods();
    const response = await request(server)
      .get(`${API}/public/${f.tenantSlug}/availability`)
      .query({ productId: f.productId, ...p });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      productId: f.productId,
      stockMode: 'INDIVIDUAL_UNITS',
      capacity: 2,
      available: 2,
    });
    expect(response.body.data.availableAssetIds).toBeUndefined();
  });

  it('setting tenant: whatsapp/instruksi transfer/QRIS tampil di publik, string kosong menghapus', async () => {
    const f = await setupFixture('pubcontact');
    await updateSettings(f, {
      whatsappNumber: '+62 812 0000 1111',
      bankTransferInstructions: 'BCA 1234567890 a.n. Sewa Uji',
      qrisImageUrl: 'https://contoh.com/qris.png',
    });

    let catalog = await request(server).get(`${API}/public/${f.tenantSlug}/catalog`);
    expect(catalog.body.data.tenant).toMatchObject({
      whatsappNumber: '+62 812 0000 1111',
      bankTransferInstructions: 'BCA 1234567890 a.n. Sewa Uji',
      qrisImageUrl: 'https://contoh.com/qris.png',
    });

    // String kosong = hapus; DTO tidak boleh menolaknya sebagai format invalid.
    await updateSettings(f, { whatsappNumber: '', bankTransferInstructions: '', qrisImageUrl: '' });
    catalog = await request(server).get(`${API}/public/${f.tenantSlug}/catalog`);
    expect(catalog.body.data.tenant.whatsappNumber).toBeNull();
    expect(catalog.body.data.tenant.bankTransferInstructions).toBeNull();
    expect(catalog.body.data.tenant.qrisImageUrl).toBeNull();
  });
});

// ============================================================
// Booking tamu
// ============================================================

describe('Publik — booking tamu', () => {
  it('MANUAL + stok tersedia → PENDING_APPROVAL, customer tamu, syarat tersimpan, portal terbit', async () => {
    const f = await setupFixture('pubmanual', { stockMode: 'INDIVIDUAL_UNITS', assets: 1 });
    const response = await postBooking(f, bookingBody(f));

    expect(response.status).toBe(201);
    const data = response.body.data;
    expect(data.reservation.status).toBe('PENDING_APPROVAL');
    expect(data.reservation.totalAmount).toBe('150000');
    expect(data.reservation.items[0]).toMatchObject({
      name: expect.stringContaining('Produk'),
      quantity: 1,
      lineTotal: '150000',
    });
    expect(data.portal.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(data.portal.path).toBe(`/portal/${data.portal.token}`);

    const stored = await prisma.withTenant(f.tenantId, async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { tenantId_id: { tenantId: f.tenantId, id: data.reservation.reference } },
        include: { customer: true, allocations: true },
      });
      const access = await tx.publicOrderAccess.findMany({
        where: { tenantId: f.tenantId, reservationId: data.reservation.reference },
      });
      return { reservation, access };
    });

    expect(stored.reservation?.guestTermsVersion).toBe(TERMS.version);
    expect(stored.reservation?.guestTermsAcceptedAt).toBeInstanceOf(Date);
    expect(stored.reservation?.customer?.isGuest).toBe(true);
    expect(stored.reservation?.customer?.phone).toBe('+628123456789');
    expect(stored.reservation?.allocations).toHaveLength(0);
    // Token plaintext tidak pernah disimpan.
    expect(stored.access).toHaveLength(1);
    expect(stored.access[0].tokenHash).not.toBe(data.portal.token);
    expect(stored.access[0].tokenHash).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('AUTOMATIC + stok tersedia → CONFIRMED dan alokasi dibuat atomik', async () => {
    const f = await setupFixture('pubauto', { stockMode: 'QUANTITY', capacity: 1 });
    await updateSettings(f, { bookingMode: 'AUTOMATIC' });

    const response = await postBooking(f, bookingBody(f));
    expect(response.status).toBe(201);
    expect(response.body.data.reservation.status).toBe('CONFIRMED');

    const allocations = await prisma.withTenant(f.tenantId, (tx) =>
      tx.reservationAllocation.findMany({
        where: {
          tenantId: f.tenantId,
          reservationId: response.body.data.reservation.reference,
          status: 'ACTIVE',
        },
      }),
    );
    expect(allocations).toHaveLength(1);
    expect(allocations[0].quantity).toBe(1);
  });

  it('Opsi A + AUTOMATIC + stok kosong → PENDING_APPROVAL tanpa alokasi', async () => {
    const f = await setupFixture('pubpolicyA', { stockMode: 'QUANTITY', capacity: 0 });
    await updateSettings(f, { bookingMode: 'AUTOMATIC', catalogPolicy: 'CHECK_AVAILABILITY' });

    const response = await postBooking(f, bookingBody(f));
    expect(response.status).toBe(201);
    expect(response.body.data.reservation.status).toBe('PENDING_APPROVAL');

    const allocations = await prisma.withTenant(f.tenantId, (tx) =>
      tx.reservationAllocation.count({
        where: { tenantId: f.tenantId, reservationId: response.body.data.reservation.reference },
      }),
    );
    expect(allocations).toBe(0);
  });

  it('Opsi B + stok kosong → 409 pada mode AUTOMATIC maupun MANUAL', async () => {
    const automatic = await setupFixture('pubpolicyB1', { capacity: 0 });
    await updateSettings(automatic, {
      bookingMode: 'AUTOMATIC',
      catalogPolicy: 'SKIP_AVAILABILITY',
    });
    const first = await postBooking(automatic, bookingBody(automatic));
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('AVAILABILITY_CONFLICT');

    const manual = await setupFixture('pubpolicyB2', { capacity: 0 });
    await updateSettings(manual, {
      bookingMode: 'MANUAL',
      catalogPolicy: 'SKIP_AVAILABILITY',
    });
    const second = await postBooking(manual, bookingBody(manual));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('AVAILABILITY_CONFLICT');
  });

  it('syarat sewa wajib disetujui dan minimal satu kontak wajib diisi', async () => {
    const f = await setupFixture('pubvalidation');

    const noTerms = await postBooking(
      f,
      bookingBody(f, { terms: { accepted: false, version: TERMS.version } }),
    );
    expect(noTerms.status).toBe(400);
    expect(noTerms.body.error.code).toBe('VALIDATION_ERROR');

    const noContact = await postBooking(
      f,
      bookingBody(f, { guest: { name: 'Tanpa Kontak' } }),
    );
    expect(noContact.status).toBe(400);
    expect(noContact.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('Idempotency-Key yang sama tidak membuat booking ganda; tautan lama dicabut', async () => {
    const f = await setupFixture('pubidem');
    const key = `uji-${Date.now()}-idempotent`;
    const body = bookingBody(f);

    const first = await postBooking(f, body, key);
    const second = await postBooking(f, body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.reservation.reference).toBe(first.body.data.reservation.reference);
    expect(second.body.data.portal.token).not.toBe(first.body.data.portal.token);

    const counts = await prisma.withTenant(f.tenantId, async (tx) => ({
      reservations: await tx.reservation.count({ where: { tenantId: f.tenantId } }),
      customers: await tx.customer.count({ where: { tenantId: f.tenantId } }),
    }));
    expect(counts.reservations).toBe(1);
    expect(counts.customers).toBe(1);

    const portalFirst = await request(server).get(
      `${API}/portal/orders/${first.body.data.portal.token}`,
    );
    const portalSecond = await request(server).get(
      `${API}/portal/orders/${second.body.data.portal.token}`,
    );
    expect(portalFirst.status).toBe(404);
    expect(portalSecond.status).toBe(200);

    const rows = await tokenRows(f.tenantId, first.body.data.reservation.reference);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedAt !== null)).toHaveLength(1);
  });

  it('Idempotency-Key dipakai ulang dengan payload berbeda → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const f = await setupFixture('pubidem2');
    const key = `uji-${Date.now()}-reuse`;
    const first = await postBooking(f, bookingBody(f), key);
    expect(first.status).toBe(201);

    const different = await postBooking(f, bookingBody(f, { quantity: 2 }), key);
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

// ============================================================
// Portal pesanan
// ============================================================

describe('Portal — token pesanan', () => {
  it('token valid menampilkan pesanan, total, metode aktif, dan instruksi pembayaran', async () => {
    const f = await setupFixture('pubportal', { stockMode: 'QUANTITY', capacity: 2 });
    await updateSettings(f, {
      whatsappNumber: '+62 812 9999 0000',
      bankTransferInstructions: 'Transfer BCA 111222333 a.n. Sewa Uji',
      qrisImageUrl: 'https://contoh.com/qris.png',
    });
    // Nonaktifkan QRIS untuk booking baru: portal hanya menawarkan metode aktif.
    await request(server)
      .put(`${base(f.tenantId)}/payment-methods`)
      .set(auth(f))
      .send({
        settings: [
          { context: 'NEW_BOOKING', method: 'QRIS', enabled: false },
          { context: 'NEW_BOOKING', method: 'CASH', enabled: false },
        ],
      });

    const booking = await postBooking(f, bookingBody(f));
    expect(booking.status).toBe(201);

    const portal = await request(server).get(
      `${API}/portal/orders/${booking.body.data.portal.token}`,
    );
    expect(portal.status).toBe(200);
    expect(portal.headers['cache-control']).toContain('no-store');
    expect(portal.body.data.tenant).toMatchObject({
      slug: f.tenantSlug,
      whatsappNumber: '+62 812 9999 0000',
      bankTransferInstructions: 'Transfer BCA 111222333 a.n. Sewa Uji',
    });
    expect(portal.body.data.tenant.id).toBeUndefined();
    expect(portal.body.data.reservation.reference).toBe(
      booking.body.data.reservation.reference,
    );
    expect(portal.body.data.summary).toEqual({
      totalAmount: '150000',
      paidAmount: '0',
      outstandingAmount: '150000',
    });
    expect(portal.body.data.paymentMethods).toEqual(['BANK_TRANSFER']);
    expect(portal.body.data.portalExpiresAt).toBeTruthy();
  });

  it('token tidak valid, kedaluwarsa, atau dicabut → 404 yang sama', async () => {
    const f = await setupFixture('pubtoken');
    const invalid = await request(server).get(`${API}/portal/orders/bukan-token-yang-valid`);
    expect(invalid.status).toBe(404);

    const booking = await postBooking(f, bookingBody(f));
    const token = booking.body.data.portal.token as string;
    const reservationId = booking.body.data.reservation.reference as string;

    await prisma.withTenant(f.tenantId, (tx) =>
      tx.publicOrderAccess.updateMany({
        where: { tenantId: f.tenantId, reservationId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    const expired = await request(server).get(`${API}/portal/orders/${token}`);
    expect(expired.status).toBe(404);
    expect(expired.body.error.code).toBe('NOT_FOUND');

    await prisma.withTenant(f.tenantId, (tx) =>
      tx.publicOrderAccess.updateMany({
        where: { tenantId: f.tenantId, reservationId },
        data: { revokedAt: new Date() },
      }),
    );
    const revoked = await request(server).get(`${API}/portal/orders/${token}`);
    expect(revoked.status).toBe(404);
  });

  it('token tenant A tidak membuka pesanan tenant B', async () => {
    const a = await setupFixture('pubtenantA');
    const b = await setupFixture('pubtenantB');

    const bookingA = await postBooking(a, bookingBody(a));
    const bookingB = await postBooking(b, bookingBody(b));
    const portalA = await request(server).get(
      `${API}/portal/orders/${bookingA.body.data.portal.token}`,
    );

    expect(portalA.status).toBe(200);
    expect(portalA.body.data.tenant.slug).toBe(a.tenantSlug);
    expect(portalA.body.data.tenant.slug).not.toBe(b.tenantSlug);
    expect(portalA.body.data.reservation.reference).not.toBe(
      bookingB.body.data.reservation.reference,
    );

    const catalogA = await request(server).get(`${API}/public/${a.tenantSlug}/catalog`);
    const catalogB = await request(server).get(`${API}/public/${b.tenantSlug}/catalog`);
    expect(catalogA.body.data.products[0].id).toBe(a.productId);
    expect(catalogB.body.data.products[0].id).toBe(b.productId);
    expect(catalogA.body.data.products[0].id).not.toBe(b.productId);
  });
});

// ============================================================
// Portal — pengajuan perpanjangan oleh tamu
// ============================================================

/** Konfirmasi booking → konversi → serah terima agar order berstatus ACTIVE. */
async function activateBookedOrder(f: Fixture, reservationId: string): Promise<string> {
  const confirm = await request(server)
    .post(`${base(f.tenantId)}/reservations/${reservationId}/confirm`)
    .set(auth(f))
    .send({});
  expect(confirm.status).toBe(200);

  const convert = await request(server)
    .post(`${base(f.tenantId)}/reservations/${reservationId}/convert-to-order`)
    .set(auth(f))
    .send({});
  expect(convert.status).toBe(201);
  const orderId = convert.body.data.id as string;

  const ready = await request(server)
    .post(`${base(f.tenantId)}/orders/${orderId}/ready-for-handover`)
    .set(auth(f))
    .send({});
  expect(ready.status).toBe(200);

  const handover = await request(server)
    .post(`${base(f.tenantId)}/orders/${orderId}/handover`)
    .set(auth(f))
    .send({});
  expect(handover.status).toBe(200);
  expect(handover.body.data.status).toBe('ACTIVE');
  return orderId;
}

function nextDay(iso: string, days = 1): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

describe('Portal — pengajuan perpanjangan', () => {
  it('tamu mengajukan perpanjangan; biaya dihitung server dan menunggu keputusan', async () => {
    const f = await setupFixture('portalext');
    await updateSettings(f, { rentalExtensionEnabled: true });

    const period = periods();
    const booking = await postBooking(f, bookingBody(f, { period }));
    expect(booking.status).toBe(201);
    const token = booking.body.data.portal.token as string;
    const reservationId = booking.body.data.reservation.reference as string;
    const orderId = await activateBookedOrder(f, reservationId);

    const requestedEndAt = nextDay(period.endAt);
    const res = await request(server)
      .post(`${API}/portal/orders/${token}/extensions`)
      .send({ requestedEndAt, note: 'Perlu tambahan satu hari.' });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.data.extension).toMatchObject({
      orderId,
      status: 'PENDING_APPROVAL',
      requestedEndAt,
      previousEndAt: period.endAt,
      amount: String(f.rate),
      currency: 'IDR',
      requestedByUserId: null,
    });
    expect(res.body.data.portalExpiresAt).toBeTruthy();

    // Portal membaca status dari server (bukan hanya respons POST) agar tamu
    // tetap melihat hasilnya setelah menutup halaman.
    const portalView = await request(server).get(`${API}/portal/orders/${token}`);
    expect(portalView.status).toBe(200);
    expect(portalView.headers['cache-control']).toContain('no-store');
    expect(portalView.body.data.extensionsEnabled).toBe(true);
    expect(portalView.body.data.extensions).toHaveLength(1);
    expect(portalView.body.data.extensions[0]).toMatchObject({
      id: res.body.data.extension.id,
      status: 'PENDING_APPROVAL',
      requestedEndAt,
      previousEndAt: period.endAt,
      amount: String(f.rate),
      currency: 'IDR',
      decidedAt: null,
      decisionReason: null,
    });

    // Order belum berubah sampai staff menyetujui.
    const order = await request(server)
      .get(`${base(f.tenantId)}/orders/${orderId}`)
      .set('Cookie', f.cookie);
    expect(order.body.data.totalAmount).toBe(String(f.rate));

    // Audit mencatat sumber PORTAL tanpa aktor user.
    const audit = await prisma.withTenant(f.tenantId, (tx) =>
      tx.auditLog.findFirst({
        where: { action: 'ORDER_EXTENSION_REQUESTED', entityId: res.body.data.extension.id },
      }),
    );
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBeNull();
    expect((audit!.metadata as Record<string, unknown>).source).toBe('PORTAL');

    // Persetujuan staff memakai jalur perpanjangan yang sudah ada.
    const approve = await request(server)
      .post(`${base(f.tenantId)}/orders/${orderId}/extensions/${res.body.data.extension.id}/approve`)
      .set(auth(f))
      .send({});
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe('APPROVED');

    const decidedView = await request(server).get(`${API}/portal/orders/${token}`);
    expect(decidedView.body.data.extensions[0]).toMatchObject({
      id: res.body.data.extension.id,
      status: 'APPROVED',
    });

    const after = await request(server)
      .get(`${base(f.tenantId)}/orders/${orderId}`)
      .set('Cookie', f.cookie);
    expect(after.body.data.totalAmount).toBe(String(f.rate * 2));
  });

  it('permintaan kedua saat masih pending → 409 tanpa membuat baris baru', async () => {
    const f = await setupFixture('portalextpending');
    await updateSettings(f, { rentalExtensionEnabled: true });
    const period = periods();
    const booking = await postBooking(f, bookingBody(f, { period }));
    const token = booking.body.data.portal.token as string;
    await activateBookedOrder(f, booking.body.data.reservation.reference as string);

    const url = `${API}/portal/orders/${token}/extensions`;
    const first = await request(server).post(url).send({ requestedEndAt: nextDay(period.endAt) });
    expect(first.status).toBe(201);

    const second = await request(server).post(url).send({ requestedEndAt: nextDay(period.endAt, 2) });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('fitur perpanjangan nonaktif → 422; tanpa order → 409; token tidak valid → 404', async () => {
    const disabled = await setupFixture('portalextoff');
    const period = periods();
    const booking = await postBooking(disabled, bookingBody(disabled, { period }));
    const token = booking.body.data.portal.token as string;
    await activateBookedOrder(disabled, booking.body.data.reservation.reference as string);

    const off = await request(server)
      .post(`${API}/portal/orders/${token}/extensions`)
      .send({ requestedEndAt: nextDay(period.endAt) });
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    // Portal tetap bisa dibuka; hanya pengajuan baru yang ditolak.
    const portalOff = await request(server).get(`${API}/portal/orders/${token}`);
    expect(portalOff.status).toBe(200);
    expect(portalOff.body.data.extensionsEnabled).toBe(false);
    expect(portalOff.body.data.extensions).toEqual([]);

    // Booking yang belum dikonversi menjadi order tidak punya periode sah.
    const unconverted = await setupFixture('portalextnone');
    await updateSettings(unconverted, { rentalExtensionEnabled: true });
    const freshPeriod = periods();
    const early = await postBooking(unconverted, bookingBody(unconverted, { period: freshPeriod }));
    const beforeOrder = await request(server)
      .post(`${API}/portal/orders/${early.body.data.portal.token}/extensions`)
      .send({ requestedEndAt: nextDay(freshPeriod.endAt) });
    expect(beforeOrder.status).toBe(409);

    const invalid = await request(server)
      .post(`${API}/portal/orders/bukan-token-valid/extensions`)
      .send({ requestedEndAt: nextDay(freshPeriod.endAt) });
    expect(invalid.status).toBe(404);
  });

  it('tanggal akhir yang tidak memperpanjang ditolak 400', async () => {
    const f = await setupFixture('portalextdate');
    await updateSettings(f, { rentalExtensionEnabled: true });
    const period = periods();
    const booking = await postBooking(f, bookingBody(f, { period }));
    await activateBookedOrder(f, booking.body.data.reservation.reference as string);

    const res = await request(server)
      .post(`${API}/portal/orders/${booking.body.data.portal.token}/extensions`)
      .send({ requestedEndAt: period.endAt });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ============================================================
// Domain kustom tenant (TenantDomain)
// ============================================================

describe('Publik — domain kustom tenant', () => {
  function uniqueHost(prefix: string) {
    return `${prefix}-${Date.now() % 1_000_000}-${Math.floor(Math.random() * 1000)}.example.com`;
  }

  /** Baris domain ditulis dalam konteks tenant (RLS), seperti alur internal. */
  async function addDomain(
    tenantId: string,
    hostname: string,
    opts: { verified?: boolean; active?: boolean } = {},
  ) {
    return prisma.withTenant(tenantId, (tx) =>
      tx.tenantDomain.create({
        data: {
          tenantId,
          hostname,
          verifiedAt: opts.verified === false ? null : new Date(),
          isActive: opts.active ?? true,
        },
      }),
    );
  }

  function resolveHost(hostname: string) {
    return request(server).get(`${API}/public/resolve-host`).query({ host: hostname });
  }

  it('domain terverifikasi + aktif mengembalikan tenant tanpa UUID', async () => {
    const f = await setupFixture('pubdomain');
    const hostname = uniqueHost('katalog');
    await addDomain(f.tenantId, hostname);

    const response = await resolveHost(hostname);
    expect(response.status).toBe(200);
    expect(response.body.data.tenant.slug).toBe(f.tenantSlug);
    expect(response.body.data.tenant.name).toBe('Tenant pubdomain');
    expect(response.body.data.tenant.timezone).toBe('Asia/Jakarta');
    expect(response.body.data.tenant.id).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(f.tenantId);
  });

  it('hostname dinormalisasi: huruf besar, port, dan titik akhir tetap cocok', async () => {
    const f = await setupFixture('pubnormalisasi');
    const hostname = uniqueHost('normalisasi');
    await addDomain(f.tenantId, hostname);

    const upper = await resolveHost(`${hostname.toUpperCase()}:443`);
    const trailingDot = await resolveHost(`${hostname}.`);

    expect(upper.status).toBe(200);
    expect(upper.body.data.tenant.slug).toBe(f.tenantSlug);
    expect(trailingDot.status).toBe(200);
    expect(trailingDot.body.data.tenant.slug).toBe(f.tenantSlug);
  });

  it('domain belum diverifikasi atau nonaktif → 404 netral', async () => {
    const f = await setupFixture('pubdraftdomain');
    const unverified = uniqueHost('unverified');
    const inactive = uniqueHost('inactive');
    await addDomain(f.tenantId, unverified, { verified: false, active: true });
    await addDomain(f.tenantId, inactive, { verified: true, active: false });

    for (const hostname of [unverified, inactive]) {
      const response = await resolveHost(hostname);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
      expect(response.body.error.message).toBe('Katalog tidak ditemukan.');
    }
  });

  it('hostname asing dan bentuk tidak valid dijawab 404 yang sama', async () => {
    const f = await setupFixture('pubhostasing');
    // Domain tenant lain tidak boleh ikut tersaji untuk hostname asing.
    await addDomain(f.tenantId, uniqueHost('milik'));

    for (const hostname of [
      uniqueHost('tidak-terdaftar'),
      '127.0.0.1',
      'localhost',
      '-invalid-.example.com',
      'tanpa-titik',
    ]) {
      const response = await resolveHost(hostname);
      expect(response.status).toBe(404);
      expect(response.body.error.message).toBe('Katalog tidak ditemukan.');
    }
  });

  it('tenant SUSPENDED dengan domain aktif tetap 404', async () => {
    const f = await setupFixture('pubsuspended');
    const hostname = uniqueHost('suspended');
    await addDomain(f.tenantId, hostname);
    await prisma.withTenant(f.tenantId, (tx) =>
      tx.tenant.update({ where: { id: f.tenantId }, data: { status: 'SUSPENDED' } }),
    );

    const response = await resolveHost(hostname);
    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe('Katalog tidak ditemukan.');
  });

  it('domain tenant A tidak pernah mengarah ke katalog tenant B', async () => {
    const a = await setupFixture('pubdomainA');
    const b = await setupFixture('pubdomainB');
    const hostA = uniqueHost('tenant-a');
    await addDomain(a.tenantId, hostA);

    const resolved = await resolveHost(hostA);
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.tenant.slug).toBe(a.tenantSlug);
    expect(resolved.body.data.tenant.slug).not.toBe(b.tenantSlug);

    const catalog = await request(server).get(
      `${API}/public/${resolved.body.data.tenant.slug}/catalog`,
    );
    expect(catalog.body.data.products[0].id).toBe(a.productId);
    expect(catalog.body.data.products[0].id).not.toBe(b.productId);
  });
});

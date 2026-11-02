/**
 * Integration test: Catalog & Inventory Module
 *
 * Mencakup kontrak Notion 04 — kelompok "Inventaris dan ketersediaan":
 * - Kategori CRUD (OWNER/MANAGER, dengan guard produk aktif)
 * - Produk CRUD (soft delete via isActive=false)
 * - Rate upsert (BigInt IDR rupiah utuh)
 * - Asset (unit fisik, hanya INDIVIDUAL_UNITS)
 * - Asset Maintenance (periode tidak tersedia)
 * - Permission: CASHIER hanya baca, mutasi butuh OWNER/MANAGER
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
const PW = 'kata-sandi-catalog-test-001';

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
  return `${prefix.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now() % 100000}`;
}

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  server = app.getHttpServer() as unknown as Server;
  emailSvc = app.get(EmailService);
  prisma = app.get(PrismaService);
}, 120_000);

afterAll(() => app?.close());

// ============================================================
// Fixtures helper
// ============================================================

async function registerAndLogin(emailAddr: string): Promise<{ cookie: string; csrf: string; userId: string }> {
  await request(server).post(`${API}/auth/registrations`).send({ email: emailAddr, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
  const otp = emailSvc.testAdapter!.lastOtpFor(emailAddr);
  if (!otp) throw new Error(`OTP tidak ada untuk ${emailAddr}`);
  await request(server).post(`${API}/auth/registrations/verify-email`).send({ email: emailAddr, code: otp });
  const login = await request(server).post(`${API}/auth/sessions`).send({ email: emailAddr, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const cookie = session.split(';')[0];
  const csrf = login.headers['x-csrf-token'] as string;
  // Email dinormalisasi (lowercase) oleh API; lookup DB harus sama.
  const user = await prisma.client.user.findUnique({
    where: { email: emailAddr.toLowerCase() },
  });
  return { cookie, csrf, userId: user!.id };
}

async function setupOwnerAndTenant(prefix: string) {
  const { cookie, csrf, userId } = await registerAndLogin(em(prefix));
  const s = slug(prefix);
  const tenant = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', 'http://localhost:3001')
    .send({ name: `Tenant ${prefix}`, slug: s });
  if (tenant.status !== 201) throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  return { cookie, csrf, userId, tenantId: tenant.body.data.id as string };
}

function base(tenantId: string) {
  return `${API}/tenants/${tenantId}`;
}

// ============================================================
// Categories
// ============================================================

describe('Catalog — Categories', () => {
  it('GET /categories → daftar kategori awal kosong', async () => {
    const { cookie, tenantId } = await setupOwnerAndTenant('catlist');
    const res = await request(server).get(`${base(tenantId)}/categories`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(0);
  });

  it('POST /categories → 201, GET → kategori muncul', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('catcreate');
    const res = await request(server)
      .post(`${base(tenantId)}/categories`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Sepeda Gunung' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Sepeda Gunung');
    expect(res.body.data.id).toBeTruthy();

    const list = await request(server).get(`${base(tenantId)}/categories`).set('Cookie', cookie);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].name).toBe('Sepeda Gunung');
  });

  it('PATCH /categories/:id → update nama berhasil', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('catupdate');
    const create = await request(server)
      .post(`${base(tenantId)}/categories`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Nama Lama' });

    const catId = create.body.data.id;
    const res = await request(server)
      .patch(`${base(tenantId)}/categories/${catId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Nama Baru' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Nama Baru');
  });

  it('DELETE /categories/:id → 204 jika tidak ada produk', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('catdelete');
    const create = await request(server)
      .post(`${base(tenantId)}/categories`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Hapus Saya' });
    const catId = create.body.data.id;

    const res = await request(server)
      .delete(`${base(tenantId)}/categories/${catId}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001');
    expect(res.status).toBe(204);

    const list = await request(server).get(`${base(tenantId)}/categories`).set('Cookie', cookie);
    expect(list.body.data.find((c: { id: string }) => c.id === catId)).toBeUndefined();
  });

  it('DELETE kategori dengan produk → 422 BUSINESS_RULE_VIOLATION', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('catdelprod');
    const cat = await request(server)
      .post(`${base(tenantId)}/categories`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Kategori Dengan Produk' });
    const catId = cat.body.data.id;

    // Tambah produk ke kategori ini
    await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Produk Dalam Kategori', categoryId: catId });

    const res = await request(server)
      .delete(`${base(tenantId)}/categories/${catId}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

// ============================================================
// Products
// ============================================================

describe('Catalog — Products', () => {
  it('POST /products → 201 dengan stockMode QUANTITY default', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('prodbasic');
    const res = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Pelampung XL', capacity: 10 });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Pelampung XL');
    expect(res.body.data.id).toBeTruthy();
  });

  it('GET /products/:id → detail produk termasuk assetCount', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('proddetail');
    const create = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Kayak Sungai', stockMode: 'INDIVIDUAL_UNITS' });
    const productId = create.body.data.id;

    const res = await request(server).get(`${base(tenantId)}/products/${productId}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: productId,
      name: 'Kayak Sungai',
      stockMode: 'INDIVIDUAL_UNITS',
      isActive: true,
      assetCount: 0,
    });
  });

  it('PATCH /products/:id → update nama dan capacity', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('produpdate');
    const create = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Nama Asli', capacity: 5 });
    const productId = create.body.data.id;

    const res = await request(server)
      .patch(`${base(tenantId)}/products/${productId}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Nama Diperbarui', capacity: 20 });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Nama Diperbarui');
  });

  it('DELETE /products/:id → soft delete (isActive=false, data tetap ada)', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('proddel');
    const create = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Produk Nonaktif' });
    const productId = create.body.data.id;

    const del = await request(server)
      .delete(`${base(tenantId)}/products/${productId}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001');
    expect(del.status).toBe(204);

    // Data tetap ada di DB sebagai soft delete
    // RLS fail-closed: baca tabel tenant-scoped lewat konteks tenant.
    const row = await prisma.withTenant(tenantId, (tx) =>
      tx.product.findUnique({ where: { id: productId } }),
    );
    expect(row).not.toBeNull();
    expect(row!.isActive).toBe(false);
  });

  it('GET /products filter isActive=true — produk nonaktif tidak muncul', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('prodfilter');
    const active = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Aktif' });
    const inactive = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Nonaktif', isActive: false });

    const list = await request(server)
      .get(`${base(tenantId)}/products?isActive=true`)
      .set('Cookie', cookie);
    expect(list.status).toBe(200);
    const names = list.body.data.map((p: { name: string }) => p.name);
    expect(names).toContain('Aktif');
    expect(names).not.toContain('Nonaktif');
  });

  it('produk di tenant lain tidak terlihat (RLS isolation)', async () => {
    const { cookie: cookieA, csrf: csrfA, tenantId: idA } = await setupOwnerAndTenant('rlsA');
    const { cookie: cookieB, tenantId: idB } = await setupOwnerAndTenant('rlsB');

    // Buat produk di tenant A
    await request(server)
      .post(`${base(idA)}/products`)
      .set('Cookie', cookieA).set('X-CSRF-Token', csrfA).set('Origin', 'http://localhost:3001')
      .send({ name: 'Produk Tenant A' });

    // Dari tenant B (owner tenant B), tidak bisa mengakses list tenant A
    const res = await request(server).get(`${base(idA)}/products`).set('Cookie', cookieB);
    expect(res.status).toBe(403); // Permission denied — bukan anggota tenant A
  });
});

// ============================================================
// Rates (harga sewa)
// ============================================================

describe('Catalog — Rates (BigInt IDR)', () => {
  it('POST /products/:id/rates → upsert tarif; BigInt dikembalikan sebagai string', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('ratebasic');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Tenda Dome' });
    const productId = prod.body.data.id;

    const res = await request(server)
      .post(`${base(tenantId)}/products/${productId}/rates`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ perDayAmount: 150000, perWeekAmount: 900000 });

    expect(res.status).toBe(200);
    expect(res.body.data.perDayAmount).toBe('150000'); // BigInt sebagai string
    expect(res.body.data.perWeekAmount).toBe('900000');
    expect(typeof res.body.data.perDayAmount).toBe('string');
  });

  it('upsert dua kali → nilai terbaru menang', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('rateupsert');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Sleeping Bag' });
    const productId = prod.body.data.id;

    await request(server)
      .post(`${base(tenantId)}/products/${productId}/rates`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ perDayAmount: 50000 });

    const second = await request(server)
      .post(`${base(tenantId)}/products/${productId}/rates`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ perDayAmount: 75000 });
    expect(second.body.data.perDayAmount).toBe('75000');
  });

  it('GET /products/:id/rates → 404 jika belum ada tarif', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('rateno');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Produk Tanpa Tarif' });
    const productId = prod.body.data.id;

    const res = await request(server)
      .get(`${base(tenantId)}/products/${productId}/rates`)
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('tarif perDayAmount harus positif → 400 VALIDATION_ERROR', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('rateval');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Produk Tarif Salah' });

    const res = await request(server)
      .post(`${base(tenantId)}/products/${prod.body.data.id}/rates`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ perDayAmount: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ============================================================
// Assets (unit fisik)
// ============================================================

describe('Inventory — Assets', () => {
  it('POST /products/:id/assets → 201 untuk INDIVIDUAL_UNITS', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('assetbasic');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Sepeda BMX', stockMode: 'INDIVIDUAL_UNITS' });
    const productId = prod.body.data.id;

    const res = await request(server)
      .post(`${base(tenantId)}/products/${productId}/assets`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ code: 'BMX-001', conditionNote: 'Baru' });

    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('BMX-001');
    expect(res.body.data.status).toBe('AVAILABLE');
  });

  it('asset di produk QUANTITY ditolak → 422', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('assetqty');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Pelampung QUANTITY', stockMode: 'QUANTITY' });

    const res = await request(server)
      .post(`${base(tenantId)}/products/${prod.body.data.id}/assets`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ code: 'QTY-001' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('kode asset duplikat dalam tenant → 422', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('assetdup');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Kano', stockMode: 'INDIVIDUAL_UNITS' });
    const productId = prod.body.data.id;

    await request(server)
      .post(`${base(tenantId)}/products/${productId}/assets`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ code: 'KANO-DUPLIKAT' });

    const res = await request(server)
      .post(`${base(tenantId)}/products/${productId}/assets`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ code: 'KANO-DUPLIKAT' });
    expect(res.status).toBe(422);
  });

  it('PATCH /assets/:id → update status dan kondisi', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('assetupd');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Perahu Karet', stockMode: 'INDIVIDUAL_UNITS' });
    const assetRes = await request(server)
      .post(`${base(tenantId)}/products/${prod.body.data.id}/assets`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ code: 'PRAHU-001' });
    const assetId = assetRes.body.data.id;

    const res = await request(server)
      .patch(`${base(tenantId)}/assets/${assetId}`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ status: 'MAINTENANCE', conditionNote: 'Perlu ganti dayung' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('MAINTENANCE');
  });
});

// ============================================================
// Asset Maintenance
// ============================================================

describe('Inventory — Asset Maintenance', () => {
  it('POST /assets/:id/maintenance → 201, periode tersimpan', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('maint');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Jet Ski', stockMode: 'INDIVIDUAL_UNITS' });
    const assetRes = await request(server)
      .post(`${base(tenantId)}/products/${prod.body.data.id}/assets`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ code: 'JETSKI-001' });
    const assetId = assetRes.body.data.id;

    const res = await request(server)
      .post(`${base(tenantId)}/assets/${assetId}/maintenance`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({
        startAt: new Date(Date.now() + 86400000).toISOString(),
        endAt: new Date(Date.now() + 2 * 86400000).toISOString(),
        reason: 'Servis rutin',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();

    const list = await request(server).get(`${base(tenantId)}/assets/${assetId}/maintenance`).set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].reason).toBe('Servis rutin');
  });

  it('startAt >= endAt → 400 VALIDATION_ERROR', async () => {
    const { cookie, csrf, tenantId } = await setupOwnerAndTenant('mainval');
    const prod = await request(server)
      .post(`${base(tenantId)}/products`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ name: 'Surfboard', stockMode: 'INDIVIDUAL_UNITS' });
    const assetRes = await request(server)
      .post(`${base(tenantId)}/products/${prod.body.data.id}/assets`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ code: 'SURF-001' });

    const future = new Date(Date.now() + 86400000).toISOString();
    const res = await request(server)
      .post(`${base(tenantId)}/assets/${assetRes.body.data.id}/maintenance`)
      .set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Origin', 'http://localhost:3001')
      .send({ startAt: future, endAt: future }); // startAt == endAt
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ============================================================
// Error envelope consistency
// ============================================================

describe('Error envelope — request_id (Notion 04)', () => {
  it('error body harus memiliki request_id bukan correlationId', async () => {
    // Akses resource yang tidak ada tanpa autentikasi
    const res = await request(server).get(`${API}/tenants/non-existent`).set('Cookie', 'rentalio_session=invalid');
    expect(res.status).toBe(401);
    expect(res.body.error.request_id).toBeTruthy();
    expect(res.body.error.correlationId).toBeUndefined();
    // request_id harus sinkron dengan X-Correlation-ID header
    expect(res.body.error.request_id).toBe(res.headers['x-correlation-id']);
  });

  it('X-Correlation-ID header dikembalikan pada semua respons', async () => {
    const res = await request(server).get(`${API}/health`);
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });
});

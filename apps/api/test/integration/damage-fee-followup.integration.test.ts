/**
 * Integration test: kelanjutan denda kerusakan (dokumen 15).
 *
 * Mencakup kontrak baru:
 * - POST /tenants/:t/orders/:o/penalties                 → tagihan order
 * - POST /tenants/:t/orders/:o/deposit-deductions        → tautan inspeksi
 * - POST /tenants/:t/inspections/:id/attachments         → lampiran R2
 * - GET  /tenants/:t/damage-fee-revisions                → riwayat kebijakan
 * - GET/PUT /tenants/:t/damage-fee-categories            → override kategori
 * - GET  /tenants/:t/reports/damage-fees                 → laporan
 *
 * Fixture order disiapkan langsung via PrismaService (modul order HTTP belum
 * membuat order dari nol), dengan konteks tenant sehingga RLS aktif.
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
const PW = 'kata-sandi-damage-followup-001';
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

interface Fixture {
  cookie: string;
  csrf: string;
  userId: string;
  tenantId: string;
  productId: string;
  assetId: string;
  orderId: string;
}

function auth(req: request.Test, fx: { cookie: string; csrf: string }): request.Test {
  return req.set('Cookie', fx.cookie).set('X-CSRF-Token', fx.csrf).set('Origin', ORIGIN);
}

async function setupOrder(prefix: string): Promise<Fixture> {
  const emailAddr = em(prefix);
  await request(server)
    .post(`${API}/auth/registrations`)
    .send({
      email: emailAddr,
      password: PW,
      termsAccepted: true,
      termsVersion: '2026-10-14',
      privacyVersion: '2026-10-14',
    });
  const otp = emailSvc.testAdapter!.lastOtpFor(emailAddr);
  if (!otp) throw new Error(`OTP tidak ada untuk ${emailAddr}`);
  await request(server).post(`${API}/auth/registrations/verify-email`).send({ email: emailAddr, code: otp });
  const login = await request(server)
    .post(`${API}/auth/sessions`)
    .send({ email: emailAddr, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const cookie = session.split(';')[0];
  const csrf = login.headers['x-csrf-token'] as string;
  const user = await prisma.client.user.findUnique({
    where: { email: emailAddr.toLowerCase() },
  });

  const tenant = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', ORIGIN)
    .send({ name: `Tenant ${prefix}`, slug: slug(prefix) });
  if (tenant.status !== 201) throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.data.id as string;

  const product = await auth(
    request(server).post(`${base(tenantId)}/products`),
    { cookie, csrf },
  ).send({ name: `Produk ${prefix}`, stockMode: 'INDIVIDUAL_UNITS' });
  if (product.status !== 201) throw new Error(`Gagal buat produk: ${JSON.stringify(product.body)}`);
  const productId = product.body.data.id as string;

  const asset = await auth(
    request(server).post(`${base(tenantId)}/products/${productId}/assets`),
    { cookie, csrf },
  ).send({ code: `UNIT-${Date.now() % 1000000}` });
  if (asset.status !== 201) throw new Error(`Gagal buat asset: ${JSON.stringify(asset.body)}`);
  const assetId = asset.body.data.id as string;

  const orderId = await prisma.withTenant(tenantId, async (tx) => {
    const order = await tx.rentalOrder.create({
      data: {
        tenantId,
        orderNumber: `ORD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        status: 'CONFIRMED',
      },
    });
    await tx.rentalItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId,
        assetId,
        quantity: 1,
        startAt: new Date('2026-10-01T00:00:00.000Z'),
        endAt: new Date('2026-10-05T00:00:00.000Z'),
        priceSnapshot: 500_000n,
      },
    });
    await tx.asset.update({ where: { id: assetId }, data: { status: 'RESERVED' } });
    return order.id;
  });

  return { cookie, csrf, userId: user!.id, tenantId, productId, assetId, orderId };
}

function setDamage(fx: Fixture, body: Record<string, unknown>): request.Test {
  return auth(request(server).patch(`${base(fx.tenantId)}/settings`), fx).send(body);
}

async function completedReturn(fx: Fixture): Promise<string> {
  const created = await auth(
    request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/returns`),
    fx,
  ).send({ items: [{ productId: fx.productId, assetId: fx.assetId, quantity: 1 }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const completed = await auth(
    request(server).patch(`${base(fx.tenantId)}/returns/${created.body.data.id}/complete`),
    fx,
  ).send({});
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return created.body.data.id as string;
}

async function approveInspection(
  fx: Fixture,
  amount: number,
  body: Record<string, unknown> = {},
): Promise<string> {
  const returnId = await completedReturn(fx);
  const inspection = await auth(
    request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
    fx,
  ).send({ returnRecordId: returnId, ...body });
  expect(inspection.status, JSON.stringify(inspection.body)).toBe(201);
  const id = inspection.body.data.id as string;
  await auth(request(server).patch(`${base(fx.tenantId)}/inspections/${id}/submit`), fx).send({});
  const decided = await auth(
    request(server).patch(`${base(fx.tenantId)}/inspections/${id}/decision`),
    fx,
  ).send({ decision: 'APPROVE', penaltyAmount: amount });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  return id;
}

describe('Denda kerusakan — tagihan order', () => {
  it('mencatat denda APPROVED sebagai tagihan dan idempoten per inspeksi', async () => {
    const fx = await setupOrder('pencharge');
    const inspectionId = await approveInspection(fx, 125_000);

    const created = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId, reason: 'Bodi penyok saat kembali' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.amount).toBe('125000');
    expect(created.body.data.inspectionId).toBe(inspectionId);

    const again = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId, reason: 'Bodi penyok saat kembali' });
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(created.body.data.id);

    const order = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}`),
      fx,
    );
    expect(order.body.data.penaltyTotalAmount).toBe('125000');
    expect(order.body.data.penalties).toHaveLength(1);
    expect(order.body.data.amountDue).toBe('125000');
    // Harga sewa tidak ikut berubah oleh denda.
    expect(order.body.data.totalAmount).toBe('0');

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId: fx.tenantId, action: 'ORDER_PENALTY_CREATED' } }),
    );
    expect(audits).toHaveLength(1);
  });

  it('menolak tagihan dari inspeksi yang belum diputuskan', async () => {
    const fx = await setupOrder('penunapproved');
    const inspection = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({});
    const res = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId: inspection.body.data.id, reason: 'Belum diputuskan' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('Denda kerusakan — pembatalan denda', () => {
  it('membatalkan denda sekali, mengeluarkannya dari tagihan, dan menyimpan alasan', async () => {
    const fx = await setupOrder('penvoid');
    const inspectionId = await approveInspection(fx, 90_000);
    const created = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId, reason: 'Kerusakan unit' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const penaltyId = created.body.data.id as string;

    const voided = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${fx.orderId}/penalties/${penaltyId}/void`,
      ),
      fx,
    ).send({ reason: 'Salah unit, sudah diganti pelanggan' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe('VOIDED');
    expect(voided.body.data.voidedReason).toBe('Salah unit, sudah diganti pelanggan');
    expect(voided.body.data.voidedAt).toBeTruthy();

    const order = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}`),
      fx,
    );
    expect(order.body.data.penaltyTotalAmount).toBe('0');
    expect(order.body.data.amountDue).toBe('0');
    // Baris tetap tampil sebagai riwayat, bukan dihapus.
    expect(order.body.data.penalties).toHaveLength(1);
    expect(order.body.data.penalties[0].status).toBe('VOIDED');

    // Idempoten: tidak ada audit kedua dan alasan lama tidak ditimpa.
    const again = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${fx.orderId}/penalties/${penaltyId}/void`,
      ),
      fx,
    ).send({ reason: 'Percobaan kedua' });
    expect(again.status).toBe(200);
    expect(again.body.data.voidedReason).toBe('Salah unit, sudah diganti pelanggan');

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId: fx.tenantId, action: 'ORDER_PENALTY_VOIDED' } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe('Salah unit, sudah diganti pelanggan');
  });

  it('menolak pembatalan denda milik order lain', async () => {
    const fx = await setupOrder('penvoid404');
    const other = await setupOrder('penvoid404b');
    const inspectionId = await approveInspection(fx, 50_000);
    const created = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId, reason: 'Kerusakan unit' });
    const penaltyId = created.body.data.id as string;

    const res = await auth(
      request(server).post(
        `${base(other.tenantId)}/orders/${other.orderId}/penalties/${penaltyId}/void`,
      ),
      other,
    ).send({ reason: 'Denda orang lain' });
    expect(res.status).toBe(404);
  });
});

describe('Denda kerusakan — batas total per order', () => {
  it('menolak tagihan yang melewati batas akumulasi order dan menerima yang di bawahnya', async () => {
    const fx = await setupOrder('pencap');
    await setDamage(fx, {
      damageFeeEnabled: true,
      damageFeeSevereAmount: 200_000,
      damagePenaltyOrderMaxAmount: 150_000,
    });
    const inspectionId = await approveInspection(fx, 200_000);

    const rejected = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId, reason: 'Melebihi batas order' });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    const raised = await setDamage(fx, { damagePenaltyOrderMaxAmount: 300_000 });
    expect(raised.status).toBe(204);

    const accepted = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId, reason: 'Masih dalam batas order' });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.data.amount).toBe('200000');
  });
});

describe('Denda kerusakan — potongan deposit', () => {
  it('nominal harus sama dengan denda dan hanya sekali per inspeksi', async () => {
    const fx = await setupOrder('pendeposit');
    const inspectionId = await approveInspection(fx, 75_000);

    const deposit = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`),
      fx,
    ).send({ amount: '500000', currency: 'IDR' });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(201);

    const wrong = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-deductions`),
      fx,
    ).send({ amount: '50000', currency: 'IDR', reason: 'Denda kerusakan', inspectionId });
    expect(wrong.status).toBe(400);

    const ok = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-deductions`),
      fx,
    ).send({ amount: '75000', currency: 'IDR', reason: 'Denda kerusakan', inspectionId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.inspectionId).toBe(inspectionId);
    expect(ok.body.data.status).toBe('PENDING');

    const duplicate = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-deductions`),
      fx,
    ).send({ amount: '75000', currency: 'IDR', reason: 'Denda kerusakan', inspectionId });
    expect(duplicate.status).toBe(422);
  });
});

describe('Denda kerusakan — lampiran inspeksi', () => {
  it('membatasi namespace tenant, tipe, dan menyimpan metadata', async () => {
    const fx = await setupOrder('penattach');
    const inspectionId = await approveInspection(fx, 10_000);

    const foreignKey = await auth(
      request(server).post(`${base(fx.tenantId)}/inspections/${inspectionId}/attachments`),
      fx,
    ).send({ objectKey: 'tenants/tenant-lain/inspections/foto.jpg', mimeType: 'image/jpeg' });
    expect(foreignKey.status).toBe(400);

    const badMime = await auth(
      request(server).post(`${base(fx.tenantId)}/inspections/${inspectionId}/attachments`),
      fx,
    ).send({
      objectKey: `tenants/${fx.tenantId}/inspections/foto.txt`,
      mimeType: 'text/plain',
    });
    expect(badMime.status).toBe(400);

    const ok = await auth(
      request(server).post(`${base(fx.tenantId)}/inspections/${inspectionId}/attachments`),
      fx,
    ).send({
      objectKey: `tenants/${fx.tenantId}/inspections/foto.jpg`,
      mimeType: 'image/jpeg',
      fileSizeBytes: 2048,
      altText: 'Bodi penyok',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.attachments).toHaveLength(1);
    expect(ok.body.data.attachments[0].altText).toBe('Bodi penyok');

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: fx.tenantId, action: 'INSPECTION_ATTACHMENT_ADDED' },
      }),
    );
    expect(audits).toHaveLength(1);
  });
});

describe('Denda kerusakan — per item, plafon, dan guardrail', () => {
  it('menjumlahkan usulan per item lalu memotongnya dengan plafon', async () => {
    const fx = await setupOrder('penitems');
    await setDamage(fx, {
      damageInspectionEnabled: true,
      damageFeeEnabled: true,
      damageFeeMinorAmount: 25_000,
      damageFeeModerateAmount: 100_000,
      damageFeeSevereAmount: 400_000,
      damageFeeMaxAmount: 100_000,
    });
    const returnId = await completedReturn(fx);

    const created = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({
      returnRecordId: returnId,
      items: [{ productId: fx.productId, assetId: fx.assetId, quantity: 1, severity: 'SEVERE' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.items).toHaveLength(1);
    expect(created.body.data.items[0].suggestedAmount).toBe('400000');
    expect(created.body.data.suggestedPenaltyAmount).toBe('100000');
    expect(created.body.data.damageFee.capped).toBe(true);
    expect(created.body.data.damageFee.rawAmount).toBe('400000');
    expect(created.body.data.suggestedTotal.damageFee).toBe('100000');
    expect(created.body.data.suggestedTotal.total).toBe('100000');
  });

  it('menolak item di luar order dan inspeksi aktif kedua pada order yang sama', async () => {
    const fx = await setupOrder('penone');
    const otherProduct = await auth(
      request(server).post(`${base(fx.tenantId)}/products`),
      fx,
    ).send({ name: 'Produk Bukan Order' });

    const invalid = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({ items: [{ productId: otherProduct.body.data.id, severity: 'MINOR' }] });
    expect(invalid.status).toBe(422);

    const first = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({});
    expect(first.status).toBe(201);

    const second = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({});
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Denda kerusakan — riwayat dan kategori', () => {
  it('menyimpan riwayat kebijakan dan memakai nominal kategori sebagai override', async () => {
    const fx = await setupOrder('pencat');
    const category = await auth(
      request(server).post(`${base(fx.tenantId)}/categories`),
      fx,
    ).send({ name: 'Elektronik' });
    expect(category.status, JSON.stringify(category.body)).toBe(201);
    const categoryId = category.body.data.id as string;

    const patched = await auth(
      request(server).patch(`${base(fx.tenantId)}/products/${fx.productId}`),
      fx,
    ).send({ categoryId });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    expect((await setDamage(fx, { damageFeeEnabled: true, damageFeeSevereAmount: 400_000 })).status).toBe(204);
    expect((await setDamage(fx, { damageFeeSevereAmount: 350_000 })).status).toBe(204);

    const revisions = await auth(
      request(server).get(`${base(fx.tenantId)}/damage-fee-revisions`),
      fx,
    );
    expect(revisions.status).toBe(200);
    expect(revisions.body.data.length).toBeGreaterThanOrEqual(2);
    expect(revisions.body.data[0].severeAmount).toBe('350000');

    const override = await auth(
      request(server).put(`${base(fx.tenantId)}/damage-fee-categories`),
      fx,
    ).send({ categoryId, severeAmount: 50_000 });
    expect(override.status, JSON.stringify(override.body)).toBe(200);

    const returnId = await completedReturn(fx);
    const inspection = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({
      returnRecordId: returnId,
      items: [{ productId: fx.productId, quantity: 1, severity: 'SEVERE' }],
    });
    expect(inspection.status, JSON.stringify(inspection.body)).toBe(201);
    // Override kategori (50.000) menang atas nominal tenant (350.000).
    expect(inspection.body.data.suggestedPenaltyAmount).toBe('50000');
  });

  it('memulihkan revisi lama sebagai revisi baru tanpa menghapus riwayat', async () => {
    const fx = await setupOrder('penrestore');
    expect(
      (
        await setDamage(fx, {
          damageInspectionEnabled: true,
          damageFeeEnabled: true,
          damageFeeSevereAmount: 300_000,
          damageFeeMaxAmount: 500_000,
        })
      ).status,
    ).toBe(204);

    const before = await auth(
      request(server).get(`${base(fx.tenantId)}/damage-fee-revisions`),
      fx,
    );
    const target = before.body.data[0];
    expect(target.severeAmount).toBe('300000');

    expect(
      (await setDamage(fx, { damageFeeSevereAmount: 100_000, damageFeeMaxAmount: null })).status,
    ).toBe(204);

    const restored = await auth(
      request(server).post(
        `${base(fx.tenantId)}/damage-fee-revisions/${target.id}/restore`,
      ),
      fx,
    ).send({});
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.data.severeAmount).toBe('300000');
    expect(restored.body.data.maxAmount).toBe('500000');
    expect(restored.body.data.id).not.toBe(target.id);

    const after = await auth(
      request(server).get(`${base(fx.tenantId)}/damage-fee-revisions`),
      fx,
    );
    expect(after.body.data).toHaveLength(3);
    expect(after.body.data[0].id).toBe(restored.body.data.id);

    const tenant = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: fx.tenantId } }),
    );
    expect(tenant.damageFeeSevereAmount).toBe(300_000n);
    expect(tenant.damageFeeMaxAmount).toBe(500_000n);

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: fx.tenantId, action: 'DAMAGE_FEE_POLICY_RESTORED' },
      }),
    );
    expect(audits).toHaveLength(1);
    expect((audits[0].metadata as { revisionId?: string }).revisionId).toBe(target.id);
  });

  it('menolak pemulihan revisi milik tenant lain', async () => {
    const owner = await setupOrder('penrestorea');
    const other = await setupOrder('penrestoreb');
    expect(
      (await setDamage(other, { damageFeeEnabled: true, damageFeeSevereAmount: 250_000 })).status,
    ).toBe(204);
    const otherRevisions = await auth(
      request(server).get(`${base(other.tenantId)}/damage-fee-revisions`),
      other,
    );

    const attempt = await auth(
      request(server).post(
        `${base(owner.tenantId)}/damage-fee-revisions/${otherRevisions.body.data[0].id}/restore`,
      ),
      owner,
    ).send({});
    expect(attempt.status).toBe(404);
  });
});

describe('Denda kerusakan — laporan', () => {
  it('meringkas denda tertagih, keputusan, dan tingkat kerusakan', async () => {
    const fx = await setupOrder('penreport');
    await setDamage(fx, { damageFeeEnabled: true, damageFeeSevereAmount: 200_000 });
    const inspectionId = await approveInspection(fx, 200_000, {
      items: [{ productId: fx.productId, quantity: 1, severity: 'SEVERE' }],
    });
    await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId, reason: 'Kerusakan parah' });

    const report = await auth(
      request(server).get(`${base(fx.tenantId)}/reports/damage-fees`),
      fx,
    );
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.data.penalties.count).toBe(1);
    expect(report.body.data.penalties.totalAmount).toBe('200000');
    expect(report.body.data.inspections.APPROVED).toBe(1);
    expect(report.body.data.inspections.DISPUTED).toBe(0);
    expect(report.body.data.penalties.voidedCount).toBe(0);
    expect(report.body.data.severity.SEVERE.lines).toBe(1);
    expect(report.body.data.severity.SEVERE.suggestedAmount).toBe('200000');
    expect(report.body.data.topProducts[0].productId).toBe(fx.productId);
    // Nama produk ikut agar laporan bisa dibaca tanpa mencocokkan id.
    expect(report.body.data.topProducts[0].productName).toContain('Produk ');
  });

  it('denda yang dibatalkan tidak masuk total, tetapi dihitung terpisah', async () => {
    const fx = await setupOrder('penreportvoid');
    await setDamage(fx, { damageFeeEnabled: true, damageFeeSevereAmount: 200_000 });
    const inspectionId = await approveInspection(fx, 150_000, {
      items: [{ productId: fx.productId, quantity: 1, severity: 'MINOR' }],
    });
    const created = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/penalties`),
      fx,
    ).send({ inspectionId, reason: 'Kerusakan unit' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const voided = await auth(
      request(server).post(
        `${base(fx.tenantId)}/orders/${fx.orderId}/penalties/${created.body.data.id}/void`,
      ),
      fx,
    ).send({ reason: 'Salah unit' });
    expect(voided.status).toBe(200);

    const report = await auth(
      request(server).get(`${base(fx.tenantId)}/reports/damage-fees`),
      fx,
    );
    expect(report.status).toBe(200);
    expect(report.body.data.penalties.count).toBe(0);
    expect(report.body.data.penalties.totalAmount).toBe('0');
    expect(report.body.data.penalties.voidedCount).toBe(1);
  });
});

describe('Storage lampiran inspeksi', () => {
  it('menerbitkan presigned upload hanya untuk tipe bukti yang diizinkan', async () => {
    const fx = await setupOrder('storageup');

    const rejected = await auth(
      request(server).post(`${base(fx.tenantId)}/storage/upload-url`),
      fx,
    ).send({ category: 'inspections', filename: 'catatan.txt', contentType: 'text/plain' });
    expect(rejected.status).toBe(400);

    const ok = await auth(
      request(server).post(`${base(fx.tenantId)}/storage/upload-url`),
      fx,
    ).send({ category: 'inspections', filename: 'foto.jpg', contentType: 'image/jpeg' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.objectKey).toMatch(
      new RegExp(`^tenants/${fx.tenantId}/inspections/[0-9a-f-]+\\.jpg$`),
    );
    expect(ok.body.data.uploadUrl).toContain('X-Amz-Signature');
  });

  it('menandatangani unduhan hanya untuk objek di namespace tenant aktif', async () => {
    const fx = await setupOrder('storagedown');
    const objectKey = `tenants/${fx.tenantId}/inspections/bukti.jpg`;

    const signed = await auth(
      request(server).get(`${base(fx.tenantId)}/storage/download-url`).query({ objectKey }),
      fx,
    );
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body.data.expiresInSeconds).toBe(300);
    expect(signed.body.data.downloadUrl).toContain('X-Amz-Signature');

    const foreign = await auth(
      request(server)
        .get(`${base(fx.tenantId)}/storage/download-url`)
        .query({ objectKey: 'tenants/tenant-lain/inspections/bukti.jpg' }),
      fx,
    );
    expect(foreign.status).toBe(400);
  });
});

describe('Denda kerusakan — pesan WhatsApp', () => {
  it('menyusun teks hasil inspeksi dari data terkini dan menolak DRAFT', async () => {
    const fx = await setupOrder('penwa');
    // Inspeksi DRAFT menahan inspeksi lain pada order yang sama, jadi uji
    // penolakan DRAFT memakai order terpisah.
    const draftFx = await setupOrder('penwadraft');
    const draft = await auth(
      request(server).post(`${base(draftFx.tenantId)}/orders/${draftFx.orderId}/inspections`),
      draftFx,
    ).send({});
    const rejected = await auth(
      request(server).get(
        `${base(draftFx.tenantId)}/inspections/${draft.body.data.id}/whatsapp-message`,
      ),
      draftFx,
    );
    expect(rejected.status).toBe(409);

    const inspectionId = await approveInspection(fx, 150_000, {
      summary: 'Tripod patah',
      items: [{ productId: fx.productId, quantity: 1, severity: 'MODERATE' }],
    });
    const message = await auth(
      request(server).get(`${base(fx.tenantId)}/inspections/${inspectionId}/whatsapp-message`),
      fx,
    );
    expect(message.status, JSON.stringify(message.body)).toBe(200);
    expect(message.body.data.text).toContain('hasil inspeksi');
    expect(message.body.data.text).toContain('Rp150.000');
    expect(message.body.data.text).toContain('Tripod patah');
    expect(message.body.data.text).toContain('Rincian kondisi');
    expect(message.body.data.inspectionStatus).toBe('APPROVED');
    expect(message.body.data.totalAmount).toBe('150000');
    expect(message.body.data.orderNumber).toBeTruthy();
  });
});

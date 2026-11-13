/**
 * Integration test: Return & Inspection Module
 *
 * Mencakup kontrak docs/openapi.yaml (tag "Return & Inspection"):
 * - POST   /tenants/:t/orders/:o/returns              → catat pengembalian
 * - GET    /tenants/:t/orders/:o/returns              → daftar pengembalian
 * - GET    /tenants/:t/returns/:id                    → detail + inspeksi
 * - PATCH  /tenants/:t/returns/:id/complete           → PENDING → COMPLETED
 * - PATCH  /tenants/:t/returns/:id/cancel             → PENDING → CANCELLED
 * - POST   /tenants/:t/orders/:o/inspections          → DRAFT
 * - GET    /tenants/:t/inspections/:id                → detail
 * - PATCH  /tenants/:t/inspections/:id/submit         → DRAFT → SUBMITTED
 * - PATCH  /tenants/:t/inspections/:id/decision       → APPROVED/REJECTED
 *
 * Berjalan terhadap PostgreSQL sewain_test (migrasi penuh dari nol).
 * Order belum memiliki modul HTTP sendiri (Sprint 1), sehingga fixture order
 * disiapkan langsung via PrismaService dengan konteks tenant (RLS aktif).
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
const PW = 'kata-sandi-returns-test-001';
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
  await request(server).post(`${API}/auth/registrations`).send({ email: emailAddr, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
  const otp = emailSvc.testAdapter!.lastOtpFor(emailAddr);
  if (!otp) throw new Error(`OTP tidak ada untuk ${emailAddr}`);
  await request(server)
    .post(`${API}/auth/registrations/verify-email`)
    .send({ email: emailAddr, code: otp });
  const login = await request(server).post(`${API}/auth/sessions`).send({ email: emailAddr, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const user = await prisma.client.user.findUnique({
    where: { email: emailAddr.toLowerCase() },
  });
  return { cookie: session.split(';')[0], csrf: login.headers['x-csrf-token'] as string, userId: user!.id };
}

async function setupOwnerAndTenant(prefix: string) {
  const { cookie, csrf, userId } = await registerAndLogin(em(prefix));
  const tenant = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', ORIGIN)
    .send({ name: `Tenant ${prefix}`, slug: slug(prefix) });
  if (tenant.status !== 201) throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  return { cookie, csrf, userId, tenantId: tenant.body.data.id as string };
}

interface Fixture {
  cookie: string;
  csrf: string;
  userId: string;
  tenantId: string;
  productId: string;
  assetId?: string;
  orderId: string;
  orderItemQuantity: number;
}

function base(tenantId: string) {
  return `${API}/tenants/${tenantId}`;
}

/** Produk + (opsional) unit fisik lewat API, lalu order disiapkan di database. */
async function setupOrder(
  prefix: string,
  opts: { stockMode?: 'QUANTITY' | 'INDIVIDUAL_UNITS'; quantity?: number } = {},
): Promise<Fixture> {
  const stockMode = opts.stockMode ?? 'INDIVIDUAL_UNITS';
  const quantity = opts.quantity ?? 1;
  const { cookie, csrf, userId, tenantId } = await setupOwnerAndTenant(prefix);

  const product = await request(server)
    .post(`${base(tenantId)}/products`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', ORIGIN)
    .send({ name: `Produk ${prefix}`, stockMode, capacity: stockMode === 'QUANTITY' ? 10 : 0 });
  if (product.status !== 201) throw new Error(`Gagal buat produk: ${JSON.stringify(product.body)}`);
  const productId = product.body.data.id as string;

  let assetId: string | undefined;
  if (stockMode === 'INDIVIDUAL_UNITS') {
    const asset = await request(server)
      .post(`${base(tenantId)}/products/${productId}/assets`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', ORIGIN)
      .send({ code: `UNIT-${Date.now() % 1000000}` });
    if (asset.status !== 201) throw new Error(`Gagal buat asset: ${JSON.stringify(asset.body)}`);
    assetId = asset.body.data.id as string;
  }

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
        assetId: assetId ?? null,
        quantity,
        startAt: new Date('2026-10-01T00:00:00.000Z'),
        endAt: new Date('2026-10-05T00:00:00.000Z'),
        priceSnapshot: 500_000n,
      },
    });
    if (assetId) {
      await tx.asset.update({ where: { id: assetId }, data: { status: 'RESERVED' } });
    }
    return order.id;
  });

  return { cookie, csrf, userId, tenantId, productId, assetId, orderId, orderItemQuantity: quantity };
}

function auth(req: request.Test, fx: { cookie: string; csrf: string }): request.Test {
  return req
    .set('Cookie', fx.cookie)
    .set('X-CSRF-Token', fx.csrf)
    .set('Origin', ORIGIN);
}

async function createReturn(
  fx: Fixture,
  body?: Record<string, unknown>,
): Promise<request.Response> {
  return auth(
    request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/returns`),
    fx,
  ).send(
    body ?? {
      notes: 'Dikembalikan tepat waktu',
      items: [
        {
          productId: fx.productId,
          ...(fx.assetId ? { assetId: fx.assetId } : {}),
          quantity: 1,
        },
      ],
    },
  );
}

async function completeReturn(fx: Fixture, returnId: string): Promise<request.Response> {
  return auth(
    request(server).patch(`${base(fx.tenantId)}/returns/${returnId}/complete`),
    fx,
  ).send({});
}

// ============================================================
// Pengembalian
// ============================================================

describe('Returns — pencatatan', () => {
  it('POST /orders/:id/returns → 201 PENDING beserta item dan audit log', async () => {
    const fx = await setupOrder('retcreate');
    const res = await createReturn(fx);

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.orderId).toBe(fx.orderId);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].assetId).toBe(fx.assetId);
    expect(res.body.data.items[0].quantity).toBe(1);
    expect(res.body.data.returnedAt).toBeNull();

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId: fx.tenantId, action: 'RETURN_CREATED' } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(res.body.data.id);
  });

  it('GET /orders/:id/returns → daftar berisi pengembalian yang tercatat', async () => {
    const fx = await setupOrder('retlist');
    const created = await createReturn(fx);
    const res = await request(server)
      .get(`${base(fx.tenantId)}/orders/${fx.orderId}/returns`)
      .set('Cookie', fx.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(created.body.data.id);
  });

  it('menolak jumlah melebihi yang disewa → 422', async () => {
    const fx = await setupOrder('retover', { stockMode: 'QUANTITY', quantity: 2 });
    const res = await createReturn(fx, {
      items: [{ productId: fx.productId, quantity: 3 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('menolak produk yang bukan bagian order → 422', async () => {
    const fx = await setupOrder('retwrongproduct');
    const other = await request(server)
      .post(`${base(fx.tenantId)}/products`)
      .set('Cookie', fx.cookie)
      .set('X-CSRF-Token', fx.csrf)
      .set('Origin', ORIGIN)
      .send({ name: 'Produk Lain' });
    const res = await createReturn(fx, {
      items: [{ productId: other.body.data.id, quantity: 1 }],
    });
    expect(res.status).toBe(422);
  });

  it('menolak unit fisik yang bukan milik produk yang dikembalikan → 422', async () => {
    const fx = await setupOrder('retmismatch');
    const otherProduct = await request(server)
      .post(`${base(fx.tenantId)}/products`)
      .set('Cookie', fx.cookie)
      .set('X-CSRF-Token', fx.csrf)
      .set('Origin', ORIGIN)
      .send({ name: 'Produk Unit Lain', stockMode: 'INDIVIDUAL_UNITS' });
    const res = await createReturn(fx, {
      items: [{ productId: otherProduct.body.data.id, assetId: fx.assetId, quantity: 1 }],
    });
    expect(res.status).toBe(422);
  });

  it('menolak unit fisik dari tenant lain → 404', async () => {
    const fx = await setupOrder('retforeignasset');
    const other = await setupOrder('retforeignowner');
    const res = await createReturn(fx, {
      items: [{ productId: fx.productId, assetId: other.assetId, quantity: 1 }],
    });
    expect(res.status).toBe(404);
  });

  it('menolak unit fisik yang sama dua kali dalam satu payload → 400', async () => {
    const fx = await setupOrder('retdupasset');
    const res = await createReturn(fx, {
      items: [
        { productId: fx.productId, assetId: fx.assetId, quantity: 1 },
        { productId: fx.productId, assetId: fx.assetId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('tanpa CSRF token → 403', async () => {
    const fx = await setupOrder('retnocsrf');
    const res = await request(server)
      .post(`${base(fx.tenantId)}/orders/${fx.orderId}/returns`)
      .set('Cookie', fx.cookie)
      .set('Origin', ORIGIN)
      .send({ items: [{ productId: fx.productId, quantity: 1 }] });
    expect(res.status).toBe(403);
  });

  it('tanpa sesi → 401', async () => {
    const fx = await setupOrder('retnoauth');
    const res = await request(server)
      .post(`${base(fx.tenantId)}/orders/${fx.orderId}/returns`)
      .send({ items: [{ productId: fx.productId, quantity: 1 }] });
    expect(res.status).toBe(401);
  });
});

describe('Returns — lifecycle', () => {
  it('PATCH /complete → COMPLETED, returnedAt terisi, asset kembali AVAILABLE', async () => {
    const fx = await setupOrder('retcomplete');
    const created = await createReturn(fx);
    const res = await completeReturn(fx, created.body.data.id);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');
    expect(res.body.data.returnedAt).not.toBeNull();
    expect(res.body.data.receivedByUserId).toBe(fx.userId);

    const asset = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.asset.findUnique({ where: { id: fx.assetId! } }),
    );
    expect(asset!.status).toBe('AVAILABLE');

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId: fx.tenantId, action: 'RETURN_COMPLETED' } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].fromState).toBe('PENDING');
    expect(audits[0].toState).toBe('COMPLETED');
  });

  it('menyelesaikan dua kali → 409 INVALID_STATE_TRANSITION', async () => {
    const fx = await setupOrder('retdouble');
    const created = await createReturn(fx);
    await completeReturn(fx, created.body.data.id);
    const again = await completeReturn(fx, created.body.data.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('PATCH /cancel → CANCELLED dan unit fisik dapat dikembalikan lagi', async () => {
    const fx = await setupOrder('retcancel');
    const created = await createReturn(fx);
    const cancelled = await auth(
      request(server).patch(`${base(fx.tenantId)}/returns/${created.body.data.id}/cancel`),
      fx,
    ).send({ reason: 'Salah input' });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const retry = await createReturn(fx);
    expect(retry.status).toBe(201);
  });

  it('GET /returns/:id → detail beserta inspeksi terkait', async () => {
    const fx = await setupOrder('retdetail');
    const created = await createReturn(fx);
    await completeReturn(fx, created.body.data.id);
    await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({ returnRecordId: created.body.data.id, summary: 'Bodi lecet' });

    const res = await request(server)
      .get(`${base(fx.tenantId)}/returns/${created.body.data.id}`)
      .set('Cookie', fx.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.inspections).toHaveLength(1);
    expect(res.body.data.inspections[0].status).toBe('DRAFT');
  });
});

// ============================================================
// Inspeksi
// ============================================================

describe('Inspections — lifecycle', () => {
  it('menolak inspeksi sebelum pengembalian selesai → 409', async () => {
    const fx = await setupOrder('inspbeforecomplete');
    const created = await createReturn(fx);
    const res = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({ returnRecordId: created.body.data.id });
    expect(res.status).toBe(409);
  });

  it('menolak inspeksi aktif kedua untuk return record yang sama → 422', async () => {
    const fx = await setupOrder('inspduplicate');
    const created = await createReturn(fx);
    await completeReturn(fx, created.body.data.id);
    const first = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({ returnRecordId: created.body.data.id });
    expect(first.status).toBe(201);

    const second = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({ returnRecordId: created.body.data.id });
    expect(second.status).toBe(422);
  });

  it('DRAFT → SUBMITTED → APPROVED dengan denda sebagai string IDR', async () => {
    const fx = await setupOrder('inspapprove');
    const created = await createReturn(fx);
    await completeReturn(fx, created.body.data.id);
    const inspection = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({ returnRecordId: created.body.data.id, summary: 'Roda depan penyok' });
    const inspectionId = inspection.body.data.id as string;
    expect(inspection.body.data.status).toBe('DRAFT');
    expect(inspection.body.data.penaltyAmount).toBeNull();

    const submitted = await auth(
      request(server).patch(`${base(fx.tenantId)}/inspections/${inspectionId}/submit`),
      fx,
    ).send({ penaltyAmount: 125000, summary: 'Roda depan penyok, perlu ganti' });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe('SUBMITTED');
    expect(submitted.body.data.submittedAt).not.toBeNull();
    expect(submitted.body.data.penaltyAmount).toBe('125000');

    const decided = await auth(
      request(server).patch(`${base(fx.tenantId)}/inspections/${inspectionId}/decision`),
      fx,
    ).send({ decision: 'APPROVE', penaltyAmount: 125000 });
    expect(decided.status).toBe(200);
    expect(decided.body.data.status).toBe('APPROVED');
    expect(decided.body.data.penaltyAmount).toBe('125000');
    expect(decided.body.data.approvedByUserId).toBe(fx.userId);
    expect(decided.body.data.decidedAt).not.toBeNull();
    expect(decided.body.data.attachments).toEqual([]);

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: fx.tenantId, action: 'INSPECTION_DECIDED' },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].toState).toBe('APPROVED');
  });

  it('APPROVE tanpa penaltyAmount → 400', async () => {
    const fx = await setupOrder('inspnopenalty');
    const created = await createReturn(fx);
    await completeReturn(fx, created.body.data.id);
    const inspection = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({ returnRecordId: created.body.data.id });
    await auth(
      request(server).patch(
        `${base(fx.tenantId)}/inspections/${inspection.body.data.id}/submit`,
      ),
      fx,
    ).send({});
    const decided = await auth(
      request(server).patch(
        `${base(fx.tenantId)}/inspections/${inspection.body.data.id}/decision`,
      ),
      fx,
    ).send({ decision: 'APPROVE' });
    expect(decided.status).toBe(400);
  });

  it('REJECT pada inspeksi level order (tanpa return record) → penalty null', async () => {
    const fx = await setupOrder('inspreject');
    const inspection = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({ summary: 'Tidak ada kerusakan' });
    expect(inspection.status).toBe(201);
    expect(inspection.body.data.returnRecordId).toBeNull();

    await auth(
      request(server).patch(
        `${base(fx.tenantId)}/inspections/${inspection.body.data.id}/submit`,
      ),
      fx,
    ).send({});
    const decided = await auth(
      request(server).patch(
        `${base(fx.tenantId)}/inspections/${inspection.body.data.id}/decision`,
      ),
      fx,
    ).send({ decision: 'REJECT' });

    expect(decided.status).toBe(200);
    expect(decided.body.data.status).toBe('REJECTED');
    expect(decided.body.data.penaltyAmount).toBeNull();
  });

  it('memutuskan inspeksi dua kali → 409', async () => {
    const fx = await setupOrder('inpdouble');
    const inspection = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/inspections`),
      fx,
    ).send({});
    const inspectionId = inspection.body.data.id as string;
    await auth(
      request(server).patch(`${base(fx.tenantId)}/inspections/${inspectionId}/submit`),
      fx,
    ).send({});
    const first = await auth(
      request(server).patch(`${base(fx.tenantId)}/inspections/${inspectionId}/decision`),
      fx,
    ).send({ decision: 'REJECT' });
    expect(first.status).toBe(200);

    const second = await auth(
      request(server).patch(`${base(fx.tenantId)}/inspections/${inspectionId}/decision`),
      fx,
    ).send({ decision: 'REJECT' });
    expect(second.status).toBe(409);
  });
});

// ============================================================
// Isolasi tenant (RLS + authorization)
// ============================================================

describe('Return & Inspection — isolasi tenant', () => {
  it('owner tenant lain tidak dapat melihat order/pengembalian tenant pertama', async () => {
    const a = await setupOrder('isoA');
    const created = await createReturn(a);
    const b = await setupOwnerAndTenant('isoB');

    const listOther = await request(server)
      .get(`${base(b.tenantId)}/orders/${a.orderId}/returns`)
      .set('Cookie', b.cookie);
    expect(listOther.status).toBe(404);
    expect(listOther.body.error.code).toBe('NOT_FOUND');

    const detailOther = await request(server)
      .get(`${base(b.tenantId)}/returns/${created.body.data.id}`)
      .set('Cookie', b.cookie);
    expect(detailOther.status).toBe(404);

    const createOther = await auth(
      request(server).post(`${base(b.tenantId)}/orders/${a.orderId}/returns`),
      b,
    ).send({ items: [{ productId: a.productId, quantity: 1 }] });
    expect(createOther.status).toBe(404);
  });

  it('memakai tenantId milik tenant lain pada resource sendiri → 403', async () => {
    const a = await setupOrder('isoDenyA');
    const b = await setupOrder('isoDenyB');

    const res = await request(server)
      .get(`${base(a.tenantId)}/returns/${b.orderId}`)
      .set('Cookie', b.cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('inspeksi tenant lain tidak terlihat lewat daftar order', async () => {
    const a = await setupOrder('isoInspA');
    const inspection = await auth(
      request(server).post(`${base(a.tenantId)}/orders/${a.orderId}/inspections`),
      a,
    ).send({ summary: 'Kerusakan A' });
    expect(inspection.status).toBe(201);

    const b = await setupOwnerAndTenant('isoInspB');
    const detail = await request(server)
      .get(`${base(b.tenantId)}/inspections/${inspection.body.data.id}`)
      .set('Cookie', b.cookie);
    expect(detail.status).toBe(404);

    const listOtherOrder = await request(server)
      .get(`${base(b.tenantId)}/orders/${a.orderId}/inspections`)
      .set('Cookie', b.cookie);
    expect(listOtherOrder.status).toBe(404);
    expect(listOtherOrder.body.error.code).toBe('NOT_FOUND');
  });
});
// ============================================================
// Denda keterlambatan — pengaturan owner & perhitungan server
// ============================================================

describe('Denda keterlambatan — pengaturan owner & perhitungan server', () => {
  function setLateFee(fx: Fixture, body: Record<string, unknown>): request.Test {
    return auth(request(server).patch(`${base(fx.tenantId)}/settings`), fx).send(body);
  }

  /** Catat pengembalian lalu selesaikan dengan waktu terima tertentu. */
  async function returnAt(fx: Fixture, receivedAt: string): Promise<request.Response> {
    const created = await createReturn(fx);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const completed = await auth(
      request(server).patch(`${base(fx.tenantId)}/returns/${created.body.data.id}/complete`),
      fx,
    ).send({ receivedAt });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    return completed;
  }

  it('menolak tarif nol saat aktif, satuan tak dikenal, dan tarif negatif', async () => {
    const fx = await setupOrder('latecfg');

    const zero = await setLateFee(fx, { lateFeeEnabled: true, lateFeeRateAmount: 0 });
    expect(zero.status).toBe(400);

    const unit = await setLateFee(fx, { lateFeeUnit: 'WEEK' });
    expect(unit.status).toBe(400);

    const negative = await setLateFee(fx, { lateFeeRateAmount: -1 });
    expect(negative.status).toBe(400);

    const ok = await setLateFee(fx, {
      lateFeeEnabled: true,
      lateFeeUnit: 'DAY',
      lateFeeRateAmount: 50_000,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);

    const tenant = await auth(request(server).get(`${base(fx.tenantId)}`), fx);
    expect(tenant.body.data.lateFeeEnabled).toBe(true);
    expect(tenant.body.data.lateFeeUnit).toBe('DAY');
    expect(tenant.body.data.lateFeeRateAmount).toBe('50000');
  });

  it('menghitung denda harian dari selisih waktu terima dan endAt order', async () => {
    const fx = await setupOrder('lateday');
    const saved = await setLateFee(fx, {
      lateFeeEnabled: true,
      lateFeeUnit: 'DAY',
      lateFeeRateAmount: 50_000,
    });
    expect(saved.status).toBe(204);

    // endAt item fixture 2026-10-05T00:00Z; diterima 25 jam kemudian → 2 hari.
    const completed = await returnAt(fx, '2026-10-06T01:00:00.000Z');
    expect(completed.body.data.lateFee).toMatchObject({
      enabled: true,
      unit: 'DAY',
      rateAmount: '50000',
      dueAt: '2026-10-05T00:00:00.000Z',
      returnedAt: '2026-10-06T01:00:00.000Z',
      units: 2,
      amount: '100000',
    });

    // Daftar pengembalian memakai angka yang sama; klien tidak menghitung sendiri.
    const list = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/returns`),
      fx,
    );
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].lateFee.amount).toBe('100000');

    // Denda tidak masuk tagihan order: total order tetap sesuai nilai order
    // (fixture ini membuat order tanpa total), bukan nilai denda.
    const order = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}`),
      fx,
    );
    expect(order.body.data.totalAmount).toBe('0');
  });

  it('mendukung satuan jam dan saklar mati mengembalikan denda nol', async () => {
    const fx = await setupOrder('latehour');
    const saved = await setLateFee(fx, {
      lateFeeEnabled: true,
      lateFeeUnit: 'HOUR',
      lateFeeRateAmount: 10_000,
    });
    expect(saved.status).toBe(204);

    // Diterima 3,5 jam setelah endAt → dibulatkan menjadi 4 jam.
    const completed = await returnAt(fx, '2026-10-05T03:30:00.000Z');
    expect(completed.body.data.lateFee.unit).toBe('HOUR');
    expect(completed.body.data.lateFee.units).toBe(4);
    expect(completed.body.data.lateFee.amount).toBe('40000');

    const off = await setLateFee(fx, { lateFeeEnabled: false });
    expect(off.status).toBe(204);

    const detail = await auth(
      request(server).get(`${base(fx.tenantId)}/returns/${completed.body.data.id}`),
      fx,
    );
    expect(detail.body.data.lateFee.enabled).toBe(false);
    expect(detail.body.data.lateFee.units).toBe(0);
    expect(detail.body.data.lateFee.amount).toBe('0');
    // Tarif tersimpan tetap ada supaya owner bisa menyalakan lagi tanpa input ulang.
    expect(detail.body.data.lateFee.rateAmount).toBe('10000');
  });

  it('pengembalian tepat waktu tidak menghasilkan denda', async () => {
    const fx = await setupOrder('lateontime');
    const saved = await setLateFee(fx, {
      lateFeeEnabled: true,
      lateFeeUnit: 'DAY',
      lateFeeRateAmount: 50_000,
    });
    expect(saved.status).toBe(204);

    const completed = await returnAt(fx, '2026-10-05T00:00:00.000Z');
    expect(completed.body.data.lateFee.units).toBe(0);
    expect(completed.body.data.lateFee.amount).toBe('0');
  });
});

/**
 * Integration test: Order, pembayaran manual, dan ledger deposit.
 *
 * Mencakup docs/openapi.yaml (tag "Order", "Payment", "Deposit") + ADR-001 §3–§4:
 * - POST /tenants/:t/reservations/:id/convert-to-order → order unik per reservasi
 * - GET  /tenants/:t/orders, GET /tenants/:t/orders/:id
 * - POST /tenants/:t/orders/:id/ready-for-handover → CONFIRMED → READY_FOR_HANDOVER
 * - POST /tenants/:t/orders/:id/handover            → READY_FOR_HANDOVER → ACTIVE
 * - POST /tenants/:t/orders/:id/complete            → RETURN_IN_PROGRESS → COMPLETED
 * - POST /tenants/:t/orders/:o/payments             → RECORDED (manual, append-only)
 * - POST /tenants/:t/payments/:id/void              → VOIDED + alasan
 * - POST /tenants/:t/orders/:o/deposits             → movement RECEIPT
 * - POST /tenants/:t/orders/:o/deposit-deductions   → PENDING (belum mengubah saldo)
 * - POST /tenants/:t/deposit-deductions/:id/approve → DEDUCTION oleh aktor lain
 * - POST /tenants/:t/orders/:o/deposit-refunds      → movement REFUND
 * - POST /tenants/:t/orders/:o/deposit-movements/:m/reverse
 *
 * Berjalan terhadap PostgreSQL sewain_test (migrasi penuh dari nol, RLS aktif).
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
const PW = 'kata-sandi-order-testing-001';
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
  password = PW,
): Promise<{ cookie: string; csrf: string; userId: string }> {
  await request(server).post(`${API}/auth/registrations`).send({ email: emailAddr, password, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
  const otp = emailSvc.testAdapter!.lastOtpFor(emailAddr);
  if (!otp) throw new Error(`OTP tidak ada untuk ${emailAddr}`);
  await request(server)
    .post(`${API}/auth/registrations/verify-email`)
    .send({ email: emailAddr, code: otp });
  const login = await request(server)
    .post(`${API}/auth/sessions`)
    .send({ email: emailAddr, password });
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

interface Actor {
  cookie: string;
  csrf: string;
  userId: string;
}

interface Fixture {
  owner: Actor;
  manager: Actor;
  cashier?: Actor;
  tenantId: string;
  productId: string;
  reservationId: string;
  orderId: string;
  totalAmount: string;
}

/** Minta login baru (token CSRF dapat berubah setelah aksi tertentu). */
async function freshLogin(emailAddr: string, password = PW): Promise<Actor> {
  const login = await request(server).post(`${API}/auth/sessions`).send({ email: emailAddr, password });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  return {
    cookie: session.split(';')[0],
    csrf: login.headers['x-csrf-token'] as string,
    userId: (await prisma.client.user.findUnique({ where: { email: emailAddr.toLowerCase() } }))!
      .id,
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

/** Undang staf lalu terima undangan → akun + membership ACTIVE. */
async function inviteStaff(
  owner: Actor,
  tenantId: string,
  role: 'MANAGER' | 'STAFF' | 'CASHIER',
  prefix: string,
): Promise<{ email: string; actor: Actor }> {
  const staffEmail = em(prefix);
  const invite = await auth(
    request(server).post(`${base(tenantId)}/members`),
    owner,
  ).send({ email: staffEmail, role });
  if (invite.status !== 201) {
    throw new Error(`Gagal undang ${role}: ${JSON.stringify(invite.body)}`);
  }
  const accept = await request(server)
    .post(`${API}/auth/invitations/accept`)
    .send({ token: lastInviteToken(staffEmail), password: PW });
  if (accept.status !== 200) {
    throw new Error(`Gagal menerima undangan: ${JSON.stringify(accept.body)}`);
  }
  return { email: staffEmail, actor: await freshLogin(staffEmail) };
}

/**
 * Tenant AUTOMATIC + produk QUANTITY + rate 100.000/hari, lalu reservasi
 * 2 item × 2 hari (dikonfirmasi otomatis), lalu dikonversi menjadi order.
 */
async function setupOrder(
  prefix: string,
  opts: { withManager?: boolean; withCashier?: boolean } = {},
): Promise<Fixture> {
  const ownerEmail = em(prefix);
  const owner = await registerAndLogin(ownerEmail);
  const tenant = await auth(request(server).post(`${API}/tenants`), owner).send({
    name: `Tenant ${prefix}`,
    slug: slug(prefix),
  });
  if (tenant.status !== 201) throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  const tenantId = tenant.body.data.id as string;

  const settings = await auth(
    request(server).patch(`${base(tenantId)}/settings`),
    owner,
  ).send({ bookingMode: 'AUTOMATIC' });
  if (settings.status !== 204) {
    throw new Error(`Gagal set settings: ${JSON.stringify(settings.body)}`);
  }

  const product = await auth(
    request(server).post(`${base(tenantId)}/products`),
    owner,
  ).send({ name: `Produk ${prefix}`, stockMode: 'QUANTITY', capacity: 10 });
  if (product.status !== 201) throw new Error(`Gagal buat produk: ${JSON.stringify(product.body)}`);
  const productId = product.body.data.id as string;

  const rate = await auth(
    request(server).post(`${base(tenantId)}/products/${productId}/rates`),
    owner,
  ).send({ perDayAmount: 100_000 });
  if (rate.status !== 201 && rate.status !== 200) {
    throw new Error(`Gagal set rate: ${JSON.stringify(rate.body)}`);
  }

  const reservation = await auth(
    request(server).post(`${base(tenantId)}/reservations`),
    owner,
  ).send({
    startAt: '2026-11-01T00:00:00.000Z',
    endAt: '2026-11-03T00:00:00.000Z',
    items: [{ productId, quantity: 2 }],
  });
  if (reservation.status !== 201) {
    throw new Error(`Gagal buat reservasi: ${JSON.stringify(reservation.body)}`);
  }
  expect(reservation.body.data.status).toBe('CONFIRMED');

  const convert = await auth(
    request(server).post(`${base(tenantId)}/reservations/${reservation.body.data.id}/convert-to-order`),
    owner,
  );
  if (convert.status !== 201) {
    throw new Error(`Gagal konversi: ${JSON.stringify(convert.body)}`);
  }

  const manager = opts.withManager
    ? (await inviteStaff(owner, tenantId, 'MANAGER', `${prefix}-mgr`)).actor
    : owner;
  const cashier = opts.withCashier
    ? (await inviteStaff(owner, tenantId, 'CASHIER', `${prefix}-csr`)).actor
    : undefined;

  return {
    owner,
    manager,
    cashier,
    tenantId,
    productId,
    reservationId: reservation.body.data.id as string,
    orderId: convert.body.data.id as string,
    totalAmount: convert.body.data.totalAmount as string,
  };
}

// ============================================================
// Konversi reservasi → order
// ============================================================

describe('Order — konversi reservasi', () => {
  it('CONFIRMED → order: total server-side, deposit kosong, reservasi CONVERTED_TO_ORDER', async () => {
    const fx = await setupOrder('ordconv');
    const res = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}`),
      fx.owner,
    );
    expect(res.status).toBe(200);
    // 100.000 × 2 hari = 200.000 per unit; 2 unit = 400.000
    expect(res.body.data.totalAmount).toBe('400000');
    expect(res.body.data.status).toBe('CONFIRMED');
    expect(res.body.data.orderNumber).toMatch(/^ORD-\d{8}-[0-9A-F]{8}$/);
    expect(res.body.data.sourceReservationId).toBe(fx.reservationId);
    expect(res.body.data.deposit).toMatchObject({ balance: '0' });
    expect(res.body.data.payments).toEqual([]);

    const reservation = await auth(
      request(server).get(`${base(fx.tenantId)}/reservations/${fx.reservationId}`),
      fx.owner,
    );
    expect(reservation.body.data.status).toBe('CONVERTED_TO_ORDER');

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId: fx.tenantId, action: 'ORDER_CREATED' } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(fx.orderId);
  });

  it('konversi kedua kali mengembalikan order yang sama (tidak duplikat)', async () => {
    const fx = await setupOrder('orddup');
    const again = await auth(
      request(server).post(`${base(fx.tenantId)}/reservations/${fx.reservationId}/convert-to-order`),
      fx.owner,
    );
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(fx.orderId);

    const count = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.rentalOrder.count({ where: { tenantId: fx.tenantId } }),
    );
    expect(count).toBe(1);
  });

  it('dua konversi paralel tetap satu order (unique + lock)', async () => {
    const fx = await setupOrder('ordpar');
    const call = () =>
      auth(
        request(server).post(`${base(fx.tenantId)}/reservations/${fx.reservationId}/convert-to-order`),
        fx.owner,
      );
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.status, b.status].every((s) => s === 201)).toBe(true);
    expect(a.body.data.id).toBe(b.body.data.id);
    const count = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.rentalOrder.count({ where: { tenantId: fx.tenantId } }),
    );
    expect(count).toBe(1);
  });

  it('reservasi PENDING_APPROVAL tidak dapat dikonversi → 409', async () => {
    const fx = await setupOrder('ordpend');
    // Reservasi baru pada periode lain, lalu statusnya dijadikan
    // PENDING_APPROVAL (setara booking manual yang belum disetujui).
    const pending = await auth(
      request(server).post(`${base(fx.tenantId)}/reservations`),
      fx.owner,
    ).send({
      startAt: '2026-12-01T00:00:00.000Z',
      endAt: '2026-12-03T00:00:00.000Z',
      items: [{ productId: fx.productId, quantity: 1 }],
    });
    expect(pending.status).toBe(201);
    await prisma.withTenant(fx.tenantId, (tx) =>
      tx.reservation.update({
        where: { tenantId_id: { tenantId: fx.tenantId, id: pending.body.data.id } },
        data: { status: 'PENDING_APPROVAL' },
      }),
    );
    const res = await auth(
      request(server).post(`${base(fx.tenantId)}/reservations/${pending.body.data.id}/convert-to-order`),
      fx.owner,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('order tenant lain tidak terlihat → 404', async () => {
    const a = await setupOrder('ordtenanta');
    const b = await setupOrder('ordtenantb');
    const res = await auth(
      request(server).get(`${base(b.tenantId)}/orders/${a.orderId}`),
      b.owner,
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ============================================================
// Lifecycle order
// ============================================================

describe('Order — lifecycle handover', () => {
  it('CONFIRMED → READY_FOR_HANDOVER → ACTIVE dengan audit', async () => {
    const fx = await setupOrder('ordlife');

    const ready = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/ready-for-handover`),
      fx.owner,
    ).send({ note: 'Barang siap diambil' });
    expect(ready.status).toBe(200);
    expect(ready.body.data.status).toBe('READY_FOR_HANDOVER');

    const handover = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/handover`),
      fx.owner,
    ).send({
      conditionNotes: 'Kondisi baik, 2 unit lengkap',
      evidenceRefs: ['foto-1.jpg', 'berita-acara.pdf'],
    });
    expect(handover.status).toBe(200);
    expect(handover.body.data.status).toBe('ACTIVE');

    const actions = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: {
          tenantId: fx.tenantId,
          action: { in: ['ORDER_READY_FOR_HANDOVER', 'ORDER_HANDED_OVER'] },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(actions.map((a) => a.action)).toEqual([
      'ORDER_READY_FOR_HANDOVER',
      'ORDER_HANDED_OVER',
    ]);
    expect(actions[1].fromState).toBe('READY_FOR_HANDOVER');
    expect(actions[1].toState).toBe('ACTIVE');
    expect(actions[1].metadata).toMatchObject({ conditionNotes: 'Kondisi baik, 2 unit lengkap' });
  });

  it('handover dari CONFIRMED ditolak → 409 (tidak boleh lompat state)', async () => {
    const fx = await setupOrder('ordskip');
    const res = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/handover`),
      fx.owner,
    ).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('retry dengan Idempotency-Key sama mengembalikan hasil yang sama tanpa audit ganda', async () => {
    const fx = await setupOrder('ordidem');
    const key = 'idem-handover-key-0001';
    const call = () =>
      auth(
        request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/ready-for-handover`),
        fx.owner,
      )
        .set('Idempotency-Key', key)
        .send({ note: 'siap' });

    const first = await call();
    const second = await call();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe('READY_FOR_HANDOVER');

    const audits = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.count({
        where: { tenantId: fx.tenantId, action: 'ORDER_READY_FOR_HANDOVER' },
      }),
    );
    expect(audits).toBe(1);
  });

  it('Idempotency-Key dipakai ulang dengan payload berbeda → 409', async () => {
    const fx = await setupOrder('ordidem2');
    const key = 'idem-ready-key-0002';
    const first = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/ready-for-handover`),
      fx.owner,
    )
      .set('Idempotency-Key', key)
      .send({ note: 'siap' });
    expect(first.status).toBe(200);
    const second = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/ready-for-handover`),
      fx.owner,
    )
      .set('Idempotency-Key', key)
      .send({ note: 'catatan berbeda' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('complete hanya dari RETURN_IN_PROGRESS; return PENDING menghalangi → 422', async () => {
    const fx = await setupOrder('ordcomp');
    await auth(request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/ready-for-handover`), fx.owner).send({});
    await auth(request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/handover`), fx.owner).send({});

    const early = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/complete`),
      fx.owner,
    ).send({});
    expect(early.status).toBe(409);

    const ret = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/returns`),
      fx.owner,
    ).send({
      items: [{ productId: fx.productId, quantity: 1 }],
    });
    expect(ret.status).toBe(201);

    const order = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}`),
      fx.owner,
    );
    expect(order.body.data.status).toBe('RETURN_IN_PROGRESS');

    const blocked = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/complete`),
      fx.owner,
    ).send({});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    await auth(
      request(server).patch(`${base(fx.tenantId)}/returns/${ret.body.data.id}/complete`),
      fx.owner,
    ).send({});

    const done = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/complete`),
      fx.owner,
    ).send({ settlementNote: 'Selesai, deposit dikembalikan penuh' });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('COMPLETED');
  });
});

// ============================================================
// Pembayaran manual
// ============================================================

describe('Payment — pencatatan manual', () => {
  it('POST payments → 201 RECORDED dengan total terbayar & sisa', async () => {
    const fx = await setupOrder('payrec');
    const res = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '150000', currency: 'IDR', method: 'CASH', reference: 'KW-001' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('RECORDED');
    expect(res.body.data.method).toBe('CASH');
    expect(res.body.data.orderTotals).toMatchObject({
      totalAmount: fx.totalAmount,
      paidAmount: '150000',
      outstandingAmount: '250000',
    });

    const order = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}`),
      fx.owner,
    );
    expect(order.body.data.paidAmount).toBe('150000');
    expect(order.body.data.outstandingAmount).toBe('250000');
  });

  it('nominal bukan integer rupiah utuh → 400; mata uang salah → 400', async () => {
    const fx = await setupOrder('paybad');
    const decimals = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '1000.50', currency: 'IDR', method: 'CASH' });
    expect(decimals.status).toBe(400);

    const zero = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '0', currency: 'IDR', method: 'CASH' });
    expect(zero.status).toBe(400);

    const usd = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '1000', currency: 'USD', method: 'CASH' });
    expect(usd.status).toBe(400);
  });

  it('retry Idempotency-Key sama tidak menggandakan pembayaran', async () => {
    const fx = await setupOrder('payidem');
    const key = 'idem-payment-key-0001';
    const call = () =>
      auth(
        request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
        fx.owner,
      )
        .set('Idempotency-Key', key)
        .send({ amount: '100000', currency: 'IDR', method: 'QRIS' });
    const first = await call();
    const second = await call();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);

    const list = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    );
    expect(list.body.data).toHaveLength(1);
  });

  it('void mengoreksi tanpa menghapus histori; void kedua → 409', async () => {
    const fx = await setupOrder('payvoid');
    const payment = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '400000', currency: 'IDR', method: 'BANK_TRANSFER' });
    expect(payment.status).toBe(201);

    const voided = await auth(
      request(server).post(`${base(fx.tenantId)}/payments/${payment.body.data.id}/void`),
      fx.owner,
    ).send({ reason: 'Transfer ganda, dikembalikan ke penyewa' });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('VOIDED');
    expect(voided.body.data.voidReason).toBe('Transfer ganda, dikembalikan ke penyewa');
    expect(voided.body.data.orderTotals.outstandingAmount).toBe(fx.totalAmount);

    const again = await auth(
      request(server).post(`${base(fx.tenantId)}/payments/${payment.body.data.id}/void`),
      fx.owner,
    ).send({ reason: 'void lagi' });
    expect(again.status).toBe(409);

    const list = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    );
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].status).toBe('VOIDED');
  });

  it('CASHIER boleh mencatat pembayaran tetapi tidak boleh void → 403', async () => {
    const fx = await setupOrder('paycash', { withCashier: true });
    const payment = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.cashier!,
    ).send({ amount: '50000', currency: 'IDR', method: 'CASH' });
    expect(payment.status).toBe(201);

    const voided = await auth(
      request(server).post(`${base(fx.tenantId)}/payments/${payment.body.data.id}/void`),
      fx.cashier!,
    ).send({ reason: 'mencoba void' });
    expect(voided.status).toBe(403);
    expect(voided.body.error.code).toBe('PERMISSION_DENIED');
  });
});

// ============================================================
// Deposit ledger
// ============================================================

describe('Deposit — ledger append-only & approval dua langkah', () => {
  it('RECEIPT menambah saldo; DEDUCTION baru mengubah saldo setelah APPROVED', async () => {
    const fx = await setupOrder('depflow', { withManager: true });

    const receipt = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`),
      fx.owner,
    ).send({ amount: '500000', currency: 'IDR', method: 'CASH', note: 'Deposit awal' });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect(receipt.body.data.balance).toBe('500000');
    expect(receipt.body.data.movements).toHaveLength(1);
    expect(receipt.body.data.movements[0].type).toBe('RECEIPT');

    const request1 = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-deductions`),
      fx.owner,
    ).send({ amount: '120000', currency: 'IDR', reason: 'Lampu rusak', conditionNotes: 'Retak' });
    expect(request1.status).toBe(201);
    expect(request1.body.data.status).toBe('PENDING');
    expect(request1.body.data.depositBalance).toBe('500000');

    // Saldo belum berubah sebelum approval.
    const pending = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`),
      fx.owner,
    );
    expect(pending.body.data.balance).toBe('500000');
    expect(pending.body.data.movements).toHaveLength(1);

    // Pengaju tidak boleh menyetujui permintaannya sendiri.
    const selfApprove = await auth(
      request(server).post(`${base(fx.tenantId)}/deposit-deductions/${request1.body.data.id}/approve`),
      fx.owner,
    ).send({});
    expect(selfApprove.status).toBe(403);

    const approved = await auth(
      request(server).post(`${base(fx.tenantId)}/deposit-deductions/${request1.body.data.id}/approve`),
      fx.manager,
    ).send({ reason: 'Sesuai inspeksi' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.movementId).toBeTruthy();
    expect(approved.body.data.depositBalance).toBe('380000');

    const after = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`),
      fx.owner,
    );
    expect(after.body.data.balance).toBe('380000');
    expect(after.body.data.movements.map((m: { type: string }) => m.type)).toEqual([
      'RECEIPT',
      'DEDUCTION',
    ]);

    const audit = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: fx.tenantId, domain: 'deposit' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map((a) => a.action)).toEqual([
      'DEPOSIT_RECEIVED',
      'DEPOSIT_DEDUCTION_REQUESTED',
      'DEPOSIT_DEDUCTION_APPROVED',
    ]);
  });

  it('potongan melebihi saldo ditolak → 422', async () => {
    const fx = await setupOrder('deplimit');
    await auth(request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`), fx.owner).send({
      amount: '100000',
      currency: 'IDR',
    });
    const res = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-deductions`),
      fx.owner,
    ).send({ amount: '150000', currency: 'IDR', reason: 'Kerusakan berat' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('reject tidak mengubah saldo dan tidak membuat movement', async () => {
    const fx = await setupOrder('depreject', { withManager: true });
    await auth(request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`), fx.owner).send({
      amount: '200000',
      currency: 'IDR',
    });
    const req1 = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-deductions`),
      fx.owner,
    ).send({ amount: '50000', currency: 'IDR', reason: 'Dugaan kerusakan' });
    expect(req1.status).toBe(201);

    const rejected = await auth(
      request(server).post(`${base(fx.tenantId)}/deposit-deductions/${req1.body.data.id}/reject`),
      fx.manager,
    ).send({ reason: 'Tidak terbukti' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('REJECTED');
    expect(rejected.body.data.depositBalance).toBe('200000');

    const after = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`),
      fx.owner,
    );
    expect(after.body.data.movements).toHaveLength(1);
    expect(after.body.data.balance).toBe('200000');
  });

  it('approval paralel tidak pernah membuat saldo negatif', async () => {
    const fx = await setupOrder('depconc', { withManager: true });
    await auth(request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`), fx.owner).send({
      amount: '100000',
      currency: 'IDR',
    });
    const mk = (amount: string) =>
      auth(
        request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-deductions`),
        fx.owner,
      ).send({ amount, currency: 'IDR', reason: 'Klaim paralel' });
    const [r1, r2] = await Promise.all([mk('80000'), mk('80000')]);
    expect([r1.status, r2.status]).toEqual([201, 201]);

    const approve = (id: string) =>
      auth(
        request(server).post(`${base(fx.tenantId)}/deposit-deductions/${id}/approve`),
        fx.manager,
      ).send({});
    const [a1, a2] = await Promise.all([
      approve(r1.body.data.id),
      approve(r2.body.data.id),
    ]);
    const statuses = [a1.status, a2.status].sort();
    expect(statuses).toEqual([200, 422]);

    const after = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`),
      fx.owner,
    );
    expect(after.body.data.balance).toBe('20000');
    expect(BigInt(after.body.data.balance) >= 0n).toBe(true);
  });

  it('refund deposit mengurangi saldo; melebihi saldo → 422', async () => {
    const fx = await setupOrder('deprefund');
    await auth(request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`), fx.owner).send({
      amount: '300000',
      currency: 'IDR',
      method: 'BANK_TRANSFER',
    });

    const over = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-refunds`),
      fx.owner,
    ).send({ amount: '400000', currency: 'IDR', reason: 'Refund penuh' });
    expect(over.status).toBe(422);

    const refund = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-refunds`),
      fx.owner,
    ).send({ amount: '300000', currency: 'IDR', reason: 'Refund penuh', reference: 'TRF-9' });
    expect(refund.status).toBe(201);
    expect(refund.body.data.balance).toBe('0');

    // Refund deposit tidak menciptakan atau menimpa payment sewa.
    const payments = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    );
    expect(payments.body.data).toEqual([]);
  });

  it('reversal sekali per movement; reversal kedua ditolak → 422', async () => {
    const fx = await setupOrder('deprev', { withManager: true });
    const receipt = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`),
      fx.owner,
    ).send({ amount: '250000', currency: 'IDR' });
    const movementId = receipt.body.data.movements[0].id as string;

    const reversed = await auth(
      request(
        server,
      ).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-movements/${movementId}/reverse`),
      fx.manager,
    ).send({ reason: 'Deposit dicatat ganda' });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(201);
    expect(reversed.body.data.balance).toBe('0');
    expect(reversed.body.data.movements.map((m: { type: string }) => m.type)).toEqual([
      'RECEIPT',
      'REVERSAL',
    ]);

    const again = await auth(
      request(
        server,
      ).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-movements/${movementId}/reverse`),
      fx.manager,
    ).send({ reason: 'Reversal kedua' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('STAFF tanpa permission deposit.deduct tidak boleh mengajukan potongan → 403', async () => {
    const fx = await setupOrder('depstaff');
    const staff = (
      await inviteStaff(fx.owner, fx.tenantId, 'STAFF', 'depstaff-staff')
    ).actor;

    const res = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposit-deductions`),
      staff,
    ).send({ amount: '10000', currency: 'IDR', reason: 'tes permission' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('deposit ledger append-only: UPDATE ditolak trigger database', async () => {
    const fx = await setupOrder('depappend');
    const receipt = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/deposits`),
      fx.owner,
    ).send({ amount: '10000', currency: 'IDR' });
    const movementId = receipt.body.data.movements[0].id as string;

    await expect(
      prisma.withTenant(fx.tenantId, (tx) =>
        tx.depositMovement.update({ where: { id: movementId }, data: { amount: 1n } }),
      ),
    ).rejects.toThrow(/append-only/i);
  });
});

// ============================================================
// Refund pembayaran sewa (terpisah dari deposit)
// ============================================================

async function recordPayment(fx: Fixture, amount = '300000') {
  const res = await auth(
    request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
    fx.owner,
  ).send({ amount, currency: 'IDR', method: 'BANK_TRANSFER', reference: `PAY-${uid('ref')}` });
  if (res.status !== 201) throw new Error(`Gagal catat payment: ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}

describe('Refund — payment terpisah, batas refundable, dan hasil manual', () => {
  it('REQUESTED → APPROVED → SUCCEEDED; payment tidak berubah dan audit lengkap', async () => {
    const fx = await setupOrder('refdone', { withManager: true });
    const paymentId = await recordPayment(fx, '300000');

    const requested = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
      fx.owner,
    ).send({
      paymentId,
      amount: '120000',
      currency: 'IDR',
      reason: 'Batal satu unit',
      reference: 'RF-001',
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    expect(requested.body.data.status).toBe('REQUESTED');
    expect(requested.body.data.refundableAmount).toBe('180000');
    expect(requested.body.data.refundedAmount).toBe('0');

    const approved = await auth(
      request(server).post(`${base(fx.tenantId)}/refunds/${requested.body.data.id}/approve`),
      fx.manager,
    ).send({ reason: 'Sesuai kebijakan pembatalan' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.decisionReason).toBe('Sesuai kebijakan pembatalan');

    const result = await auth(
      request(server).post(`${base(fx.tenantId)}/refunds/${requested.body.data.id}/record-result`),
      fx.manager,
    ).send({ status: 'SUCCEEDED', reference: 'TRF-BALIK-1', note: 'Transfer balik selesai' });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.status).toBe('SUCCEEDED');
    expect(result.body.data.processedAt).toBeTruthy();
    expect(result.body.data.refundedAmount).toBe('120000');
    expect(result.body.data.refundableAmount).toBe('180000');

    const list = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
      fx.owner,
    );
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].status).toBe('SUCCEEDED');

    // Payment asli tidak dihapus/ditimpa oleh refund.
    const payments = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    );
    expect(payments.body.data).toHaveLength(1);
    expect(payments.body.data[0].status).toBe('RECORDED');
    expect(payments.body.data[0].amount).toBe('300000');

    const audit = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId: fx.tenantId, domain: 'refund' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audit.map((row) => row.action)).toEqual([
      'REFUND_REQUESTED',
      'REFUND_APPROVED',
      'REFUND_SUCCEEDED',
    ]);
  });

  it('refund melebihi sisa refundable → 422; payment VOIDED tidak dapat direfund → 409', async () => {
    const fx = await setupOrder('reflimit');
    const paymentId = await recordPayment(fx, '300000');

    const first = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
      fx.owner,
    ).send({ paymentId, amount: '200000', currency: 'IDR', reason: 'Refund sebagian' });
    expect(first.status).toBe(201);
    expect(first.body.data.refundableAmount).toBe('100000');

    const over = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
      fx.owner,
    ).send({ paymentId, amount: '150000', currency: 'IDR', reason: 'Melebihi sisa' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    const fx2 = await setupOrder('refvoid');
    const payment2 = await recordPayment(fx2, '100000');
    const voided = await auth(
      request(server).post(`${base(fx2.tenantId)}/payments/${payment2}/void`),
      fx2.owner,
    ).send({ reason: 'Salah input' });
    expect(voided.status).toBe(200);

    const onVoided = await auth(
      request(server).post(`${base(fx2.tenantId)}/orders/${fx2.orderId}/refunds`),
      fx2.owner,
    ).send({ paymentId: payment2, amount: '50000', currency: 'IDR', reason: 'Refund void' });
    expect(onVoided.status).toBe(409);
    expect(onVoided.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('dua pengajuan paralel tidak dapat melebihi nilai payment (lock payment)', async () => {
    const fx = await setupOrder('refpar');
    const paymentId = await recordPayment(fx, '300000');

    const call = () =>
      auth(
        request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
        fx.owner,
      ).send({ paymentId, amount: '200000', currency: 'IDR', reason: 'Refund paralel' });

    const results = await Promise.all([call(), call()]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 422]);

    const list = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
      fx.owner,
    );
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].amount).toBe('200000');
  });

  it('hasil FAILED melepas nilai refundable dan tidak dapat diproses dua kali → 409', async () => {
    const fx = await setupOrder('reffail');
    const paymentId = await recordPayment(fx, '100000');
    const requested = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
      fx.owner,
    ).send({ paymentId, amount: '60000', currency: 'IDR', reason: 'Refund uji gagal' });
    expect(requested.status).toBe(201);

    await auth(
      request(server).post(`${base(fx.tenantId)}/refunds/${requested.body.data.id}/approve`),
      fx.owner,
    ).send({});

    const failed = await auth(
      request(server).post(`${base(fx.tenantId)}/refunds/${requested.body.data.id}/record-result`),
      fx.owner,
    ).send({ status: 'FAILED', note: 'Rekening tujuan tidak valid' });
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.data.status).toBe('FAILED');
    expect(failed.body.data.refundableAmount).toBe('100000');

    const again = await auth(
      request(server).post(`${base(fx.tenantId)}/refunds/${requested.body.data.id}/record-result`),
      fx.owner,
    ).send({ status: 'SUCCEEDED' });
    expect(again.status).toBe(409);
  });

  it('approval refund kedua kali → 409; STAFF tanpa refund.request → 403', async () => {
    const fx = await setupOrder('refperm');
    const paymentId = await recordPayment(fx, '100000');
    const requested = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
      fx.owner,
    ).send({ paymentId, amount: '40000', currency: 'IDR', reason: 'Refund uji izin' });
    expect(requested.status).toBe(201);

    const approve = await auth(
      request(server).post(`${base(fx.tenantId)}/refunds/${requested.body.data.id}/approve`),
      fx.owner,
    ).send({});
    expect(approve.status).toBe(200);
    const again = await auth(
      request(server).post(`${base(fx.tenantId)}/refunds/${requested.body.data.id}/approve`),
      fx.owner,
    ).send({});
    expect(again.status).toBe(409);

    const staff = (await inviteStaff(fx.owner, fx.tenantId, 'STAFF', 'refperm-staff')).actor;
    const denied = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/refunds`),
      staff,
    ).send({ paymentId, amount: '10000', currency: 'IDR', reason: 'Coba refund' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
  });
});

// ============================================================
// Integritas tenant di level database
// ============================================================

describe('Integritas — composite foreign key tenant', () => {
  it('item order tidak dapat merujuk produk tenant lain (FK komposit)', async () => {
    const a = await setupOrder('fk-a');
    const b = await setupOrder('fk-b');

    await expect(
      prisma.withTenant(a.tenantId, (tx) =>
        tx.rentalItem.create({
          data: {
            tenantId: a.tenantId,
            orderId: a.orderId,
            productId: b.productId,
            quantity: 1,
            startAt: new Date('2026-11-01T00:00:00.000Z'),
            endAt: new Date('2026-11-02T00:00:00.000Z'),
            priceSnapshot: 0n,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});

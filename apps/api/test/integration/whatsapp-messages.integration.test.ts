/**
 * Integration test: template WhatsApp aktif → pesan transaksi + snapshot.
 *
 * Mencakup:
 * - respons booking (konversi order) memuat pesan instruksi per metode aktif
 * - respons payment memuat pesan konfirmasi (fallback instruksi)
 * - snapshot menyimpan body final + versi template dan tidak berubah saat
 *   template diedit kemudian
 * - metode nonaktif / template nonaktif tidak menghasilkan pesan
 * - isolasi tenant pada endpoint histori dan RLS
 */
import { randomUUID } from 'node:crypto';
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
const PW = 'kata-sandi-whatsapp-message-001';
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
  customerName: string;
  orderId: string;
  orderNumber: string;
  messages: WhatsAppMessage[];
}

interface WhatsAppMessage {
  id: string;
  orderId: string;
  paymentId: string | null;
  templateId: string;
  templateVersion: number;
  context: string;
  paymentMethod: string;
  purpose: string;
  templateName: string;
  body: string;
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

async function bookAndConvert(fx: {
  owner: Actor;
  tenantId: string;
  customerName: string;
}): Promise<{ reservationId: string; order: request.Response }> {
  const owner = fx.owner;
  const product = await auth(
    request(server).post(`${base(fx.tenantId)}/products`),
    owner,
  ).send({ name: `Produk ${uid('wa')}`, stockMode: 'QUANTITY', capacity: 20 });
  if (product.status !== 201) throw new Error(JSON.stringify(product.body));
  const productId = product.body.data.id as string;

  const rate = await auth(
    request(server).post(`${base(fx.tenantId)}/products/${productId}/rates`),
    owner,
  ).send({ perDayAmount: 100_000 });
  if (rate.status !== 201 && rate.status !== 200) throw new Error(JSON.stringify(rate.body));

  const customer = await prisma.withTenant(fx.tenantId, async (tx) => {
    const id = randomUUID();
    return tx.customer.create({
      data: { id, tenantId: fx.tenantId, name: fx.customerName },
    });
  });

  const reservation = await auth(
    request(server).post(`${base(fx.tenantId)}/reservations`),
    owner,
  ).send({
    startAt: '2026-12-01T00:00:00.000Z',
    endAt: '2026-12-03T00:00:00.000Z',
    customerId: customer.id,
    items: [{ productId, quantity: 2 }],
  });
  if (reservation.status !== 201) throw new Error(JSON.stringify(reservation.body));

  const order = await auth(
    request(server).post(
      `${base(fx.tenantId)}/reservations/${reservation.body.data.id}/convert-to-order`,
    ),
    owner,
  );
  return { reservationId: reservation.body.data.id as string, order };
}

async function setup(prefix: string): Promise<Fixture> {
  const owner = await registerAndLogin(em(prefix));
  const tenant = await auth(request(server).post(`${API}/tenants`), owner).send({
    name: `Tenant ${prefix}`,
    slug: slug(prefix),
  });
  if (tenant.status !== 201) throw new Error(JSON.stringify(tenant.body));
  const tenantId = tenant.body.data.id as string;

  const settings = await auth(
    request(server).patch(`${base(tenantId)}/settings`),
    owner,
  ).send({ bookingMode: 'AUTOMATIC' });
  if (settings.status !== 204) throw new Error(JSON.stringify(settings.body));

  const customerName = `Penyewa ${prefix}`;
  const { order } = await bookAndConvert({ owner, tenantId, customerName });
  if (order.status !== 201) throw new Error(JSON.stringify(order.body));
  if (!Array.isArray(order.body.data.whatsappMessages)) {
    throw new Error(`whatsappMessages tidak ada: ${JSON.stringify(order.body.data)}`);
  }

  return {
    owner,
    tenantId,
    customerName,
    orderId: order.body.data.id as string,
    orderNumber: order.body.data.orderNumber as string,
    messages: order.body.data.whatsappMessages as WhatsAppMessage[],
  };
}

describe('WhatsApp pesan transaksi — booking dan payment', () => {
  it('booking memuat pesan per metode aktif, ter-render tanpa placeholder tersisa', async () => {
    const fx = await setup('wamsgbook');

    expect(fx.messages).toHaveLength(3);
    expect(fx.messages.map((message) => message.paymentMethod)).toEqual([
      'CASH',
      'BANK_TRANSFER',
      'QRIS',
    ]);
    for (const message of fx.messages) {
      expect(message.orderId).toBe(fx.orderId);
      expect(message.paymentId).toBeNull();
      expect(message.templateVersion).toBe(1);
      expect(message.body).not.toContain('{{');
      expect(message.body).not.toContain('undefined');
      expect(message.body).toContain(fx.orderNumber);
      expect(message.body).toContain(fx.customerName);
      expect(message.body).toContain('Rp400.000');
    }
    const cash = fx.messages.find((message) => message.paymentMethod === 'CASH')!;
    expect(cash.purpose).toBe('PAYMENT_INSTRUCTION');
    expect(cash.body).toContain('Tenant wamsgbook');
    const qris = fx.messages.find((message) => message.paymentMethod === 'QRIS')!;
    expect(qris.purpose).toBe('PAYMENT_CONFIRMATION');

    const rows = await prisma.withTenant(fx.tenantId, (tx) =>
      tx.transactionMessageSnapshot.findMany({ where: { tenantId: fx.tenantId } }),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.templateVersion === 1)).toBe(true);
    expect(rows.every((row) => row.paymentId === null)).toBe(true);

    // Detail order memuat riwayat yang sama tanpa endpoint terpisah.
    const detail = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}`),
      fx.owner,
    );
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const detailMessages = detail.body.data.whatsappMessages as WhatsAppMessage[];
    expect(detailMessages).toHaveLength(3);
    expect(detailMessages.map((message) => message.id).sort()).toEqual(
      fx.messages.map((message) => message.id).sort(),
    );
  });

  it('payment memuat konfirmasi dan snapshot tidak berubah saat template diedit', async () => {
    const fx = await setup('wamsgpay');
    const qrisTemplate = fx.messages.find((message) => message.paymentMethod === 'QRIS')!;

    const paid = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${fx.orderId}/payments`),
      fx.owner,
    ).send({ amount: '400000', currency: 'IDR', method: 'QRIS' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const paymentId = paid.body.data.id as string;
    const message = paid.body.data.whatsappMessage as WhatsAppMessage;
    expect(message).toBeTruthy();
    expect(message.paymentId).toBe(paymentId);
    expect(message.paymentMethod).toBe('QRIS');
    expect(message.purpose).toBe('PAYMENT_CONFIRMATION');
    expect(message.templateVersion).toBe(1);
    expect(message.body).toContain('QRIS');
    expect(message.body).toContain(fx.orderNumber);
    expect(message.body).not.toContain('{{');
    expect(message.body).not.toContain('undefined');

    const edited = await auth(
      request(server).patch(
        `${base(fx.tenantId)}/whatsapp-templates/${qrisTemplate.templateId}`,
      ),
      fx.owner,
    ).send({ body: 'Halo {{nama_penyewa}}, versi baru QRIS untuk {{nomor_pesanan}}.' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.currentVersion).toBe(2);

    const history = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}/whatsapp-messages`),
      fx.owner,
    );
    expect(history.status, JSON.stringify(history.body)).toBe(200);

    // Snapshot payment juga muncul inline pada detail order.
    const detail = await auth(
      request(server).get(`${base(fx.tenantId)}/orders/${fx.orderId}`),
      fx.owner,
    );
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const detailPayment = (detail.body.data.whatsappMessages as WhatsAppMessage[]).find(
      (row) => row.paymentId === paymentId,
    )!;
    expect(detailPayment.templateVersion).toBe(1);
    expect(detailPayment.body).toContain('QRIS');
    expect(detailPayment.body).not.toContain('versi baru');
    const paymentSnapshot = (history.body.data as WhatsAppMessage[]).find(
      (row) => row.paymentId === paymentId,
    )!;
    expect(paymentSnapshot.templateVersion).toBe(1);
    expect(paymentSnapshot.body).toContain('QRIS');
    expect(paymentSnapshot.body).not.toContain('versi baru');
    const bookingSnapshot = (history.body.data as WhatsAppMessage[]).find(
      (row) => row.paymentMethod === 'QRIS' && row.paymentId === null,
    )!;
    expect(bookingSnapshot.body).not.toContain('versi baru');
  });

  it('booking hanya menyertakan metode pembayaran yang aktif', async () => {
    const fx = await setup('wamsgmethod');

    const update = await auth(
      request(server).put(`${base(fx.tenantId)}/payment-methods`),
      fx.owner,
    ).send({
      settings: [
        { context: 'NEW_BOOKING', method: 'CASH', enabled: false },
        { context: 'NEW_BOOKING', method: 'BANK_TRANSFER', enabled: false },
      ],
    });
    expect(update.status, JSON.stringify(update.body)).toBe(200);

    const { order } = await bookAndConvert(fx);
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const messages = order.body.data.whatsappMessages as WhatsAppMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].paymentMethod).toBe('QRIS');
  });

  it('template nonaktif tidak menghasilkan pesan (booking kosong, payment null)', async () => {
    const fx = await setup('wamsginactive');
    const qrisTemplate = fx.messages.find((message) => message.paymentMethod === 'QRIS')!;

    await auth(
      request(server).put(`${base(fx.tenantId)}/payment-methods`),
      fx.owner,
    ).send({
      settings: [
        { context: 'NEW_BOOKING', method: 'CASH', enabled: false },
        { context: 'NEW_BOOKING', method: 'BANK_TRANSFER', enabled: false },
      ],
    });
    const deactivate = await auth(
      request(server).patch(
        `${base(fx.tenantId)}/whatsapp-templates/${qrisTemplate.templateId}`,
      ),
      fx.owner,
    ).send({ isActive: false });
    expect(deactivate.status, JSON.stringify(deactivate.body)).toBe(200);

    const { order } = await bookAndConvert(fx);
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(order.body.data.whatsappMessages).toEqual([]);

    const paid = await auth(
      request(server).post(`${base(fx.tenantId)}/orders/${order.body.data.id}/payments`),
      fx.owner,
    ).send({ amount: '100000', currency: 'IDR', method: 'QRIS' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.whatsappMessage).toBeNull();
  });

  it('tenant lain tidak dapat membaca snapshot order dan RLS menutup baris', async () => {
    const a = await setup('wamsgisoa');
    const b = await setup('wamsgisob');

    const forbidden = await auth(
      request(server).get(`${base(a.tenantId)}/orders/${a.orderId}/whatsapp-messages`),
      b.owner,
    );
    expect(forbidden.status).toBe(403);

    const rows = await prisma.withTenant(b.tenantId, (tx) =>
      tx.transactionMessageSnapshot.findMany({ where: { tenantId: a.tenantId } }),
    );
    expect(rows).toHaveLength(0);

    const own = await auth(
      request(server).get(`${base(a.tenantId)}/orders/${a.orderId}/whatsapp-messages`),
      a.owner,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.length).toBe(3);
  });
});

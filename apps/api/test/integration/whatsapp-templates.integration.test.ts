/**
 * Integration test: template WhatsApp per tenant.
 *
 * Mencakup:
 * - 9 template bawaan per tenant (3 konteks × 3 metode) + versi 1
 * - validasi placeholder resmi (tak dikenal / format rusak ditolak)
 * - create/update/restore-default/duplicate dengan histori versi
 * - preview tanpa `undefined`, nilai contoh untuk placeholder kosong
 * - isolasi tenant (API + RLS) dan permission MANAGER read-only
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
import { DEFAULT_BODIES } from '../../src/whatsapp-templates/whatsapp-templates.defaults.js';

const API = '/api/v1';
const PW = 'kata-sandi-whatsapp-template-001';
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
  templates: Record<string, { id: string; body: string }>;
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

  const list = await auth(
    request(server).get(`${base(tenantId)}/whatsapp-templates`),
    owner,
  );
  if (list.status !== 200) throw new Error(JSON.stringify(list.body));
  const templates: Fixture['templates'] = {};
  for (const row of list.body.data as { id: string; context: string; paymentMethod: string; purpose: string; body: string }[]) {
    templates[`${row.context}:${row.paymentMethod}:${row.purpose}`] = {
      id: row.id,
      body: row.body,
    };
  }

  return { owner, tenantId, templates };
}

describe('WhatsApp templates — default, validasi, dan versi', () => {
  it('tenant baru mendapat 9 template bawaan (3 konteks × 3 metode) dengan versi 1', async () => {
    const fx = await setup('watemplate');
    const list = await auth(
      request(server).get(`${base(fx.tenantId)}/whatsapp-templates`),
      fx.owner,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data).toHaveLength(9);
    expect(list.body.data.every((row: { isSystemDefault: boolean }) => row.isSystemDefault)).toBe(true);
    expect(list.body.data.every((row: { currentVersion: number }) => row.currentVersion === 1)).toBe(true);
    expect(list.body.data.filter((row: { context: string }) => row.context === 'NEW_BOOKING')).toHaveLength(3);

    const qris = list.body.data.find(
      (row: { context: string; paymentMethod: string; purpose: string }) =>
        row.context === 'NEW_BOOKING' && row.paymentMethod === 'QRIS',
    );
    expect(qris.purpose).toBe('PAYMENT_CONFIRMATION');
    expect(qris.body).toContain('{{nomor_pesanan}}');
  });

  it('placeholder tak dikenal atau format rusak ditolak 400', async () => {
    const fx = await setup('wabad');
    const unknown = await auth(
      request(server).post(`${base(fx.tenantId)}/whatsapp-templates`),
      fx.owner,
    ).send({
      context: 'NEW_BOOKING',
      paymentMethod: 'CASH',
      purpose: 'PAYMENT_CONFIRMATION',
      name: 'Tes placeholder',
      body: 'Halo {{nama_penyewa}} {{rahasia_lain}}',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('VALIDATION_ERROR');

    const malformed = await auth(
      request(server).post(`${base(fx.tenantId)}/whatsapp-templates`),
      fx.owner,
    ).send({
      context: 'NEW_BOOKING',
      paymentMethod: 'CASH',
      purpose: 'PAYMENT_CONFIRMATION',
      name: 'Tes format',
      body: 'Halo {{nama_penyewa',
    });
    expect(malformed.status).toBe(400);

    const blank = await auth(
      request(server).post(`${base(fx.tenantId)}/whatsapp-templates`),
      fx.owner,
    ).send({
      context: 'NEW_BOOKING',
      paymentMethod: 'CASH',
      purpose: 'PAYMENT_CONFIRMATION',
      name: 'Tes kosong',
      body: '   ',
    });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('update dan restore-default membuat versi baru tanpa menimpa histori', async () => {
    const fx = await setup('wavers');
    const templateId = fx.templates['NEW_BOOKING:BANK_TRANSFER:PAYMENT_INSTRUCTION'].id;
    const originalBody = fx.templates['NEW_BOOKING:BANK_TRANSFER:PAYMENT_INSTRUCTION'].body;

    const updated = await auth(
      request(server).patch(`${base(fx.tenantId)}/whatsapp-templates/${templateId}`),
      fx.owner,
    ).send({ body: 'Halo {{nama_penyewa}}, pembayaran {{nominal_tagihan}} diterima pada {{waktu_pembayaran}}.' });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data.currentVersion).toBe(2);
    expect(updated.body.data.isSystemDefault).toBe(false);
    expect(updated.body.data.versions).toHaveLength(2);
    expect(updated.body.data.versions[0].version).toBe(2);
    expect(updated.body.data.versions[1].bodySnapshot).toBe(originalBody);

    const blank = await auth(
      request(server).patch(`${base(fx.tenantId)}/whatsapp-templates/${templateId}`),
      fx.owner,
    ).send({ body: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.code).toBe('VALIDATION_ERROR');

    const restored = await auth(
      request(server).post(`${base(fx.tenantId)}/whatsapp-templates/${templateId}/restore-default`),
      fx.owner,
    );
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.data.currentVersion).toBe(3);
    expect(restored.body.data.isSystemDefault).toBe(true);
    expect(restored.body.data.body).toBe(DEFAULT_BODIES.BANK_TRANSFER);
    expect(restored.body.data.versions).toHaveLength(3);
    expect(restored.body.data.versions[1].bodySnapshot).toContain(
      'pembayaran {{nominal_tagihan}} diterima',
    );
  });

  it('restore-default menolak kombinasi tanpa template bawaan → 422', async () => {
    const fx = await setup('wanodefault');
    const created = await auth(
      request(server).post(`${base(fx.tenantId)}/whatsapp-templates`),
      fx.owner,
    ).send({
      context: 'NEW_BOOKING',
      paymentMethod: 'CASH',
      purpose: 'PAYMENT_CONFIRMATION',
      name: 'Tanpa default',
      body: 'Halo {{nama_penyewa}}',
    });
    expect(created.status).toBe(201);

    const restored = await auth(
      request(server).post(
        `${base(fx.tenantId)}/whatsapp-templates/${created.body.data.id}/restore-default`,
      ),
      fx.owner,
    );
    expect(restored.status).toBe(422);
    expect(restored.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('preview merender placeholder dan memakai nilai contoh bila tidak diisi', async () => {
    const fx = await setup('wapreview');
    const res = await auth(
      request(server).post(`${base(fx.tenantId)}/whatsapp-templates/preview`),
      fx.owner,
    ).send({
      body: 'Halo {{nama_penyewa}}, total {{nominal_tagihan}} untuk {{nomor_pesanan}}.',
      values: { nama_penyewa: 'Sari' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.body).toContain('Halo Sari');
    expect(res.body.data.body).toContain('Rp300.000');
    expect(res.body.data.body).toContain('ORD-20261020-ABCD');
    expect(res.body.data.body).not.toContain('undefined');
    expect(res.body.data.body).not.toContain('{{');

    const badValue = await auth(
      request(server).post(`${base(fx.tenantId)}/whatsapp-templates/preview`),
      fx.owner,
    ).send({ body: 'Halo {{nama_penyewa}}', values: { tidak_ada: 'x' } });
    expect(badValue.status).toBe(400);
  });

  it('template tenant lain tidak terlihat dan tidak dapat diubah', async () => {
    const a = await setup('waisoa');
    const b = await setup('waisob');
    const templateA = Object.values(a.templates)[0];

    const read = await auth(
      request(server).get(`${base(a.tenantId)}/whatsapp-templates/${templateA.id}`),
      b.owner,
    );
    expect(read.status).toBe(403);

    const write = await auth(
      request(server).patch(`${base(a.tenantId)}/whatsapp-templates/${templateA.id}`),
      b.owner,
    ).send({ body: 'Halo {{nama_penyewa}} dari tenant lain' });
    expect(write.status).toBe(403);

    const rowsB = await prisma.withTenant(b.tenantId, (tx) =>
      tx.whatsAppTemplate.findMany({ where: { tenantId: a.tenantId } }),
    );
    expect(rowsB).toHaveLength(0);

    const listB = await auth(
      request(server).get(`${base(b.tenantId)}/whatsapp-templates`),
      b.owner,
    );
    expect(listB.body.data).toHaveLength(9);
    expect(listB.body.data.every((row: { isSystemDefault: boolean }) => row.isSystemDefault)).toBe(true);
  });

  it('MANAGER boleh membaca tetapi tidak boleh mengubah template', async () => {
    const fx = await setup('waperm');
    const manager = await inviteManager(fx.owner, fx.tenantId, 'waperm-mgr');
    const template = Object.values(fx.templates)[0];

    const read = await auth(
      request(server).get(`${base(fx.tenantId)}/whatsapp-templates/${template.id}`),
      manager,
    );
    expect(read.status).toBe(200);

    const write = await auth(
      request(server).patch(`${base(fx.tenantId)}/whatsapp-templates/${template.id}`),
      manager,
    ).send({ body: 'Halo {{nama_penyewa}}' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('WhatsApp templates — duplicate', () => {
  it('menggandakan template ke kombinasi lain: versi 1, sumber tidak berubah', async () => {
    const fx = await setup('wadup');
    const source = fx.templates['NEW_BOOKING:BANK_TRANSFER:PAYMENT_INSTRUCTION'];

    const dup = await auth(
      request(server).post(
        `${base(fx.tenantId)}/whatsapp-templates/${source.id}/duplicate`,
      ),
      fx.owner,
    ).send({
      context: 'EXTENSION',
      paymentMethod: 'CASH',
      purpose: 'PAYMENT_CONFIRMATION',
    });
    expect(dup.status, JSON.stringify(dup.body)).toBe(201);
    expect(dup.body.data.id).not.toBe(source.id);
    expect(dup.body.data.body).toBe(source.body);
    expect(dup.body.data.name).toContain('(salinan)');
    expect(dup.body.data.context).toBe('EXTENSION');
    expect(dup.body.data.paymentMethod).toBe('CASH');
    expect(dup.body.data.purpose).toBe('PAYMENT_CONFIRMATION');
    expect(dup.body.data.currentVersion).toBe(1);
    expect(dup.body.data.isSystemDefault).toBe(false);
    expect(dup.body.data.versions).toHaveLength(1);
    expect(dup.body.data.versions[0].changeReason).toBe('TEMPLATE_DUPLICATED');
    expect(dup.body.data.versions[0].metadataSnapshot).toEqual({ duplicatedFrom: source.id });

    // Template sumber tidak tersentuh: versi, body, dan histori tetap.
    const original = await auth(
      request(server).get(`${base(fx.tenantId)}/whatsapp-templates/${source.id}`),
      fx.owner,
    );
    expect(original.status).toBe(200);
    expect(original.body.data.currentVersion).toBe(1);
    expect(original.body.data.body).toBe(source.body);
    expect(original.body.data.versions).toHaveLength(1);
    // Template bawaan dibuat saat tenant dibuat — bukan hasil duplikasi.
    expect(original.body.data.versions[0].changeReason).toBe('SEED_DEFAULT');

    // Salinan mengikuti status aktif sumber bila tidak dispesifikkan, dan
    // dapat dioverride eksplisit.
    const inactiveCopy = await auth(
      request(server).post(
        `${base(fx.tenantId)}/whatsapp-templates/${source.id}/duplicate`,
      ),
      fx.owner,
    ).send({
      context: 'EXTENSION',
      paymentMethod: 'BANK_TRANSFER',
      purpose: 'PAYMENT_CONFIRMATION',
      name: 'Salinan instruksi perpanjangan',
      isActive: false,
    });
    expect(inactiveCopy.status, JSON.stringify(inactiveCopy.body)).toBe(201);
    expect(inactiveCopy.body.data.name).toBe('Salinan instruksi perpanjangan');
    expect(inactiveCopy.body.data.isActive).toBe(false);
  });

  it('kombinasi tujuan yang sudah terisi ditolak 422 dan sumber tetap ada', async () => {
    const fx = await setup('wadupclash');
    const source = fx.templates['NEW_BOOKING:QRIS:PAYMENT_CONFIRMATION'];

    const clash = await auth(
      request(server).post(
        `${base(fx.tenantId)}/whatsapp-templates/${source.id}/duplicate`,
      ),
      fx.owner,
    ).send({
      context: 'NEW_BOOKING',
      paymentMethod: 'QRIS',
      purpose: 'PAYMENT_CONFIRMATION',
    });
    expect(clash.status).toBe(422);
    expect(clash.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    // Tidak ada template tambahan yang tercipta dari percobaan yang ditolak.
    const list = await auth(
      request(server).get(`${base(fx.tenantId)}/whatsapp-templates`),
      fx.owner,
    );
    expect(list.body.data).toHaveLength(9);

    const missing = await auth(
      request(server).post(
        `${base(fx.tenantId)}/whatsapp-templates/00000000-0000-4000-8000-000000000000/duplicate`,
      ),
      fx.owner,
    ).send({
      context: 'ADD_UNIT',
      paymentMethod: 'CASH',
      purpose: 'PAYMENT_CONFIRMATION',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('duplicate mengikuti permission dan isolasi tenant', async () => {
    const fx = await setup('wadupperm');
    const manager = await inviteManager(fx.owner, fx.tenantId, 'wadup-mgr');
    const source = fx.templates['NEW_BOOKING:BANK_TRANSFER:PAYMENT_INSTRUCTION'];
    const target = {
      context: 'ADD_UNIT',
      paymentMethod: 'QRIS',
      purpose: 'PAYMENT_CONFIRMATION',
    };

    const denied = await auth(
      request(server).post(
        `${base(fx.tenantId)}/whatsapp-templates/${source.id}/duplicate`,
      ),
      manager,
    ).send(target);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');

    // Tenant lain tidak dapat menggandakan template milik tenant ini
    // (maupun membacanya).
    const other = await setup('wadupiso');
    const cross = await auth(
      request(server).post(
        `${base(fx.tenantId)}/whatsapp-templates/${source.id}/duplicate`,
      ),
      other.owner,
    ).send(target);
    expect(cross.status).toBe(403);

    // Tanpa sesi → 401; tanpa CSRF → 403.
    const anonymous = await request(server)
      .post(`${base(fx.tenantId)}/whatsapp-templates/${source.id}/duplicate`)
      .send(target);
    expect(anonymous.status).toBe(401);

    const noCsrf = await request(server)
      .post(`${base(fx.tenantId)}/whatsapp-templates/${source.id}/duplicate`)
      .set('Cookie', fx.owner.cookie)
      .set('Origin', ORIGIN)
      .send(target);
    expect(noCsrf.status).toBe(403);
  });
});

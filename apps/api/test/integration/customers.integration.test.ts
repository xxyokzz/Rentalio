/**
 * Integration test: akun self-service & direktori pelanggan tenant.
 *
 * Kontrak docs/openapi.yaml:
 * - GET  /me
 * - GET  /tenants/{tenantId}/customers   (customer.read)
 * - POST /tenants/{tenantId}/customers   (customer.write)
 *
 * Fokus:
 * - /me hanya membaca akun milik sesi (tanpa parameter akun lain);
 * - profil pendaftaran ikut tampil dan membership aktif terdaftar;
 * - pelanggan selalu tenant-scoped, pencarian case-insensitive, paginasi;
 * - email/nomor duplikat ditolak 422 dengan petunjuk id pelanggan lama;
 * - CASHIER hanya boleh membaca; mutasi wajib CSRF.
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
const PW = 'kata-sandi-pelanggan-testing-001';
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

interface Actor {
  cookie: string;
  csrf: string;
  userId: string;
  email: string;
}

async function registerAndLogin(
  emailAddr: string,
  profile: { ownerName?: string; tenantName?: string; tenantSlug?: string } = {},
): Promise<Actor> {
  await request(server)
    .post(`${API}/auth/registrations`)
    .send({
      email: emailAddr,
      password: PW,
      termsAccepted: true,
      termsVersion: '2026-10-14',
      privacyVersion: '2026-10-14',
      ...profile,
    });
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
    email: emailAddr.toLowerCase(),
  };
}

function auth(actor: { cookie: string; csrf: string }) {
  return { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrf, Origin: ORIGIN };
}

function base(tenantId: string) {
  return `${API}/tenants/${tenantId}`;
}

async function createTenant(actor: Actor, prefix: string): Promise<string> {
  const tenant = await request(server)
    .post(`${API}/tenants`)
    .set({ Cookie: actor.cookie, 'X-CSRF-Token': actor.csrf, Origin: ORIGIN })
    .send({
      name: `Tenant ${prefix}`,
      slug: `${prefix.toLowerCase()}-${Date.now() % 1_000_000}`,
    });
  if (tenant.status !== 201) throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  return tenant.body.data.id as string;
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
  role: 'MANAGER' | 'CASHIER',
): Promise<Actor> {
  const email = em(prefix);
  const invite = await request(server)
    .post(`${base(tenantId)}/members`)
    .set(auth(owner))
    .send({ email, role });
  if (invite.status !== 201) throw new Error(`Gagal undang ${role}: ${JSON.stringify(invite.body)}`);
  const accept = await request(server)
    .post(`${API}/auth/invitations/accept`)
    .send({ token: lastInviteToken(email), password: PW });
  if (accept.status !== 200) throw new Error(`Gagal menerima undangan: ${JSON.stringify(accept.body)}`);
  const login = await request(server)
    .post(`${API}/auth/sessions`)
    .send({ email, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const user = await prisma.client.user.findUnique({ where: { email } });
  return {
    cookie: session.split(';')[0],
    csrf: login.headers['x-csrf-token'] as string,
    userId: user!.id,
    email,
  };
}

// ============================================================

describe('Akun — GET /me', () => {
  it('tanpa sesi → 401 UNAUTHENTICATED', async () => {
    const res = await request(server).get(`${API}/me`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('mengembalikan profil akun + membership aktif tanpa data rahasia', async () => {
    const email = em('me');
    const actor = await registerAndLogin(email, {
      ownerName: 'Sari Wulandari',
      tenantName: 'Sewa Kamera Sari',
      tenantSlug: `kamera-sari-${Date.now() % 1_000_000}`,
    });
    const tenantId = await createTenant(actor, `me-${Date.now() % 1_000_000}`);

    const res = await request(server).get(`${API}/me`).set('Cookie', actor.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: actor.userId,
      email,
      status: 'ACTIVE',
      profile: {
        ownerName: 'Sari Wulandari',
        tenantName: 'Sewa Kamera Sari',
      },
    });
    expect(res.body.data.emailVerifiedAt).toBeTruthy();
    const memberships = res.body.data.memberships as Array<Record<string, unknown>>;
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ tenantId, role: 'OWNER' });
    // Tidak ada hash/secret yang ikut terkirim.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain(PW);
  });
});

describe('Pelanggan — direktori tenant', () => {
  it('daftar kosong, tambah, pencarian, dan paginasi', async () => {
    const owner = await registerAndLogin(em('cust'));
    const tenantId = await createTenant(owner, `cust-${Date.now() % 1_000_000}`);

    const empty = await request(server).get(`${base(tenantId)}/customers`).set('Cookie', owner.cookie);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ items: [], total: 0, limit: 50, offset: 0 });

    const created = await request(server)
      .post(`${base(tenantId)}/customers`)
      .set(auth(owner))
      .send({ name: '  Budi Santoso ', email: 'Budi@Contoh.COM', phone: '+628123450001' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'Budi Santoso',
      email: 'budi@contoh.com',
      phone: '+628123450001',
      isGuest: false,
    });

    const second = await request(server)
      .post(`${base(tenantId)}/customers`)
      .set(auth(owner))
      .send({ name: 'Ani Lestari' });
    expect(second.status).toBe(201);
    expect(second.body.data.email).toBeNull();

    const searched = await request(server)
      .get(`${base(tenantId)}/customers?q=BUDI`)
      .set('Cookie', owner.cookie);
    expect(searched.status).toBe(200);
    expect(searched.body.data.total).toBe(1);
    expect(searched.body.data.items[0].id).toBe(created.body.data.id);
    expect(searched.body.data.limit).toBe(50);

    const paged = await request(server)
      .get(`${base(tenantId)}/customers?limit=1&offset=1`)
      .set('Cookie', owner.cookie);
    expect(paged.status).toBe(200);
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.total).toBe(2);
  });

  it('email atau nomor duplikat di tenant yang sama → 422 + id pelanggan lama', async () => {
    const owner = await registerAndLogin(em('custdup'));
    const tenantId = await createTenant(owner, `custdup-${Date.now() % 1_000_000}`);

    const first = await request(server)
      .post(`${base(tenantId)}/customers`)
      .set(auth(owner))
      .send({ name: 'Pelanggan Lama', email: 'lama@contoh.com' });
    expect(first.status).toBe(201);

    const dupeEmail = await request(server)
      .post(`${base(tenantId)}/customers`)
      .set(auth(owner))
      .send({ name: 'Pelanggan Baru', email: 'LAMA@contoh.com' });
    expect(dupeEmail.status).toBe(422);
    expect(dupeEmail.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(dupeEmail.body.error.details.customerId).toBe(first.body.data.id);

    const withPhone = await request(server)
      .post(`${base(tenantId)}/customers`)
      .set(auth(owner))
      .send({ name: 'Punya Nomor', phone: '+628129990002' });
    expect(withPhone.status).toBe(201);

    const dupePhone = await request(server)
      .post(`${base(tenantId)}/customers`)
      .set(auth(owner))
      .send({ name: 'Nomor Sama', phone: '+628129990002' });
    expect(dupePhone.status).toBe(422);
  });

  it('tidak ada akses lintas tenant', async () => {
    const ownerA = await registerAndLogin(em('custA'));
    const tenantA = await createTenant(ownerA, `custA-${Date.now() % 1_000_000}`);
    const ownerB = await registerAndLogin(em('custB'));
    await createTenant(ownerB, `custB-${Date.now() % 1_000_000}`);

    const listed = await request(server)
      .get(`${base(tenantA)}/customers`)
      .set('Cookie', ownerB.cookie);
    expect(listed.status).toBe(403);
    expect(listed.body.error.code).toBe('PERMISSION_DENIED');

    const created = await request(server)
      .post(`${base(tenantA)}/customers`)
      .set(auth(ownerB))
      .send({ name: 'Penyusup' });
    expect(created.status).toBe(403);
  });

  it('CASHIER hanya membaca dan mutasi tetap wajib CSRF', async () => {
    const owner = await registerAndLogin(em('custrole'));
    const tenantId = await createTenant(owner, `custrole-${Date.now() % 1_000_000}`);
    const cashier = await inviteRole(owner, tenantId, 'custrole-cashier', 'CASHIER');

    const read = await request(server)
      .get(`${base(tenantId)}/customers`)
      .set('Cookie', cashier.cookie);
    expect(read.status).toBe(200);

    const write = await request(server)
      .post(`${base(tenantId)}/customers`)
      .set(auth(cashier))
      .send({ name: 'Ditolak' });
    expect(write.status).toBe(403);

    const noCsrf = await request(server)
      .post(`${base(tenantId)}/customers`)
      .set({ Cookie: owner.cookie, Origin: ORIGIN })
      .send({ name: 'Tanpa CSRF' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });
});

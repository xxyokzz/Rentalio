/**
 * Integration test: Tenant Module
 *
 * Mencakup kontrak Notion 04 — kelompok "Auth dan tenant":
 * - POST   /tenants                        → buat tenant, actor jadi OWNER
 * - GET    /tenants                        → daftar tenant actor
 * - GET    /tenants/:id                    → detail tenant
 * - PATCH  /tenants/:id/settings           → ubah pengaturan (OWNER-only)
 * - GET    /tenants/:id/members            → daftar member (OWNER-only)
 * - POST   /tenants/:id/members            → undang staf (OWNER-only)
 * - PATCH  /tenants/:id/members/:userId    → update role/status (OWNER-only)
 *
 * Semua berjalan terhadap PostgreSQL sewain_test (sewain_dev runtime).
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
const PW = 'kata-sandi-tenant-testing-001';

let app: INestApplication;
let server: Server;
let emails: InstanceType<typeof EmailService>['testAdapter'];
let prisma: PrismaService;

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
function email(prefix: string) {
  return `${uid(prefix)}@contoh.com`;
}
function slug(prefix: string) {
  return `${prefix.toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now() % 100000}`;
}

async function setupApp() {
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  server = app.getHttpServer() as unknown as Server;
  emails = app.get(EmailService).testAdapter!;
  prisma = app.get(PrismaService);
}

beforeAll(setupApp, 120_000);
afterAll(() => app?.close());

/** Helper: daftar + verifikasi + login → { cookie, csrf, userId } */
async function register(e: string): Promise<{ cookie: string; csrf: string; userId: string }> {
  await request(server).post(`${API}/auth/registrations`).send({ email: e, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
  const otp = emails!.lastOtpFor(e);
  if (!otp) throw new Error(`Tidak ada OTP untuk ${e}`);
  await request(server).post(`${API}/auth/registrations/verify-email`).send({ email: e, code: otp });
  const login = await request(server).post(`${API}/auth/sessions`).send({ email: e, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const cookie = session.split(';')[0];
  const csrf = login.headers['x-csrf-token'] as string;
  const user = await prisma.client.user.findUnique({ where: { email: e } });
  return { cookie, csrf, userId: user!.id };
}

// ============================================================

describe('Tenant — buat & baca', () => {
  it('POST /tenants → 201, actor jadi OWNER, subscription TRIALING dibuat', async () => {
    const { cookie, csrf } = await register(email('owner'));
    const s = slug('tokowarna');

    const res = await request(server)
      .post(`${API}/tenants`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Toko Warna', slug: s });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ slug: s, name: 'Toko Warna' });
    expect(res.body.data.id).toBeTruthy();
    const tenantId = res.body.data.id as string;

    // Actor harus menjadi OWNER
    // RLS fail-closed: baca tabel tenant-scoped lewat konteks tenant.
    const member = await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.findFirst({ where: { tenantId } }),
    );
    expect(member?.role).toBe('OWNER');
    expect(member?.status).toBe('ACTIVE');

    // Tenant baru wajib langsung punya entitlement: trial tepat 72 jam sejak
    // activatedAt + baris subscription TRIALING. Tanpa ini
    // `SubscriptionPolicyService` mengembalikan NO_ENTITLEMENT dan seluruh
    // mutasi katalog/booking ditolak 403 TENANT_RESTRICTED (regresi P0).
    const tenant = await prisma.withTenant(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId } }),
    );
    expect(tenant!.activatedAt).not.toBeNull();
    expect(tenant!.trialEndsAt).not.toBeNull();
    expect(tenant!.trialEndsAt!.getTime() - tenant!.activatedAt!.getTime()).toBe(72 * 3600 * 1000);

    const subscription = await prisma.withTenant(tenantId, (tx) =>
      tx.subscription.findFirst({ where: { tenantId } }),
    );
    expect(subscription?.status).toBe('TRIALING');
    expect(subscription?.trialEndsAt?.getTime()).toBe(tenant!.trialEndsAt!.getTime());

    // 9 template WhatsApp bawaan (3 konteks × 3 metode) di-seed di transaksi
    // yang sama agar GET tidak perlu memutasi state.
    const templateCount = await prisma.withTenant(tenantId, (tx) =>
      tx.whatsAppTemplate.count({ where: { tenantId } }),
    );
    expect(templateCount).toBe(9);

    // Mutasi katalog tidak boleh diblokir restricted mode pada tenant baru.
    const product = await request(server)
      .post(`${API}/tenants/${tenantId}/products`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Tenda Uji Trial', stockMode: 'QUANTITY', capacity: 1 });
    expect(product.status).toBe(201);
  });

  it('registrasi + verifikasi tidak membuat tenant: actor tanpa tenant (onboarding)', async () => {
    const { cookie, userId } = await register(email('notenant'));

    // Verifikasi email hanya mengaktifkan akun. Pembuatan tenant (beserta trial,
    // subscription, dan template bawaan) adalah tanggung jawab POST /tenants,
    // sehingga actor baru harus belum punya tenant agar onboarding berjalan.
    const listed = await request(server).get(`${API}/tenants`).set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);

    const memberships = await prisma.withActor(userId, (tx) =>
      tx.tenantMembership.count({ where: { userId } }),
    );
    expect(memberships).toBe(0);
  });

  it('GET /tenants → daftar tenant actor berdasarkan membership', async () => {
    const { cookie } = await register(email('list'));

    // Sebelum buat tenant, daftar kosong
    const before = await request(server).get(`${API}/tenants`).set('Cookie', cookie);
    expect(before.status).toBe(200);
    const initLen = before.body.data.length;

    // Buat tenant
    const { csrf } = await getNewCsrf(cookie);
    await request(server)
      .post(`${API}/tenants`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Toko Baru', slug: slug('tbaru') });

    const after = await request(server).get(`${API}/tenants`).set('Cookie', cookie);
    expect(after.status).toBe(200);
    expect(after.body.data.length).toBe(initLen + 1);
  });

  it('GET /tenants/:id → detail tenant, field lengkap', async () => {
    const { cookie, csrf } = await register(email('detail'));
    const s = slug('detrental');
    const create = await request(server)
      .post(`${API}/tenants`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Detail Rental', slug: s, timezone: 'Asia/Makassar' });

    const tenantId = create.body.data.id;
    const res = await request(server).get(`${API}/tenants/${tenantId}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: tenantId,
      slug: s,
      name: 'Detail Rental',
      timezone: 'Asia/Makassar',
      status: 'ACTIVE',
      bookingMode: 'MANUAL',
      catalogPolicy: 'CHECK_AVAILABILITY',
      rentalExtensionEnabled: false,
    });
    // Tenant baru dibuat dengan subscription TRIALING 72 jam: UI memakai field
    // ini untuk mode terbatas, bukan menghitung sendiri dari trialEndsAt.
    expect(res.body.data.subscription).toMatchObject({
      status: 'TRIALING',
      restricted: false,
      reason: 'TRIAL',
    });
    expect(res.body.data.subscription.trialEndsAt).toBe(res.body.data.trialEndsAt);
  });

  it('slug duplikat → 422 BUSINESS_RULE_VIOLATION', async () => {
    const { cookie, csrf } = await register(email('dupslug'));
    const s = slug('duptest');
    // Buat pertama kali
    await request(server)
      .post(`${API}/tenants`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Pertama', slug: s });

    const { cookie: c2, csrf: csrf2 } = await register(email('dupslug2'));
    const res = await request(server)
      .post(`${API}/tenants`)
      .set('Cookie', c2)
      .set('X-CSRF-Token', csrf2)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Kedua', slug: s });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });

  it('slug format tidak valid → 400 VALIDATION_ERROR', async () => {
    const { cookie, csrf } = await register(email('badslug'));
    const res = await request(server)
      .post(`${API}/tenants`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ name: 'Bad Slug', slug: 'Bukan Slug Valid!' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('buat tenant tanpa autentikasi → 401', async () => {
    const res = await request(server)
      .post(`${API}/tenants`)
      .set('X-CSRF-Token', 'dummy')
      .send({ name: 'Gagal', slug: 'gagal-tanpa-auth' });
    expect(res.status).toBe(401);
  });

  it('response envelope memiliki request_id bukan correlationId', async () => {
    const res = await request(server).get(`${API}/tenants/non-existent-uuid`).set('Cookie', 'rentalio_session=invalid');
    expect(res.status).toBe(401);
    expect(res.body.error.request_id).toBeTruthy();
    expect(res.body.error.correlationId).toBeUndefined();
  });
});

describe('Tenant — pengaturan (OWNER-only)', () => {
  it('PATCH /tenants/:id/settings → 204, pengaturan berubah', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('settings');

    const res = await request(server)
      .patch(`${API}/tenants/${tenantId}/settings`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ bookingMode: 'AUTOMATIC', rentalExtensionEnabled: true });
    expect(res.status).toBe(204);

    const detail = await request(server).get(`${API}/tenants/${tenantId}`).set('Cookie', cookie);
    expect(detail.body.data.bookingMode).toBe('AUTOMATIC');
    expect(detail.body.data.rentalExtensionEnabled).toBe(true);
  });

  it('non-OWNER tidak bisa update pengaturan → 403', async () => {
    const { tenantId } = await registerAndCreateTenant('settingsguard');
    const { cookie: c2, csrf: csrf2 } = await register(email('nonowner'));
    const res = await request(server)
      .patch(`${API}/tenants/${tenantId}/settings`)
      .set('Cookie', c2)
      .set('X-CSRF-Token', csrf2)
      .set('Origin', 'http://localhost:3001')
      .send({ bookingMode: 'AUTOMATIC' });
    expect(res.status).toBe(403);
  });
});

describe('Tenant — membership management (OWNER-only)', () => {
  it('OWNER dapat melihat daftar member', async () => {
    const { cookie, tenantId } = await registerAndCreateTenant('memblist');
    const res = await request(server).get(`${API}/tenants/${tenantId}/members`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].role).toBe('OWNER');
    expect(res.body.data[0].status).toBe('ACTIVE');
  });

  it('POST /tenants/:id/members → 201, token undangan dibuat', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('invite');
    const staffEmail = email('staff');

    const res = await request(server)
      .post(`${API}/tenants/${tenantId}/members`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ email: staffEmail, role: 'STAFF' });

    expect(res.status).toBe(201);
    expect(res.body.data.invitationId).toBeTruthy();
    expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Undangan tersimpan di database
    const inv = await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMemberInvitation.findFirst({
        where: { tenantId, email: staffEmail.toLowerCase() },
      }),
    );
    expect(inv).not.toBeNull();
    expect(inv!.tokenHash).not.toContain(staffEmail); // hash, bukan plaintext
  });

  it('OWNER tidak bisa diundang (role OWNER diblokir DTO)', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('inviteowner');
    const res = await request(server)
      .post(`${API}/tenants/${tenantId}/members`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ email: email('bad'), role: 'OWNER' });
    expect(res.status).toBe(400); // OWNER tidak ada di MembershipRoleDto
  });

  it('non-OWNER tidak bisa mengundang staf → 403', async () => {
    const { tenantId } = await registerAndCreateTenant('inviteguard');
    const { cookie: c2, csrf: csrf2 } = await register(email('nonowner2'));
    const res = await request(server)
      .post(`${API}/tenants/${tenantId}/members`)
      .set('Cookie', c2)
      .set('X-CSRF-Token', csrf2)
      .set('Origin', 'http://localhost:3001')
      .send({ email: email('staf2'), role: 'STAFF' });
    expect(res.status).toBe(403);
  });

  it('PATCH /members/:userId → update status member', async () => {
    const { cookie, csrf, tenantId, userId } = await registerAndCreateTenant('membupd');

    // Tambah member STAFF terlebih dahulu (langsung via DB untuk test)
    const staffEmail = email('updstaff');
    const { userId: staffId } = await register(staffEmail);
    await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.create({
        data: {
          tenantId,
          userId: staffId,
          role: 'STAFF',
          status: 'ACTIVE',
          permissions: [],
          activatedAt: new Date(),
        },
      }),
    );

    const res = await request(server)
      .patch(`${API}/tenants/${tenantId}/members/${staffId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ role: 'CASHIER' });
    expect(res.status).toBe(204);

    const updated = await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: staffId } },
      }),
    );
    expect(updated!.role).toBe('CASHIER');

    // Audit event spesifik sesuai kontrak dokumen 10.
    const audit = await prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { tenantId, action: 'MEMBER_ROLE_CHANGED', entityId: updated!.id },
      }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].fromState).toBe('STAFF');
    expect(audit[0].toState).toBe('CASHIER');
  });

  it('revoke member mencabut seluruh sesi aktif + audit MEMBER_REVOKED', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('memrevoke');
    const staff = await register(email('revokestaff'));

    await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.create({
        data: {
          tenantId,
          userId: staff.userId,
          role: 'STAFF',
          status: 'ACTIVE',
          permissions: [],
          activatedAt: new Date(),
        },
      }),
    );

    // Sesi staf valid sebelum revoke.
    const before = await request(server)
      .get(`${API}/auth/sessions/current`)
      .set('Cookie', staff.cookie);
    expect(before.status).toBe(200);

    const revoke = await request(server)
      .patch(`${API}/tenants/${tenantId}/members/${staff.userId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ status: 'REVOKED' });
    expect(revoke.status).toBe(204);

    // Sesi staf langsung tidak berlaku — bukan menunggu expiry cookie.
    const after = await request(server)
      .get(`${API}/auth/sessions/current`)
      .set('Cookie', staff.cookie);
    expect(after.status).toBe(401);

    const sessions = await prisma.client.authSession.findMany({
      where: { userId: staff.userId },
    });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    const audit = await prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId, action: 'MEMBER_REVOKED' } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].toState).toBe('REVOKED');
  });

  it('proteksi single-owner: OWNER terakhir tidak bisa direvoke', async () => {
    const { cookie, csrf, tenantId, userId } = await registerAndCreateTenant('singleowner');
    const res = await request(server)
      .patch(`${API}/tenants/${tenantId}/members/${userId}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ status: 'REVOKED' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

// ============================================================
// Penerimaan undangan (token exchange end-to-end)
// ============================================================

describe('Tenant — penerimaan undangan staf', () => {
  it('undangan mengirim email bertoken; accept membuat akun + membership ACTIVE', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('invaccept');
    const staffEmail = email('acceptstaff');

    const invite = await request(server)
      .post(`${API}/tenants/${tenantId}/members`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ email: staffEmail, role: 'STAFF' });
    expect(invite.status).toBe(201);
    expect(invite.body.data.emailDelivered).toBe(true);

    const token = lastInviteToken(staffEmail);
    const accept = await request(server)
      .post(`${API}/auth/invitations/accept`)
      .send({ token, password: PW });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    expect(accept.body.data).toMatchObject({
      tenantId,
      email: staffEmail.toLowerCase(),
      role: 'STAFF',
    });

    // Akun aktif dan bisa login dengan password yang dibuat saat menerima.
    const user = await prisma.client.user.findUnique({
      where: { email: staffEmail.toLowerCase() },
    });
    expect(user!.status).toBe('ACTIVE');
    const login = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email: staffEmail, password: PW });
    expect(login.status).toBe(200);

    const membership = await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: user!.id } },
      }),
    );
    expect(membership!.status).toBe('ACTIVE');
    expect(membership!.role).toBe('STAFF');

    const audit = await prisma.withTenant(tenantId, (tx) =>
      tx.auditLog.findMany({ where: { tenantId, action: 'MEMBER_ACTIVATED' } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(user!.id);
  });

  it('token sekali pakai: accept kedua kali → 400 INVITATION_INVALID_OR_EXPIRED', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('invonce');
    const staffEmail = email('oncestaff');
    await request(server)
      .post(`${API}/tenants/${tenantId}/members`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ email: staffEmail, role: 'STAFF' });
    const token = lastInviteToken(staffEmail);

    const first = await request(server)
      .post(`${API}/auth/invitations/accept`)
      .send({ token, password: PW });
    expect(first.status).toBe(200);

    const second = await request(server)
      .post(`${API}/auth/invitations/accept`)
      .send({ token, password: PW });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVITATION_INVALID_OR_EXPIRED');
  });

  it('dua accept paralel dengan token sama → tepat satu berhasil', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('invrace');
    const staffEmail = email('racestaff');
    await request(server)
      .post(`${API}/tenants/${tenantId}/members`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ email: staffEmail, role: 'STAFF' });
    const token = lastInviteToken(staffEmail);

    const accept = () =>
      request(server)
        .post(`${API}/auth/invitations/accept`)
        .send({ token, password: PW });
    const [a, b] = await Promise.all([accept(), accept()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    expect([a, b].find((r) => r.status === 400)!.body.error.code).toBe(
      'INVITATION_INVALID_OR_EXPIRED',
    );

    // Hanya satu akun & satu membership.
    const users = await prisma.client.user.count({
      where: { email: staffEmail.toLowerCase() },
    });
    expect(users).toBe(1);
    const memberships = await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.count({ where: { tenantId } }),
    );
    expect(memberships).toBe(2); // OWNER + STAFF
  });

  it('token tidak dikenal → 400 INVITATION_INVALID_OR_EXPIRED', async () => {
    const res = await request(server)
      .post(`${API}/auth/invitations/accept`)
      .send({ token: 'token-palsu-yang-tidak-pernah-diterbitkan', password: PW });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVITATION_INVALID_OR_EXPIRED');
  });

  it('undangan kedaluwarsa → 400 dan membership tidak dibuat', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('invexpired');
    const staffEmail = email('expiredstaff');
    await request(server)
      .post(`${API}/tenants/${tenantId}/members`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ email: staffEmail, role: 'STAFF' });
    const token = lastInviteToken(staffEmail);

    await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMemberInvitation.updateMany({
        where: { tenantId, email: staffEmail.toLowerCase() },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );

    const res = await request(server)
      .post(`${API}/auth/invitations/accept`)
      .send({ token, password: PW });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVITATION_INVALID_OR_EXPIRED');

    const user = await prisma.client.user.findUnique({
      where: { email: staffEmail.toLowerCase() },
    });
    expect(user).toBeNull();
  });

  it('email sudah punya akun → password tidak diubah, membership diaktifkan', async () => {
    const { cookie, csrf, tenantId } = await registerAndCreateTenant('invexisting');
    const staffEmail = email('existingstaff');
    // Akun sudah terdaftar & terverifikasi sebelum diundang.
    await register(staffEmail);

    await request(server)
      .post(`${API}/tenants/${tenantId}/members`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .set('Origin', 'http://localhost:3001')
      .send({ email: staffEmail, role: 'CASHIER' });
    const token = lastInviteToken(staffEmail);

    // Tanpa password: akun lama dipakai apa adanya.
    const accept = await request(server)
      .post(`${API}/auth/invitations/accept`)
      .send({ token });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    expect(accept.body.data.role).toBe('CASHIER');

    // Password lama tetap berlaku (undangan tidak mereset kredensial).
    const login = await request(server)
      .post(`${API}/auth/sessions`)
      .send({ email: staffEmail, password: PW });
    expect(login.status).toBe(200);

    const user = await prisma.client.user.findUnique({
      where: { email: staffEmail.toLowerCase() },
    });
    const membership = await prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: user!.id } },
      }),
    );
    expect(membership!.role).toBe('CASHIER');
    expect(membership!.status).toBe('ACTIVE');
  });
});

// ============================================================
// Helpers
// ============================================================

function lastInviteToken(to: string): string {
  const sent = emails!.sent;
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (sent[i].to.toLowerCase() === to.toLowerCase()) {
      const match = sent[i].body.match(/token=([A-Za-z0-9_\-]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  }
  throw new Error(`Tidak ada token undangan untuk ${to}`);
}

async function getNewCsrf(cookie: string): Promise<{ csrf: string }> {
  // GET /auth/csrf menerbitkan token baru (token sebelumnya tidak berlaku).
  const res = await request(server).get(`${API}/auth/csrf`).set('Cookie', cookie);
  if (res.status !== 200) throw new Error(`Gagal mengambil CSRF: ${res.status}`);
  return { csrf: res.body.csrfToken as string };
}

async function registerAndCreateTenant(prefix: string): Promise<{
  cookie: string;
  csrf: string;
  tenantId: string;
  userId: string;
}> {
  const e = email(prefix);
  const { cookie, csrf, userId } = await register(e);
  const s = slug(prefix);
  const res = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', 'http://localhost:3001')
    .send({ name: `Tenant ${prefix}`, slug: s });
  expect(res.status, `gagal membuat tenant untuk ${prefix}: ${JSON.stringify(res.body)}`).toBe(201);
  return { cookie, csrf, tenantId: res.body.data.id, userId };
}

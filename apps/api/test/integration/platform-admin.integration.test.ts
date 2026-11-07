/**
 * Integration test PLAT-01/07 — dijalankan terhadap PostgreSQL NYATA
 * (database sewain_test, role runtime sewain_dev).
 *
 * Yang dibuktikan:
 * - bootstrap Super Admin hanya sekali seumur instalasi,
 * - login dua tahap: password → challenge, lalu TOTP (enrollment pertama),
 * - kode pemulihan sekali pakai,
 * - cookie admin HttpOnly/host-only dan TIDAK dapat dipakai ke endpoint tenant,
 * - cookie tenant TIDAK dapat dipakai ke endpoint admin,
 * - mutasi admin wajib CSRF + Origin admin yang persis.
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
import { EmailService, InMemoryEmailAdapter } from '../../src/email/email.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { PlatformAdminService } from '../../src/platform-admin/platform-admin.service.js';
import { TOTP_STEP_MS, totpCodeForStep } from '../../src/platform-admin/platform-admin.crypto.js';
import { hashPassword } from '../../src/common/crypto.js';

const API = '/api/v1';
const ADMIN_ORIGIN = 'http://localhost:3002';
const ADMIN_EMAIL = 'super-admin@rentalio.my.id';
const ADMIN_PASSWORD = 'kata-sandi-admin-platform-123';
const TENANT_PASSWORD = 'kata-sandi-tenant-panjang-123';

let app: INestApplication;
let server: Server;
let emails: InMemoryEmailAdapter;
let prisma: PrismaService;
let admin: PlatformAdminService;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@contoh.com`;
}

/** Kode TOTP saat ini untuk secret base32 apa pun. */
function currentTotp(secret: string): string {
  return totpCodeForStep(secret, Math.floor(Date.now() / TOTP_STEP_MS));
}

function secretFromProvisioningUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('provisioningUri tanpa secret');
  return secret;
}

function adminCookieOf(response: { headers: Record<string, unknown> }): string {
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const session = cookies?.find((c) => c.startsWith('rentalio_platform_admin='));
  if (!session) throw new Error('cookie admin tidak ditemukan pada respons');
  return session;
}

/** Helper tenant: daftar → verifikasi OTP → login. */
async function loginAsTenant(email: string): Promise<{ cookie: string; csrf: string }> {
  await request(server).post(`${API}/auth/registrations`).send({
    email,
    password: TENANT_PASSWORD,
    termsAccepted: true,
    termsVersion: '2026-10-14',
    privacyVersion: '2026-10-14',
  });
  const otp = emails.lastOtpFor(email);
  if (!otp) throw new Error(`Tidak ada OTP untuk ${email}`);
  await request(server)
    .post(`${API}/auth/registrations/verify-email`)
    .send({ email, code: otp });
  const login = await request(server)
    .post(`${API}/auth/sessions`)
    .send({ email, password: TENANT_PASSWORD });
  expect(login.status).toBe(200);
  const cookies = login.headers['set-cookie'] as unknown as string[];
  return {
    cookie: cookies.find((c) => c.startsWith('rentalio_session='))!.split(';')[0],
    csrf: login.headers['x-csrf-token'] as string,
  };
}

/** Helper: buat tenant baru sebagai OWNER (butuh sesi + CSRF tenant). */
async function createTenantAsOwner(input: {
  email: string;
  name: string;
  slug: string;
}): Promise<{ tenantId: string; cookie: string; csrf: string }> {
  const session = await loginAsTenant(input.email);
  const created = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', session.cookie)
    .set('X-CSRF-Token', session.csrf)
    .set('Origin', 'http://localhost:3001')
    .send({ name: input.name, slug: input.slug });
  expect(created.status).toBe(201);
  const tenantId = (created.body.data ?? created.body).id as string;
  expect(tenantId).toBeTruthy();
  return { tenantId, cookie: session.cookie, csrf: session.csrf };
}

/** Login admin lengkap (password + enrollment TOTP) untuk akun uji. */
async function loginAdmin(
  email: string,
  password: string,
): Promise<{ cookie: string; csrf: string }> {
  const first = await request(server)
    .post(`${API}/platform-admin/auth/login`)
    .send({ email, password });
  expect(first.status).toBe(200);
  expect(first.body.status).toBe('MFA_ENROLLMENT_REQUIRED');
  const secret = secretFromProvisioningUri(first.body.challenge.provisioningUri as string);
  const mfa = await request(server)
    .post(`${API}/platform-admin/auth/mfa`)
    .send({ challengeToken: first.body.challenge.challengeToken, code: currentTotp(secret) });
  expect(mfa.status).toBe(200);
  return {
    cookie: adminCookieOf(mfa).split(';')[0],
    csrf: mfa.body.csrfToken as string,
  };
}

/** Buat role uji dengan permission tertentu (idempoten terhadap kode unik per run). */
async function createRoleWithPermission(code: string, permissionCode: string): Promise<string> {
  const permission = await prisma.client.platformPermission.findUnique({
    where: { code: permissionCode },
  });
  if (!permission) throw new Error(`permission ${permissionCode} tidak ada di seed`);
  const role = await prisma.client.platformRole.create({
    data: {
      code,
      name: code,
      permissions: { create: { permissionId: permission.id } },
    },
  });
  return role.id;
}

async function createAdminWithRole(email: string, password: string, roleId: string) {
  const created = await prisma.client.platformAdminUser.create({
    data: { email, passwordHash: hashPassword(password) },
  });
  await prisma.client.platformAdminRole.create({
    data: { adminUserId: created.id, roleId },
  });
  return created.id;
}

/** Cari baris assignment (aktif maupun dicabut) untuk pasangan admin+role. */
async function findAssignment(adminId: string, roleCode: string) {
  const role = await prisma.client.platformRole.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} tidak ada di database`);
  return prisma.client.platformAdminRole.findMany({
    where: { adminUserId: adminId, roleId: role.id },
  });
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

  emails = app.get(EmailService).testAdapter!;
  prisma = app.get(PrismaService);
  admin = app.get(PlatformAdminService);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

let recoveryCodes: string[] = [];
let sessionCookie = '';
let csrfToken = '';
let enrolledSecret = '';
let challengeToken = '';
let directoryCookie = '';
let dashboardOnlyCookie = '';
let dashboardOnlyCsrf = '';
let directoryCsrf = '';
let firstTenantId = '';
let secondTenantId = '';
let firstSlug = '';

describe('bootstrap Admin Platform', () => {
  it('membuat Super Admin pertama beserta role-nya', async () => {
    const result = await admin.bootstrap({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(result.email).toBe(ADMIN_EMAIL);
    expect(result.role).toBe('PLATFORM_SUPER_ADMIN');

    const stored = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
      include: { roles: { include: { role: true } } },
    });
    // Password tidak pernah disimpan plaintext.
    expect(stored?.passwordHash).not.toContain(ADMIN_PASSWORD);
    expect(stored?.passwordHash.startsWith('scrypt$')).toBe(true);
    // TOTP belum aktif sampai login pertama menyelesaikan enrollment.
    expect(stored?.totpSecretEncrypted).toBeNull();
    expect(stored?.roles.map((r) => r.role.code)).toEqual(['PLATFORM_SUPER_ADMIN']);
  });

  it('menolak bootstrap kedua', async () => {
    await expect(
      admin.bootstrap({ email: 'admin-lain@rentalio.my.id', password: ADMIN_PASSWORD }),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });
});

describe('login admin dua tahap', () => {
  it('password salah dijawab 401 generik', async () => {
    const res = await request(server)
      .post(`${API}/platform-admin/auth/login`)
      .send({ email: ADMIN_EMAIL, password: 'password-yang-salah-sekali' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('email tak dikenal dijawab sama (anti-enumerasi)', async () => {
    const res = await request(server)
      .post(`${API}/platform-admin/auth/login`)
      .send({ email: 'tidak-ada@rentalio.my.id', password: ADMIN_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('password benar → challenge enrollment TOTP (belum ada cookie)', async () => {
    const res = await request(server)
      .post(`${API}/platform-admin/auth/login`)
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('MFA_ENROLLMENT_REQUIRED');
    expect(res.headers['set-cookie']).toBeUndefined();
    const uri = res.body.challenge.provisioningUri as string;
    enrolledSecret = secretFromProvisioningUri(uri);
    expect(uri).toContain('issuer=Rentalio%20Admin%20Platform');

    // Challenge berikutnya dipakai pada test selanjutnya.
    challengeToken = res.body.challenge.challengeToken as string;
  });

  it('kode TOTP salah → 401 tanpa cookie', async () => {
    const res = await request(server)
      .post(`${API}/platform-admin/auth/mfa`)
      .send({ challengeToken, code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_INVALID_OR_EXPIRED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('kode TOTP benar → sesi + cookie host-only + 10 kode pemulihan', async () => {
    const res = await request(server)
      .post(`${API}/platform-admin/auth/mfa`)
      .send({ challengeToken, code: currentTotp(enrolledSecret) });
    expect(res.status).toBe(200);
    recoveryCodes = res.body.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);
    csrfToken = res.body.csrfToken as string;

    const raw = adminCookieOf(res);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).not.toContain('Domain=');
    sessionCookie = raw.split(';')[0];

    // Secret TOTP tersimpan terenkripsi, bukan plaintext base32.
    const stored = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    expect(stored?.totpSecretEncrypted).toMatch(/^v1\./);
    expect(stored?.totpSecretEncrypted).not.toContain(enrolledSecret);
  });

  it('sesi aktif mengembalikan role dan permission efektif', async () => {
    const res = await request(server)
      .get(`${API}/platform-admin/session`)
      .set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(ADMIN_EMAIL);
    expect(res.body.data.roles).toEqual(['PLATFORM_SUPER_ADMIN']);
    expect(res.body.data.permissions).toContain('platform.tenants.suspend');
    expect(res.body.data.permissions).toContain('platform.roles.assign');
  });
});

describe('pemisahan identitas admin dan tenant', () => {
  it('cookie tenant tidak dapat dipakai ke endpoint admin', async () => {
    const tenant = await loginAsTenant(uniqueEmail('tenant-admin-boundary'));
    const res = await request(server)
      .get(`${API}/platform-admin/session`)
      .set('Cookie', tenant.cookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('cookie admin tidak dapat dipakai ke endpoint tenant', async () => {
    const res = await request(server).get(`${API}/tenants`).set('Cookie', sessionCookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('CSRF dan logout admin', () => {
  it('mutasi tanpa token CSRF ditolak 403', async () => {
    const res = await request(server)
      .delete(`${API}/platform-admin/session`)
      .set('Cookie', sessionCookie)
      .set('Origin', ADMIN_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('mutasi dengan Origin tenant ditolak 403 walau token benar', async () => {
    const res = await request(server)
      .delete(`${API}/platform-admin/session`)
      .set('Cookie', sessionCookie)
      .set('Origin', 'http://localhost:3001')
      .set('X-Platform-Admin-CSRF', csrfToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('issue CSRF ulang lalu logout berhasil dan sesi dicabut', async () => {
    const issued = await request(server)
      .get(`${API}/platform-admin/csrf`)
      .set('Cookie', sessionCookie);
    expect(issued.status).toBe(200);
    const freshToken = issued.body.csrfToken as string;

    const logout = await request(server)
      .delete(`${API}/platform-admin/session`)
      .set('Cookie', sessionCookie)
      .set('Origin', ADMIN_ORIGIN)
      .set('X-Platform-Admin-CSRF', freshToken);
    expect(logout.status).toBe(204);

    const after = await request(server)
      .get(`${API}/platform-admin/session`)
      .set('Cookie', sessionCookie);
    expect(after.status).toBe(401);
  });
});

describe('kode pemulihan', () => {
  it('sekali pakai: berhasil login lalu ditolak saat dipakai ulang', async () => {
    const first = await request(server)
      .post(`${API}/platform-admin/auth/login`)
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(first.body.status).toBe('MFA_REQUIRED');

    const used = await request(server)
      .post(`${API}/platform-admin/auth/recovery`)
      .send({
        challengeToken: first.body.challenge.challengeToken,
        recoveryCode: recoveryCodes[0],
      });
    expect(used.status).toBe(200);
    const cookie = adminCookieOf(used).split(';')[0];
    directoryCsrf = used.body.csrfToken as string;

    const resumed = await request(server)
      .get(`${API}/platform-admin/session`)
      .set('Cookie', cookie);
    expect(resumed.status).toBe(200);
    // Sesi ini dipakai oleh suite direktori tenant di bawah.
    directoryCookie = cookie;

    // Challenge baru dengan kode yang sama harus ditolak.
    const second = await request(server)
      .post(`${API}/platform-admin/auth/login`)
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const replay = await request(server)
      .post(`${API}/platform-admin/auth/recovery`)
      .send({
        challengeToken: second.body.challenge.challengeToken,
        recoveryCode: recoveryCodes[0],
      });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('MFA_INVALID_OR_EXPIRED');
  });
});

describe('direktori tenant Admin Platform', () => {
  it('menyiapkan dua tenant lewat alur tenant biasa', async () => {
    const stamp = Date.now();
    firstSlug = `dir-${stamp}-a`;
    const first = await createTenantAsOwner({
      email: uniqueEmail('dir-owner-a'),
      name: `Penyewaan Alpha ${stamp}`,
      slug: firstSlug,
    });
    const second = await createTenantAsOwner({
      email: uniqueEmail('dir-owner-b'),
      name: `Penyewaan Beta ${stamp}`,
      slug: `dir-${stamp}-b`,
    });
    firstTenantId = first.tenantId;
    secondTenantId = second.tenantId;
    expect(firstTenantId).not.toBe(secondTenantId);
  });

  it('admin dengan platform.tenants.list melihat metadata minimum + Cache-Control no-store', async () => {
    const res = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ pageSize: 100 })
      .set('Cookie', directoryCookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.total).toBeGreaterThanOrEqual(2);

    const item = (res.body.data as Record<string, unknown>[]).find(
      (row) => row.id === firstTenantId,
    );
    expect(item).toBeDefined();
    // Hanya metadata identitas bisnis: tanpa kontak, katalog, atau data pelanggan.
    expect(Object.keys(item!).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'slug',
      'status',
      'trialEndsAt',
    ]);
    expect(item!.slug).toBe(firstSlug);
    expect(item!.status).toBe('ACTIVE');
  });

  it('paginasi mengembalikan halaman berbeda tanpa duplikasi', async () => {
    const page1 = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ page: 1, pageSize: 1 })
      .set('Cookie', directoryCookie);
    const page2 = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ page: 2, pageSize: 1 })
      .set('Cookie', directoryCookie);
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    expect(page1.body.data).toHaveLength(1);
    expect(page2.body.data).toHaveLength(1);
    expect(page1.body.data[0].id).not.toBe(page2.body.data[0].id);
    expect(page2.body.page).toBe(2);
  });

  it('filter status dan pencarian slug bekerja; query tidak valid ditolak 400', async () => {
    const bySlug = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ q: firstSlug })
      .set('Cookie', directoryCookie);
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.data.map((row: { id: string }) => row.id)).toContain(firstTenantId);
    expect(bySlug.body.data.map((row: { id: string }) => row.id)).not.toContain(secondTenantId);

    // Suite lain berbagi database yang sama, jadi jangan mengasumsikan hasil
    // kosong: cukup pastikan filter benar-benar diterapkan.
    const suspended = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ status: 'SUSPENDED', pageSize: 100 })
      .set('Cookie', directoryCookie);
    expect(suspended.status).toBe(200);
    for (const row of suspended.body.data as { status: string }[]) {
      expect(row.status).toBe('SUSPENDED');
    }
    expect(suspended.body.data.map((row: { id: string }) => row.id)).not.toContain(
      firstTenantId,
    );

    // Kombinasi filter + pencarian: tenant ACTIVE milik suite ini tidak lolos.
    const activeButSuspended = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ status: 'SUSPENDED', q: firstSlug })
      .set('Cookie', directoryCookie);
    expect(activeButSuspended.status).toBe(200);
    expect(activeButSuspended.body.data).toHaveLength(0);

    const invalid = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ status: 'BUKAN_STATUS' })
      .set('Cookie', directoryCookie);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('RLS tetap menutup tabel tenant lain tanpa konteks admin', async () => {
    // Konteks `app.platform_admin` tidak bocor keluar transaksi direktori.
    const tenants = await prisma.client.tenant.findMany({ where: { id: firstTenantId } });
    expect(tenants).toHaveLength(0);
    const members = await prisma.client.tenantMembership.findMany({
      where: { tenantId: firstTenantId },
    });
    expect(members).toHaveLength(0);
  });

  it('setiap pembacaan direktori tercatat di audit append-only', async () => {
    const admin = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    const events = await prisma.client.platformAuditEvent.findMany({
      where: { action: 'PLATFORM_TENANT_DIRECTORY_VIEWED', actorAdminId: admin!.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0]!.targetType).toBe('tenant_directory');
    expect(events[0]!.outcome).toBe('SUCCESS');
    expect(events[0]!.correlationId).toBeTruthy();
    const metadata = events[0]!.metadata as Record<string, unknown>;
    expect(typeof metadata.returned).toBe('number');
    // Query pencarian tidak disimpan mentah, hanya penandanya.
    expect(metadata).toHaveProperty('hasSearch');
    expect(JSON.stringify(metadata)).not.toContain(firstSlug);
  });

  it('cookie tenant tetap ditolak 401 pada direktori', async () => {
    const session = await loginAsTenant(uniqueEmail('dir-tenant-cookie'));
    const res = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .set('Cookie', session.cookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('role tanpa platform.tenants.list ditolak 403 walau sesi admin valid', async () => {
    const email = `dashboard-only-${Date.now()}@rentalio.my.id`;
    const password = 'kata-sandi-dashboard-only-123';
    const admin = await prisma.client.platformAdminUser.create({
      data: { email, passwordHash: hashPassword(password) },
    });
    const role = await prisma.client.platformRole.create({
      data: { code: 'PLATFORM_TEST_DASHBOARD_ONLY', name: 'Dashboard Only' },
    });
    const permission = await prisma.client.platformPermission.findUnique({
      where: { code: 'platform.dashboard.read' },
    });
    await prisma.client.platformRolePermission.create({
      data: { roleId: role.id, permissionId: permission!.id },
    });
    await prisma.client.platformAdminRole.create({
      data: { adminUserId: admin.id, roleId: role.id },
    });

    const { cookie, csrf } = await loginAdmin(email, password);
    dashboardOnlyCookie = cookie;
    dashboardOnlyCsrf = csrf;

    // Permission efektif dihitung dari database, bukan daftar hardcode.
    const session = await request(server)
      .get(`${API}/platform-admin/session`)
      .set('Cookie', cookie);
    expect(session.status).toBe(200);
    expect(session.body.data.permissions).toEqual(['platform.dashboard.read']);

    const denied = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .set('Cookie', cookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('detail tenant Admin Platform', () => {
  const detailKeys = [
    'activatedAt',
    'createdAt',
    'currency',
    'id',
    'name',
    'slug',
    'status',
    'timezone',
    'trialEndsAt',
    'updatedAt',
  ];

  it('menampilkan ringkasan tenant dengan permission platform.tenants.read_summary', async () => {
    const res = await request(server)
      .get(`${API}/platform-admin/tenants/${firstTenantId}`)
      .set('Cookie', directoryCookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.id).toBe(firstTenantId);
    expect(res.body.data.slug).toBe(firstSlug);
    expect(Object.keys(res.body.data as Record<string, unknown>).sort()).toEqual(detailKeys);
    // Tidak ada data pemilik, anggota, atau kontak pada ringkasan admin.
    expect(JSON.stringify(res.body)).not.toContain('@contoh.com');
  });

  it('id bukan UUID ditolak 400, UUID tak dikenal ditolak 404', async () => {
    const invalid = await request(server)
      .get(`${API}/platform-admin/tenants/bukan-uuid`)
      .set('Cookie', directoryCookie);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const missing = await request(server)
      .get(`${API}/platform-admin/tenants/00000000-0000-4000-8000-000000000000`)
      .set('Cookie', directoryCookie);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('pembacaan sukses maupun gagal tercatat di audit', async () => {
    const admin = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    const events = await prisma.client.platformAuditEvent.findMany({
      where: { action: 'PLATFORM_TENANT_SUMMARY_VIEWED', actorAdminId: admin!.id },
      orderBy: { createdAt: 'desc' },
    });

    expect(events.length).toBeGreaterThanOrEqual(3);
    const success = events.find((event) => event.outcome === 'SUCCESS');
    expect(success).toBeDefined();
    expect(success!.targetType).toBe('tenant');
    expect(success!.targetId).toBe(firstTenantId);

    const notFound = events.find(
      (event) => event.targetId === '00000000-0000-4000-8000-000000000000',
    );
    expect(notFound?.outcome).toBe('FAILED');
    expect((notFound!.metadata as Record<string, unknown>).found).toBe(false);

    const invalidId = events.find((event) => event.targetId === 'bukan-uuid');
    expect(invalidId?.outcome).toBe('FAILED');
    expect((invalidId!.metadata as Record<string, unknown>).validId).toBe(false);
  });

  it('role tanpa platform.tenants.read_summary ditolak 403', async () => {
    // Role uji hanya punya platform.dashboard.read, jadi 403 di bawah
    // membuktikan `platform.tenants.read_summary` diperiksa tersendiri.
    const denied = await request(server)
      .get(`${API}/platform-admin/tenants/${firstTenantId}`)
      .set('Cookie', dashboardOnlyCookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('aksi status tenant Admin Platform', () => {
  const REASON = 'Suspensi sementara: tagihan langganan menunggak 14 hari.';

  function postStatusAction(
    action: 'suspend' | 'reactivate',
    tenantId: string,
    body: unknown,
    options: { origin?: string | null; csrf?: string | null; cookie?: string } = {},
  ) {
    const req = request(server)
      .post(`${API}/platform-admin/tenants/${tenantId}/${action}`)
      .set('Cookie', options.cookie ?? directoryCookie);
    if (options.origin !== null) req.set('Origin', options.origin ?? ADMIN_ORIGIN);
    if (options.csrf !== null) req.set('X-Platform-Admin-CSRF', options.csrf ?? directoryCsrf);
    return req.send(body as object);
  }

  it('alasan wajib: body kosong dan alasan terlalu pendek ditolak 400', async () => {
    const empty = await postStatusAction('suspend', firstTenantId, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const short = await postStatusAction('suspend', firstTenantId, { reason: 'pendek' });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('mutasi tanpa token CSRF atau dengan Origin tenant ditolak 403', async () => {
    const noCsrf = await postStatusAction(
      'suspend',
      firstTenantId,
      { reason: REASON },
      { csrf: null },
    );
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    const wrongOrigin = await postStatusAction(
      'suspend',
      firstTenantId,
      { reason: REASON },
      { origin: 'http://localhost:3001' },
    );
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('suspend sukses mengubah status dan menulis audit lengkap', async () => {
    const res = await postStatusAction('suspend', firstTenantId, { reason: REASON });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.status).toBe('SUSPENDED');

    const admin = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    const event = await prisma.client.platformAuditEvent.findFirst({
      where: {
        action: 'PLATFORM_TENANT_SUSPENDED',
        actorAdminId: admin!.id,
        outcome: 'SUCCESS',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event!.targetId).toBe(firstTenantId);
    expect(event!.reason).toBe(REASON);
    expect(event!.correlationId).toBeTruthy();
    expect(event!.metadata).toMatchObject({ fromStatus: 'ACTIVE', toStatus: 'SUSPENDED' });
  });

  it('trigger database menolak perubahan kolom selain status pada konteks admin', async () => {
    await expect(
      prisma.withPlatformAdmin((tx) =>
        tx.tenant.update({ where: { id: firstTenantId }, data: { name: 'Nama Diubah Admin' } }),
      ),
    ).rejects.toThrow(/hanya boleh mengubah status/i);
  });

  it('suspend ulang ditolak 409 dan tetap diaudit sebagai kegagalan', async () => {
    const res = await postStatusAction('suspend', firstTenantId, { reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const admin = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    const failed = await prisma.client.platformAuditEvent.findFirst({
      where: { action: 'PLATFORM_TENANT_SUSPENDED', actorAdminId: admin!.id, outcome: 'FAILED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(failed).not.toBeNull();
    expect(failed!.metadata).toMatchObject({ denial: 'INVALID_STATE', fromStatus: 'SUSPENDED' });
  });

  it('reactivate mengembalikan tenant ke ACTIVE dan diaudit', async () => {
    const res = await postStatusAction('reactivate', firstTenantId, {
      reason: 'Pembayaran diterima, tenant diaktifkan kembali.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');

    const admin = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    const event = await prisma.client.platformAuditEvent.findFirst({
      where: { action: 'PLATFORM_TENANT_REACTIVATED', actorAdminId: admin!.id, outcome: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event!.metadata).toMatchObject({ fromStatus: 'SUSPENDED', toStatus: 'ACTIVE' });
  });

  it('reactivate tenant yang sudah ACTIVE ditolak 409', async () => {
    const res = await postStatusAction('reactivate', firstTenantId, { reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('tenant CLOSED bersifat final: reactivate ditolak 409', async () => {
    await prisma.withTenant(firstTenantId, (tx) =>
      tx.tenant.update({ where: { id: firstTenantId }, data: { status: 'CLOSED' } }),
    );
    const res = await postStatusAction('reactivate', firstTenantId, { reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const still = await prisma.withPlatformAdmin((tx) =>
      tx.tenant.findUnique({ where: { id: firstTenantId }, select: { status: true } }),
    );
    expect(still?.status).toBe('CLOSED');
  });

  it('id tenant tak dikenal ditolak 404 dan diaudit', async () => {
    const res = await postStatusAction(
      'suspend',
      '00000000-0000-4000-8000-000000000001',
      { reason: REASON },
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('role tanpa platform.tenants.suspend ditolak 403', async () => {
    const res = await postStatusAction('suspend', secondTenantId, { reason: REASON }, {
      cookie: dashboardOnlyCookie,
      csrf: dashboardOnlyCsrf,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('audit viewer Admin Platform', () => {
  it('mengembalikan event terbaru lebih dulu tanpa cache', async () => {
    const res = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ pageSize: 10 })
      .set('Cookie', directoryCookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toHaveLength(10);
    expect(res.body.total).toBeGreaterThanOrEqual(10);

    const timestamps = (res.body.data as { createdAt: string }[]).map((row) =>
      new Date(row.createdAt).getTime(),
    );
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
  });

  it('filter aksi hanya mengembalikan aksi tersebut', async () => {
    const res = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ action: 'PLATFORM_TENANT_SUSPENDED', pageSize: 100 })
      .set('Cookie', directoryCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    for (const row of res.body.data as { action: string }[]) {
      expect(row.action).toBe('PLATFORM_TENANT_SUSPENDED');
    }
    const outcomes = (res.body.data as { outcome: string }[]).map((row) => row.outcome);
    expect(outcomes).toContain('SUCCESS');
    expect(outcomes).toContain('FAILED');
  });

  it('filter aktor hanya mengembalikan event aktor tersebut', async () => {
    const admin = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    const res = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ actorAdminId: admin!.id, pageSize: 100 })
      .set('Cookie', directoryCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    for (const row of res.body.data as { actorAdminId: string }[]) {
      expect(row.actorAdminId).toBe(admin!.id);
    }
  });

  it('filter waktu inklusif dan rentang terbalik ditolak 400', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const empty = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ from: future })
      .set('Cookie', directoryCookie);
    expect(empty.status).toBe(200);
    expect(empty.body.data).toHaveLength(0);
    expect(empty.body.total).toBe(0);

    const all = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ to: future, pageSize: 1 })
      .set('Cookie', directoryCookie);
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(10);

    const inverted = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ from: future, to: new Date(Date.now() - 60_000).toISOString() })
      .set('Cookie', directoryCookie);
    expect(inverted.status).toBe(400);
    expect(inverted.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('filter tidak valid ditolak 400', async () => {
    const badAction = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ action: 'PLATFORM_AKSI_NGAWUR' })
      .set('Cookie', directoryCookie);
    expect(badAction.status).toBe(400);
    expect(badAction.body.error.code).toBe('VALIDATION_ERROR');

    const badActor = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ actorAdminId: 'bukan-uuid' })
      .set('Cookie', directoryCookie);
    expect(badActor.status).toBe(400);
    expect(badActor.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('paginasi tidak menduplikasi event antar halaman', async () => {
    const page1 = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ page: 1, pageSize: 2 })
      .set('Cookie', directoryCookie);
    const page2 = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .query({ page: 2, pageSize: 2 })
      .set('Cookie', directoryCookie);
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    const ids1 = (page1.body.data as { id: string }[]).map((row) => row.id);
    const ids2 = (page2.body.data as { id: string }[]).map((row) => row.id);
    expect(ids1).toHaveLength(2);
    expect(ids2).toHaveLength(2);
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
  });

  it('cookie tenant ditolak 401 dan role tanpa platform.audit.read ditolak 403', async () => {
    const session = await loginAsTenant(uniqueEmail('audit-tenant-cookie'));
    const tenantRes = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .set('Cookie', session.cookie);
    expect(tenantRes.status).toBe(401);
    expect(tenantRes.body.error.code).toBe('UNAUTHENTICATED');

    const denied = await request(server)
      .get(`${API}/platform-admin/audit-events`)
      .set('Cookie', dashboardOnlyCookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('assignment role Admin Platform', () => {
  const REASON = 'Onboarding tim support: akses baca direktori tenant.';
  const BASE_ROLE = 'PLATFORM_TEST_BASE';
  const EXTRA_ROLE = 'PLATFORM_TEST_EXTRA';
  const ASSIGN_ONLY_ROLE = 'PLATFORM_TEST_ASSIGN_ONLY';
  const REVOKE_ONLY_ROLE = 'PLATFORM_TEST_REVOKE_ONLY';

  let superAdminId = '';
  let targetAdminId = '';
  let targetEmail = '';
  let targetPassword = '';
  let targetCookie = '';
  let assignOnlyCookie = '';
  let assignOnlyCsrf = '';
  let revokeOnlyCookie = '';
  let revokeOnlyCsrf = '';

  function postRoleAction(
    action: 'assign' | 'revoke',
    adminId: string,
    body: unknown,
    options: { origin?: string | null; csrf?: string | null; cookie?: string } = {},
  ) {
    const req = request(server)
      .post(`${API}/platform-admin/admins/${adminId}/roles/${action}`)
      .set('Cookie', options.cookie ?? directoryCookie);
    if (options.origin !== null) req.set('Origin', options.origin ?? ADMIN_ORIGIN);
    if (options.csrf !== null) req.set('X-Platform-Admin-CSRF', options.csrf ?? directoryCsrf);
    return req.send(body as object);
  }

  beforeAll(async () => {
    const stamp = `${Date.now()}`;
    const baseRoleId = await createRoleWithPermission(BASE_ROLE, 'platform.dashboard.read');
    await createRoleWithPermission(EXTRA_ROLE, 'platform.tenants.list');
    const assignOnlyRoleId = await createRoleWithPermission(ASSIGN_ONLY_ROLE, 'platform.roles.assign');
    const revokeOnlyRoleId = await createRoleWithPermission(REVOKE_ONLY_ROLE, 'platform.roles.revoke');

    targetEmail = `role-target-${stamp}@rentalio.my.id`;
    targetPassword = 'kata-sandi-target-role-123';
    targetAdminId = await createAdminWithRole(targetEmail, targetPassword, baseRoleId);

    const assignEmail = `role-assign-only-${stamp}@rentalio.my.id`;
    const revokeEmail = `role-revoke-only-${stamp}@rentalio.my.id`;
    await createAdminWithRole(assignEmail, 'kata-sandi-assign-only-123', assignOnlyRoleId);
    await createAdminWithRole(revokeEmail, 'kata-sandi-revoke-only-123', revokeOnlyRoleId);

    const superAdmin = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    superAdminId = superAdmin!.id;

    targetCookie = (await loginAdmin(targetEmail, targetPassword)).cookie;
    const assignSession = await loginAdmin(assignEmail, 'kata-sandi-assign-only-123');
    assignOnlyCookie = assignSession.cookie;
    assignOnlyCsrf = assignSession.csrf;
    const revokeSession = await loginAdmin(revokeEmail, 'kata-sandi-revoke-only-123');
    revokeOnlyCookie = revokeSession.cookie;
    revokeOnlyCsrf = revokeSession.csrf;
  }, 120_000);

  it('alasan dan roleCode wajib: body kosong, alasan pendek, kode salah format ditolak 400', async () => {
    const empty = await postRoleAction('assign', targetAdminId, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const short = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: 'pendek',
    });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('VALIDATION_ERROR');

    const badFormat = await postRoleAction('assign', targetAdminId, {
      roleCode: 'platform-huruf-kecil',
      reason: REASON,
    });
    expect(badFormat.status).toBe(400);
    expect(badFormat.body.error.code).toBe('VALIDATION_ERROR');

    // Properti tak dikenal juga ditolak (whitelist + forbidNonWhitelisted).
    const extraProp = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: REASON,
      grantedBy: 'klien',
    });
    expect(extraProp.status).toBe(400);
    expect(extraProp.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('mutasi tanpa token CSRF atau dengan Origin tenant ditolak 403', async () => {
    const noCsrf = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: REASON,
    }, { csrf: null });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    const wrongOrigin = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: REASON,
    }, { origin: 'http://localhost:3001' });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('permission assign dan revoke terpisah: masing-masing menolak 403', async () => {
    // Sebelum ada assign: sesi target hanya punya platform.dashboard.read.
    const before = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .set('Cookie', targetCookie);
    expect(before.status).toBe(403);

    // Hanya platform.roles.assign → revoke ditolak permission guard.
    const assignOnlyRevoke = await postRoleAction('revoke', targetAdminId, {
      roleCode: BASE_ROLE,
      reason: 'Mencoba cabut tanpa izin revoke yang sesungguhnya.',
    }, { cookie: assignOnlyCookie, csrf: assignOnlyCsrf });
    expect(assignOnlyRevoke.status).toBe(403);
    expect(assignOnlyRevoke.body.error.code).toBe('PERMISSION_DENIED');

    // Hanya platform.roles.revoke → assign ditolak permission guard.
    const revokeOnlyAssign = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: 'Mencoba tugaskan tanpa izin assign yang sesungguhnya.',
    }, { cookie: revokeOnlyCookie, csrf: revokeOnlyCsrf });
    expect(revokeOnlyAssign.status).toBe(403);
    expect(revokeOnlyAssign.body.error.code).toBe('PERMISSION_DENIED');

    // Role tanpa kedua permission (dashboard-only) ditolak di kedua endpoint.
    const dashboardAssign = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: 'Role dashboard-only tidak boleh menugaskan role lain.',
    }, { cookie: dashboardOnlyCookie, csrf: dashboardOnlyCsrf });
    expect(dashboardAssign.status).toBe(403);
    expect(dashboardAssign.body.error.code).toBe('PERMISSION_DENIED');

    // Percobaan yang ditolak guard tidak mengubah apa pun di database.
    const rows = await findAssignment(targetAdminId, EXTRA_ROLE);
    expect(rows).toHaveLength(0);
  });

  it('assign sukses: baris aktif, assignedBy aktor, dan audit SUCCESS dengan alasan', async () => {
    const res = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: REASON,
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({
      adminUserId: targetAdminId,
      roleCode: EXTRA_ROLE,
      revokedAt: null,
    });
    expect(res.body.data.assignedAt).toBeTruthy();

    const rows = await findAssignment(targetAdminId, EXTRA_ROLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
    expect(rows[0]!.assignedByAdminId).toBe(superAdminId);

    const event = await prisma.client.platformAuditEvent.findFirst({
      where: {
        action: 'PLATFORM_ADMIN_ROLE_ASSIGNED',
        actorAdminId: superAdminId,
        outcome: 'SUCCESS',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event!.targetType).toBe('platform_admin_user');
    expect(event!.targetId).toBe(targetAdminId);
    expect(event!.reason).toBe(REASON);
    expect(event!.correlationId).toBeTruthy();
    expect(event!.metadata).toMatchObject({ roleCode: EXTRA_ROLE });
  });

  it('permission efektif sesi target langsung bertambah setelah assign', async () => {
    const session = await request(server)
      .get(`${API}/platform-admin/session`)
      .set('Cookie', targetCookie);
    expect(session.status).toBe(200);
    expect(session.body.data.roles).toEqual(
      expect.arrayContaining([BASE_ROLE, EXTRA_ROLE]),
    );
    expect(session.body.data.permissions).toContain('platform.tenants.list');

    const after = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ pageSize: 1 })
      .set('Cookie', targetCookie);
    expect(after.status).toBe(200);
  });

  it('assign ulang ditolak 409 dan tetap diaudit sebagai kegagalan', async () => {
    const res = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: 'Mencoba menugaskan role yang sudah aktif.',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const failed = await prisma.client.platformAuditEvent.findFirst({
      where: {
        action: 'PLATFORM_ADMIN_ROLE_ASSIGNED',
        actorAdminId: superAdminId,
        outcome: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(failed).not.toBeNull();
    expect(failed!.targetId).toBe(targetAdminId);
    expect(failed!.reason).toBe('Mencoba menugaskan role yang sudah aktif.');
    expect(failed!.metadata).toMatchObject({ denial: 'ALREADY_ASSIGNED', roleCode: EXTRA_ROLE });
  });

  it('revoke sukses: revokedAt terisi, baris tetap ada, dan audit SUCCESS', async () => {
    const res = await postRoleAction('revoke', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: 'Masa tugas berakhir, akses direktori dicabut.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      adminUserId: targetAdminId,
      roleCode: EXTRA_ROLE,
    });
    expect(res.body.data.revokedAt).toBeTruthy();

    // Riwayat dipertahankan: baris tidak pernah dihapus (tanpa DELETE).
    const rows = await findAssignment(targetAdminId, EXTRA_ROLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).not.toBeNull();

    const event = await prisma.client.platformAuditEvent.findFirst({
      where: {
        action: 'PLATFORM_ADMIN_ROLE_REVOKED',
        actorAdminId: superAdminId,
        outcome: 'SUCCESS',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event!.targetId).toBe(targetAdminId);
    expect(event!.reason).toBe('Masa tugas berakhir, akses direktori dicabut.');
    expect(event!.metadata).toMatchObject({ roleCode: EXTRA_ROLE });
  });

  it('permission efektif sesi target langsung berkurang setelah revoke', async () => {
    const session = await request(server)
      .get(`${API}/platform-admin/session`)
      .set('Cookie', targetCookie);
    expect(session.status).toBe(200);
    expect(session.body.data.roles).not.toContain(EXTRA_ROLE);
    expect(session.body.data.permissions).not.toContain('platform.tenants.list');

    const denied = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .set('Cookie', targetCookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('revoke kedua ditolak 409 dan diaudit dengan denial ALREADY_REVOKED', async () => {
    const res = await postRoleAction('revoke', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: 'Mencoba mencabut penugasan yang sudah dicabut.',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const failed = await prisma.client.platformAuditEvent.findFirst({
      where: {
        action: 'PLATFORM_ADMIN_ROLE_REVOKED',
        actorAdminId: superAdminId,
        outcome: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(failed).not.toBeNull();
    expect(failed!.metadata).toMatchObject({ denial: 'ALREADY_REVOKED' });
  });

  it('assign ulang setelah revoke menghidupkan baris yang sama (tanpa duplikat)', async () => {
    const res = await postRoleAction('assign', targetAdminId, {
      roleCode: EXTRA_ROLE,
      reason: 'Ditugaskan kembali setelah masa tugas sebelumnya selesai.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.revokedAt).toBeNull();

    // Unique constraint (adminUserId, roleId): tetap satu baris, tanpa duplikat.
    const rows = await findAssignment(targetAdminId, EXTRA_ROLE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();

    const active = await request(server)
      .get(`${API}/platform-admin/tenants`)
      .query({ pageSize: 1 })
      .set('Cookie', targetCookie);
    expect(active.status).toBe(200);
  });

  it('admin tak dikenal 404, role tak dikenal 404, id bukan UUID 400 — semuanya diaudit', async () => {
    const missingAdmin = await postRoleAction(
      'assign',
      '00000000-0000-4000-8000-0000000000ff',
      { roleCode: EXTRA_ROLE, reason: 'Target admin memang tidak ada di database.' },
    );
    expect(missingAdmin.status).toBe(404);
    expect(missingAdmin.body.error.code).toBe('NOT_FOUND');

    const missingRole = await postRoleAction('assign', targetAdminId, {
      roleCode: 'PLATFORM_NGAWUR',
      reason: 'Role ini tidak pernah didefinisikan di platform_roles.',
    });
    expect(missingRole.status).toBe(404);
    expect(missingRole.body.error.code).toBe('NOT_FOUND');

    const invalidId = await postRoleAction('revoke', 'bukan-uuid', {
      roleCode: EXTRA_ROLE,
      reason: 'Id admin bukan UUID dan harus ditolak dengan 400.',
    });
    expect(invalidId.status).toBe(400);
    expect(invalidId.body.error.code).toBe('VALIDATION_ERROR');

    const admin = await prisma.client.platformAdminUser.findUnique({
      where: { email: ADMIN_EMAIL },
    });
    const failures = await prisma.client.platformAuditEvent.findMany({
      where: {
        actorAdminId: admin!.id,
        outcome: 'FAILED',
        action: { in: ['PLATFORM_ADMIN_ROLE_ASSIGNED', 'PLATFORM_ADMIN_ROLE_REVOKED'] },
        targetId: {
          in: [
            '00000000-0000-4000-8000-0000000000ff',
            targetAdminId,
            'bukan-uuid',
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const denials = failures.map(
      (event) => (event.metadata as Record<string, unknown>).denial,
    );
    expect(denials).toContain('ADMIN_NOT_FOUND');
    expect(denials).toContain('ROLE_NOT_FOUND');
    expect(denials).toContain('INVALID_ID');
    // Percobaan yang gagal menyimpan alasan lengkap untuk investigasi.
    for (const event of failures) expect((event.reason ?? '').length).toBeGreaterThanOrEqual(10);
  });

  it('audit viewer menerima aksi assign/revoke sebagai filter', async () => {
    for (const action of ['PLATFORM_ADMIN_ROLE_ASSIGNED', 'PLATFORM_ADMIN_ROLE_REVOKED']) {
      const res = await request(server)
        .get(`${API}/platform-admin/audit-events`)
        .query({ action, pageSize: 100 })
        .set('Cookie', directoryCookie);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const row of res.body.data as { action: string }[]) {
        expect(row.action).toBe(action);
      }
      const outcomes = (res.body.data as { outcome: string }[]).map((row) => row.outcome);
      expect(outcomes).toContain('SUCCESS');
      expect(outcomes).toContain('FAILED');
    }

    // Cookie tenant tetap ditolak pada kedua endpoint mutasi role.
    const session = await loginAsTenant(uniqueEmail('role-tenant-cookie'));
    const denied = await request(server)
      .post(`${API}/platform-admin/admins/${targetAdminId}/roles/assign`)
      .set('Cookie', session.cookie)
      .send({ roleCode: EXTRA_ROLE, reason: 'Cookie tenant tidak pernah menjadi bukti admin.' });
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('anti-lockout: menugaskan role ke diri sendiri ditolak 422 dan diaudit', async () => {
    // Aktor (directoryCookie = super admin) menugaskan role ke dirinya sendiri.
    const res = await postRoleAction('assign', superAdminId, {
      roleCode: EXTRA_ROLE,
      reason: 'Admin mencoba menugaskan role kepada dirinya sendiri.',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(res.body.error.message).toContain('diri sendiri');

    const failed = await prisma.client.platformAuditEvent.findFirst({
      where: {
        action: 'PLATFORM_ADMIN_ROLE_ASSIGNED',
        actorAdminId: superAdminId,
        targetId: superAdminId,
        outcome: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(failed).not.toBeNull();
    expect(failed!.reason).toBe('Admin mencoba menugaskan role kepada dirinya sendiri.');
    expect(failed!.metadata).toMatchObject({
      denial: 'SELF_ASSIGNMENT',
      roleCode: EXTRA_ROLE,
    });

    // Tidak ada baris penugasan yang tercipta untuk dirinya sendiri.
    const rows = await findAssignment(superAdminId, EXTRA_ROLE);
    expect(rows).toHaveLength(0);
  });

  it('anti-lockout: SUPER_ADMIN terakhir tidak dapat dicabut (422, tetap diaudit)', async () => {
    // Bootstrap hanya membuat satu penugasan PLATFORM_SUPER_ADMIN aktif.
    const active = await prisma.client.platformAdminRole.findMany({
      where: { role: { code: 'PLATFORM_SUPER_ADMIN' }, revokedAt: null },
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.adminUserId).toBe(superAdminId);

    const res = await postRoleAction('revoke', superAdminId, {
      roleCode: 'PLATFORM_SUPER_ADMIN',
      reason: 'Percobaan mencabut satu-satunya SUPER_ADMIN di platform.',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BUSINESS_RULE_VIOLATION');

    const failed = await prisma.client.platformAuditEvent.findFirst({
      where: {
        action: 'PLATFORM_ADMIN_ROLE_REVOKED',
        actorAdminId: superAdminId,
        targetId: superAdminId,
        outcome: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(failed).not.toBeNull();
    expect(failed!.metadata).toMatchObject({
      denial: 'LAST_SUPER_ADMIN',
      roleCode: 'PLATFORM_SUPER_ADMIN',
    });

    // Penugasan tetap aktif — platform tidak pernah kehilangan super admin.
    const rows = await findAssignment(superAdminId, 'PLATFORM_SUPER_ADMIN');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();

    // Sesi super admin aktif (directoryCookie) tetap berwenang penuh.
    const session = await request(server)
      .get(`${API}/platform-admin/session`)
      .set('Cookie', directoryCookie);
    expect(session.status).toBe(200);
    expect(session.body.data.roles).toContain('PLATFORM_SUPER_ADMIN');
  });

  it('anti-lockout: dengan dua SUPER_ADMIN aktif, mencabut satu tetap diizinkan', async () => {
    const superRole = await prisma.client.platformRole.findUnique({
      where: { code: 'PLATFORM_SUPER_ADMIN' },
    });
    expect(superRole).not.toBeNull();
    const secondId = await createAdminWithRole(
      `super-admin-2-${Date.now()}@rentalio.my.id`,
      'kata-sandi-super-admin-2-123',
      superRole!.id,
    );

    const res = await postRoleAction('revoke', secondId, {
      roleCode: 'PLATFORM_SUPER_ADMIN',
      reason: 'Rotasi jadwal: penugasan super admin kedua dicabut kembali.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ adminUserId: secondId, roleCode: 'PLATFORM_SUPER_ADMIN' });
    expect(res.body.data.revokedAt).toBeTruthy();

    // Kembali tepat satu SUPER_ADMIN aktif — yakni akun bootstrap.
    const active = await prisma.client.platformAdminRole.findMany({
      where: { role: { code: 'PLATFORM_SUPER_ADMIN' }, revokedAt: null },
    });
    expect(active).toHaveLength(1);
    expect(active[0]!.adminUserId).toBe(superAdminId);
  });
});

describe('direktori Admin Platform', () => {
  const READ_ROLE = 'PLATFORM_TEST_ROLES_READ';
  const REVOKED_ROLE = 'PLATFORM_TEST_REVOKED_HISTORY';
  const UNKNOWN_ID = '00000000-0000-4000-8000-0000000000ee';

  let readRoleId = '';
  let readAdminId = '';
  let readCookie = '';
  let subjectAdminId = '';
  let subjectEmail = '';

  beforeAll(async () => {
    const stamp = `${Date.now()}`;
    readRoleId = await createRoleWithPermission(READ_ROLE, 'platform.roles.read');
    const revokedRoleId = await createRoleWithPermission(REVOKED_ROLE, 'platform.dashboard.read');

    const readEmail = `roles-read-${stamp}@rentalio.my.id`;
    readAdminId = await createAdminWithRole(readEmail, 'kata-sandi-roles-read-123', readRoleId);
    readCookie = (await loginAdmin(readEmail, 'kata-sandi-roles-read-123')).cookie;

    subjectEmail = `roles-subject-${stamp}@rentalio.my.id`;
    subjectAdminId = await createAdminWithRole(subjectEmail, 'kata-sandi-roles-subject-123', readRoleId);

    // Riwayat: satu penugasan sengaja dicabut — tidak boleh muncul di direktori.
    const historyRow = await prisma.client.platformAdminRole.create({
      data: { adminUserId: subjectAdminId, roleId: revokedRoleId },
    });
    await prisma.client.platformAdminRole.update({
      where: { id: historyRow.id },
      data: { revokedAt: new Date() },
    });
  }, 120_000);

  it('daftar dengan platform.roles.read: role aktif tampil, riwayat tercabut tidak', async () => {
    const res = await request(server)
      .get(`${API}/platform-admin/admins`)
      .query({ q: subjectEmail, pageSize: 5 })
      .set('Cookie', readCookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.total).toBe(1);

    const row = (res.body.data as {
      id: string;
      email: string;
      status: string;
      roles: { roleCode: string }[];
    }[])[0];
    expect(row.id).toBe(subjectAdminId);
    expect(row.email).toBe(subjectEmail);
    expect(row.status).toBe('ACTIVE');
    // Hanya role aktif: penugasan yang sudah dicabut tidak ikut.
    expect(row.roles).toHaveLength(1);
    expect(row.roles[0]!.roleCode).toBe(READ_ROLE);

    // Identitas sensitif tidak pernah bocor ke respons.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('totpSecret');

    const event = await prisma.client.platformAuditEvent.findFirst({
      where: { action: 'PLATFORM_ADMIN_DIRECTORY_VIEWED', actorAdminId: readAdminId },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event!.metadata).toMatchObject({ hasSearch: true, returned: 1, total: 1 });
  });

  it('tanpa platform.roles.read ditolak 403 dan cookie tenant ditolak 401', async () => {
    const deniedList = await request(server)
      .get(`${API}/platform-admin/admins`)
      .set('Cookie', dashboardOnlyCookie);
    expect(deniedList.status).toBe(403);
    expect(deniedList.body.error.code).toBe('PERMISSION_DENIED');

    const deniedDetail = await request(server)
      .get(`${API}/platform-admin/admins/${subjectAdminId}`)
      .set('Cookie', dashboardOnlyCookie);
    expect(deniedDetail.status).toBe(403);
    expect(deniedDetail.body.error.code).toBe('PERMISSION_DENIED');

    const tenant = await loginAsTenant(uniqueEmail('admin-dir-tenant-cookie'));
    for (const path of ['admins', `admins/${subjectAdminId}`]) {
      const denied = await request(server)
        .get(`${API}/platform-admin/${path}`)
        .set('Cookie', tenant.cookie);
      expect(denied.status).toBe(401);
      expect(denied.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('detail admin mengembalikan role aktif + permission efektif dan diaudit', async () => {
    const res = await request(server)
      .get(`${API}/platform-admin/admins/${subjectAdminId}`)
      .set('Cookie', readCookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const data = res.body.data as {
      id: string;
      email: string;
      roles: { roleCode: string }[];
      permissions: string[];
    };
    expect(data.id).toBe(subjectAdminId);
    expect(data.email).toBe(subjectEmail);
    expect(data.roles).toHaveLength(1);
    expect(data.roles[0]!.roleCode).toBe(READ_ROLE);
    // Permission efektif diturunkan dari role aktif, bukan dari klaim klien.
    expect(data.permissions).toContain('platform.roles.read');
    expect(data.permissions).not.toContain('platform.tenants.suspend');

    const event = await prisma.client.platformAuditEvent.findFirst({
      where: {
        action: 'PLATFORM_ADMIN_DETAIL_VIEWED',
        actorAdminId: readAdminId,
        targetId: subjectAdminId,
        outcome: 'SUCCESS',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(event!.metadata).toMatchObject({ found: true, validId: true });
  });

  it('detail: id bukan UUID 400 dan tak dikenal 404 — keduanya diaudit FAILED', async () => {
    const invalid = await request(server)
      .get(`${API}/platform-admin/admins/bukan-uuid`)
      .set('Cookie', readCookie);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const missing = await request(server)
      .get(`${API}/platform-admin/admins/${UNKNOWN_ID}`)
      .set('Cookie', readCookie);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const failures = await prisma.client.platformAuditEvent.findMany({
      where: {
        action: 'PLATFORM_ADMIN_DETAIL_VIEWED',
        actorAdminId: readAdminId,
        outcome: 'FAILED',
      },
      orderBy: { createdAt: 'desc' },
    });
    const metadatas = failures.map((event) => event.metadata as Record<string, unknown>);
    expect(metadatas.some((m) => m.validId === false && m.found === false)).toBe(true);
    expect(metadatas.some((m) => m.validId === true && m.found === false)).toBe(true);
  });

  it('aksi direktori diterima sebagai filter audit viewer', async () => {
    for (const action of ['PLATFORM_ADMIN_DIRECTORY_VIEWED', 'PLATFORM_ADMIN_DETAIL_VIEWED']) {
      const res = await request(server)
        .get(`${API}/platform-admin/audit-events`)
        .query({ action, pageSize: 10 })
        .set('Cookie', directoryCookie);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const row of res.body.data as { action: string }[]) {
        expect(row.action).toBe(action);
      }
    }
  });
});

/**
 * Re-authentication Admin Platform (tindakan berisiko).
 *
 * Endpoint baru hanya bernilai kalau tiga lapis pengamannya terbukti di HTTP
 * nyata: CSRF admin (Origin persis + token terikat sesi), proteksi replay TOTP
 * (langkah waktu tidak boleh dipakai dua kali), dan rate limit per sesi.
 * Guard recent-auth juga dibuktikan benar-benar menggerbangi endpoint berisiko:
 * sesi tua ditolak, lalu lolos setelah re-authentication berhasil.
 */
describe('re-authentication Admin Platform', () => {
  const ROLE_CODE = `PLATFORM_REAUTH_${Date.now()}`;
  const REAUTH_PASSWORD = 'kata-sandi-reauth-admin-123';
  const reauthEmail = `reauth-admin-${Date.now()}@rentalio.my.id`;
  const UNKNOWN_TENANT = '88888888-8888-4888-8888-888888888888';

  let cookie = '';
  let csrf = '';
  let secret = '';
  let sessionId = '';
  let usedStep = 0;
  let appConfig: { RATE_LIMIT_SCALE: number };

  const currentStep = (): number => Math.floor(Date.now() / TOTP_STEP_MS);

  /** Bucket rate limit dipakai bersama seluruh suite; kosongkan sebelum diuji. */
  async function clearReauthRateLimits(): Promise<void> {
    await prisma.client.rateLimitCounter.deleteMany({});
  }

  function reauth(
    body: Record<string, unknown>,
    options: { origin?: string | null; csrf?: string | null; cookie?: string | null } = {},
  ) {
    const origin = options.origin === undefined ? ADMIN_ORIGIN : options.origin;
    const token = options.csrf === undefined ? csrf : options.csrf;
    const session = options.cookie === undefined ? cookie : options.cookie;
    let call = request(server).post(`${API}/platform-admin/auth/reauth`);
    if (session) call = call.set('Cookie', session);
    if (token) call = call.set('X-Platform-Admin-CSRF', token);
    if (origin) call = call.set('Origin', origin);
    return call.send(body);
  }

  beforeAll(async () => {
    const permissions = await prisma.client.platformPermission.findMany({
      where: { code: { in: ['platform.tenants.list', 'platform.tenants.suspend'] } },
      select: { id: true },
    });
    expect(permissions).toHaveLength(2);

    const role = await prisma.client.platformRole.create({
      data: {
        code: ROLE_CODE,
        name: 'Role uji re-authentication',
        permissions: {
          create: permissions.map((permission) => ({ permissionId: permission.id })),
        },
      },
    });
    await createAdminWithRole(reauthEmail, REAUTH_PASSWORD, role.id);

    const first = await request(server)
      .post(`${API}/platform-admin/auth/login`)
      .send({ email: reauthEmail, password: REAUTH_PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('MFA_ENROLLMENT_REQUIRED');
    secret = secretFromProvisioningUri(first.body.challenge.provisioningUri as string);

    const mfa = await request(server)
      .post(`${API}/platform-admin/auth/mfa`)
      .send({ challengeToken: first.body.challenge.challengeToken, code: currentTotp(secret) });
    expect(mfa.status).toBe(200);
    cookie = adminCookieOf(mfa).split(';')[0];
    csrf = mfa.body.csrfToken as string;

    const session = await prisma.client.platformAdminSession.findFirst({
      where: { adminUser: { email: reauthEmail } },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) throw new Error('sesi re-authentication tidak ditemukan');
    sessionId = session.id;
    appConfig = app.get('APP_CONFIG') as { RATE_LIMIT_SCALE: number };
  });

  it('tanpa cookie sesi ditolak 401', async () => {
    const res = await reauth(
      { password: REAUTH_PASSWORD, code: currentTotp(secret) },
      { cookie: null },
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('tanpa header token CSRF ditolak 403', async () => {
    const res = await reauth({ password: REAUTH_PASSWORD, code: '123456' }, { csrf: null });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('Origin selain origin admin ditolak 403', async () => {
    const res = await reauth(
      { password: REAUTH_PASSWORD, code: '123456' },
      { origin: 'http://evil.example.com' },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_VALIDATION_FAILED');
  });

  it('password salah 401 dan audit mencatat tahap password', async () => {
    const res = await reauth({
      password: 'kata-sandi-salah-reauth',
      code: currentTotp(secret),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const event = await prisma.client.platformAuditEvent.findFirst({
      where: { action: 'PLATFORM_ADMIN_REAUTHENTICATION_FAILED', targetId: sessionId },
      orderBy: { createdAt: 'desc' },
    });
    expect((event?.metadata as Record<string, unknown> | null)?.stage).toBe('password');
  });

  it('kode TOTP salah 401 dan audit mencatat tahap totp', async () => {
    const res = await reauth({ password: REAUTH_PASSWORD, code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_INVALID_OR_EXPIRED');

    const event = await prisma.client.platformAuditEvent.findFirst({
      where: { action: 'PLATFORM_ADMIN_REAUTHENTICATION_FAILED', targetId: sessionId },
      orderBy: { createdAt: 'desc' },
    });
    expect((event?.metadata as Record<string, unknown> | null)?.stage).toBe('totp');
  });

  it('sesi dengan re-auth kedaluwarsa ditolak pada suspend', async () => {
    await prisma.client.platformAdminSession.update({
      where: { id: sessionId },
      data: { reauthenticatedAt: new Date(Date.now() - 11 * 60_000) },
    });
    const res = await request(server)
      .post(`${API}/platform-admin/tenants/${UNKNOWN_TENANT}/suspend`)
      .set('Cookie', cookie)
      .set('X-Platform-Admin-CSRF', csrf)
      .set('Origin', ADMIN_ORIGIN)
      .send({ reason: 'uji re-auth kedaluwarsa pada tindakan berisiko' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
  });

  it('password + TOTP benar menyegarkan reauthenticatedAt dan membuka guard', async () => {
    usedStep = currentStep();
    // Langkah sebelumnya dianggap sudah dipakai agar kode saat ini sah.
    await prisma.client.platformAdminUser.update({
      where: { email: reauthEmail },
      data: { lastTotpStep: BigInt(usedStep - 1) },
    });

    const res = await reauth({
      password: REAUTH_PASSWORD,
      code: totpCodeForStep(secret, usedStep),
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.reauthenticatedAt).toBe('string');

    const session = await prisma.client.platformAdminSession.findUnique({
      where: { id: sessionId },
    });
    expect(session?.reauthenticatedAt?.getTime() ?? 0).toBeGreaterThan(Date.now() - 60_000);

    const event = await prisma.client.platformAuditEvent.findFirst({
      where: { action: 'PLATFORM_ADMIN_REAUTHENTICATED', targetId: sessionId },
      orderBy: { createdAt: 'desc' },
    });
    expect(event).not.toBeNull();

    // Guard yang tadinya menolak kini meloloskan; service lalu menjawab 404.
    const suspend = await request(server)
      .post(`${API}/platform-admin/tenants/${UNKNOWN_TENANT}/suspend`)
      .set('Cookie', cookie)
      .set('X-Platform-Admin-CSRF', csrf)
      .set('Origin', ADMIN_ORIGIN)
      .send({ reason: 'uji guard lolos setelah re-authentication' });
    expect(suspend.status).toBe(404);
    expect(suspend.body.error.code).toBe('NOT_FOUND');
  });

  it('kode TOTP yang sama tidak dapat dipakai dua kali (replay)', async () => {
    const res = await reauth({
      password: REAUTH_PASSWORD,
      code: totpCodeForStep(secret, usedStep),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_INVALID_OR_EXPIRED');
  });

  it('dibatasi per sesi (5/15 menit) dengan 429 RATE_LIMITED', async () => {
    const scale = appConfig.RATE_LIMIT_SCALE;
    appConfig.RATE_LIMIT_SCALE = 1;
    try {
      await clearReauthRateLimits();
      let sawLimit = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const res = await reauth({ password: 'kata-sandi-salah-reauth', code: '000000' });
        if (res.status === 429) {
          expect(res.body.error.code).toBe('RATE_LIMITED');
          sawLimit = true;
          break;
        }
        expect(res.status).toBe(401);
      }
      expect(sawLimit).toBe(true);
    } finally {
      appConfig.RATE_LIMIT_SCALE = scale;
      await clearReauthRateLimits();
    }
  });
});

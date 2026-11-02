/**
 * Audit RLS: setiap tabel tenant-scoped harus ENABLE + FORCE ROW LEVEL
 * SECURITY, punya policy tenant, dan benar-benar memisahkan data lintas
 * tenant saat diakses role runtime (`sewain_dev`, bukan owner tabel).
 *
 * Dua lapis pengujian:
 * 1. Katalog PostgreSQL — invarian skema untuk SEMUA tabel (bukan sampel),
 *    sehingga tabel baru tanpa RLS langsung menggagalkan suite.
 * 2. Perilaku — baca/tulis lintas tenant lewat role runtime, termasuk
 *    fail-closed saat `app.tenant_id` belum diset (GUC kosong).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const PW = 'kata-sandi-rls-audit-001';
const ORIGIN = 'http://localhost:3001';

/** Tabel platform-wide yang boleh menyimpan baris `tenantId` NULL. */
const GLOBAL_ROW_TABLES = new Set(['plans', 'audit_logs']);

let app: INestApplication;
let server: Server;
let prisma: PrismaService;
let emailSvc: InstanceType<typeof EmailService>;

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

interface Owner {
  cookie: string;
  csrf: string;
  tenantId: string;
  userId: string;
}

async function registerOwner(prefix: string): Promise<Owner> {
  const email = `${uid(prefix)}@contoh.com`;
  await request(server).post(`${API}/auth/registrations`).send({ email, password: PW, termsAccepted: true, termsVersion: '2026-10-14', privacyVersion: '2026-10-14' });
  const otp = emailSvc.testAdapter!.lastOtpFor(email);
  if (!otp) throw new Error(`OTP tidak ada untuk ${email}`);
  const verified = await request(server)
    .post(`${API}/auth/registrations/verify-email`)
    .send({ email, code: otp });
  if (verified.status !== 204) {
    throw new Error(`Verifikasi gagal: ${JSON.stringify(verified.body)}`);
  }

  const login = await request(server).post(`${API}/auth/sessions`).send({ email, password: PW });
  const session = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const user = await prisma.client.user.findUnique({ where: { email: email.toLowerCase() } });
  // Tenant hasil verifikasi belum punya langganan aktif; buat tenant lewat API
  // (jalur yang sama dengan suite lain) agar operasi katalog tidak ditolak
  // TENANT_RESTRICTED.
  const cookie = session.split(';')[0];
  const csrf = login.headers['x-csrf-token'] as string;
  const tenant = await request(server)
    .post(`${API}/tenants`)
    .set('Cookie', cookie)
    .set('X-CSRF-Token', csrf)
    .set('Origin', ORIGIN)
    .send({ name: `Tenant ${prefix}`, slug: `${prefix}-${Date.now() % 1000000}` });
  if (tenant.status !== 201) throw new Error(`Gagal buat tenant: ${JSON.stringify(tenant.body)}`);
  return {
    cookie,
    csrf,
    tenantId: tenant.body.data.id as string,
    userId: user!.id,
  };
}

async function createProduct(owner: Owner, name: string): Promise<string> {
  const res = await request(server)
    .post(`${API}/tenants/${owner.tenantId}/products`)
    .set('Cookie', owner.cookie)
    .set('X-CSRF-Token', owner.csrf)
    .set('Origin', ORIGIN)
    .send({ name, stockMode: 'QUANTITY', capacity: 3 });
  if (res.status !== 201) throw new Error(`Gagal buat produk: ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
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
  prisma = app.get(PrismaService);
  emailSvc = app.get(EmailService);
}, 120_000);

afterAll(() => app?.close());

interface TableRls {
  relname: string;
  rls: boolean;
  force: boolean;
  policies: number;
}

interface PolicyRow {
  relname: string;
  polname: string;
  using_expr: string;
  check_expr: string;
}

async function tenantTables(): Promise<TableRls[]> {
  return prisma.client.$queryRaw<TableRls[]>`
    SELECT c.relname,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS force,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenantId'
      )
    ORDER BY c.relname
  `;
}

async function tenantPolicies(): Promise<PolicyRow[]> {
  return prisma.client.$queryRaw<PolicyRow[]>`
    SELECT c.relname,
           p.polname,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') AS using_expr,
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS check_expr
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_policy p ON p.polrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND col.table_name = c.relname
          AND col.column_name = 'tenantId'
      )
    ORDER BY c.relname, p.polname
  `;
}

describe('RLS — invarian katalog', () => {
  it('role runtime bukan superuser/owner dan tidak bisa melewati RLS', async () => {
    const role = await prisma.client.$queryRaw<
      { role: string; superuser: boolean; bypass: boolean }[]
    >`
      SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass
      FROM pg_roles r WHERE r.rolname = current_user
    `;
    expect(role).toHaveLength(1);
    expect(role[0].superuser).toBe(false);
    expect(role[0].bypass).toBe(false);

    const owned = await prisma.client.$queryRaw<{ owned: number }[]>`
      SELECT count(*)::int AS owned
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    `;
    // Owner tabel melewati RLS kecuali FORCE; role runtime tidak boleh owner.
    expect(owned[0].owned).toBe(0);
  });

  it('semua tabel ber-tenantId: RLS ENABLE + FORCE + policy tenant', async () => {
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThanOrEqual(36);

    const withoutRls = tables.filter((t) => !t.rls).map((t) => t.relname);
    const withoutForce = tables.filter((t) => !t.force).map((t) => t.relname);
    const withoutPolicy = tables.filter((t) => t.policies === 0).map((t) => t.relname);
    expect({ withoutRls, withoutForce, withoutPolicy }).toEqual({
      withoutRls: [],
      withoutForce: [],
      withoutPolicy: [],
    });

    const policies = await tenantPolicies();
    const tablesWithTenantPolicy = new Set(
      policies
        .filter((p) => p.using_expr.includes('"tenantId"') && p.using_expr.includes('app.tenant_id'))
        .map((p) => p.relname),
    );
    expect(tables.filter((t) => !tablesWithTenantPolicy.has(t.relname)).map((t) => t.relname)).toEqual(
      [],
    );

    // Kebijakan global (tenantId NULL) hanya untuk plans & audit_logs.
    const globalBypass = policies
      .filter((p) => `${p.using_expr} ${p.check_expr}`.includes('"tenantId" IS NULL'))
      .map((p) => p.relname);
    expect([...new Set(globalBypass)].sort()).toEqual([...GLOBAL_ROW_TABLES].sort());

    // Tidak ada policy permisif buta (`true`) yang membuka seluruh baris.
    expect(policies.filter((p) => p.using_expr.trim() === 'true')).toEqual([]);

    // Setiap policy merujuk konteks GUC, bukan kolom liar.
    const withoutGuc = policies.filter(
      (p) => !`${p.using_expr} ${p.check_expr}`.includes('app.'),
    );
    expect(withoutGuc).toEqual([]);
  });

  it('tabel tenants (tanpa kolom tenantId) juga RLS ENABLE + FORCE', async () => {
    const rows = await prisma.client.$queryRaw<{ rls: boolean; force: boolean; policies: number }[]>`
      SELECT c.relrowsecurity AS rls,
             c.relforcerowsecurity AS force,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'tenants'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rls: true, force: true });
    expect(rows[0].policies).toBeGreaterThan(0);
  });
});

describe('RLS — isolasi lintas tenant lewat role runtime', () => {
  it('baca/tulis lintas tenant ditolak dan tanpa konteks fail-closed', async () => {
    const a = await registerOwner('rls-a');
    const b = await registerOwner('rls-b');
    const productA = await createProduct(a, 'Produk tenant A');
    const productB = await createProduct(b, 'Produk tenant B');

    // Baca: baris tenant lain tidak terlihat.
    const leak = await prisma.withTenant(a.tenantId, (tx) =>
      tx.product.findMany({ where: { id: { in: [productB] } } }),
    );
    expect(leak).toEqual([]);

    const own = await prisma.withTenant(a.tenantId, (tx) =>
      tx.product.findUnique({
        where: { tenantId_id: { tenantId: a.tenantId, id: productA } },
      }),
    );
    expect(own?.name).toBe('Produk tenant A');

    // Update/hapus lintas tenant: nol baris terdampak (bukan error, bukan sukses diam-diam).
    const crossUpdate = await prisma.withTenant(a.tenantId, (tx) =>
      tx.product.updateMany({ where: { id: productB }, data: { name: 'dibajak' } }),
    );
    expect(crossUpdate.count).toBe(0);
    const crossDelete = await prisma.withTenant(a.tenantId, (tx) =>
      tx.product.deleteMany({ where: { id: productB } }),
    );
    expect(crossDelete.count).toBe(0);

    // Insert dengan tenantId asing dari konteks A ditolak policy WITH CHECK.
    await expect(
      prisma.withTenant(a.tenantId, (tx) =>
        tx.product.create({
          data: { tenantId: b.tenantId, name: 'Produk lintas tenant', stockMode: 'QUANTITY' },
        }),
      ),
    ).rejects.toThrow(/row-level security|42501/i);

    // Tanpa konteks: nol baris dan tidak melempar error (regresi GUC kosong).
    const withoutContext = await prisma.client.product.count({
      where: { id: { in: [productA, productB] } },
    });
    expect(withoutContext).toBe(0);

    // tenants: hanya baris milik konteks yang terlihat.
    const visibleTenants = await prisma.withTenant(a.tenantId, (tx) => tx.tenant.findMany({}));
    expect(visibleTenants.map((row) => row.id)).toEqual([a.tenantId]);

    // Data tenant B tetap utuh.
    const bStill = await prisma.withTenant(b.tenantId, (tx) =>
      tx.product.findUnique({
        where: { tenantId_id: { tenantId: b.tenantId, id: productB } },
      }),
    );
    expect(bStill?.name).toBe('Produk tenant B');
  }, 60_000);

  it('audit_logs: baris tenant lain tak terlihat, baris global tetap terbaca', async () => {
    const a = await registerOwner('rls-audit-a');
    const b = await registerOwner('rls-audit-b');

    await prisma.withTenant(b.tenantId, (tx) =>
      tx.auditLog.create({
        data: {
          tenantId: b.tenantId,
          action: 'RLS_TEST_TENANT_B',
          domain: 'test',
          correlationId: randomUUID(),
        },
      }),
    );
    await prisma.client.auditLog.create({
      data: { action: 'RLS_TEST_GLOBAL', domain: 'test', correlationId: randomUUID() },
    });

    const leak = await prisma.withTenant(a.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { action: 'RLS_TEST_TENANT_B' } }),
    );
    expect(leak).toEqual([]);

    const global = await prisma.withTenant(a.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { action: 'RLS_TEST_GLOBAL' } }),
    );
    expect(global.length).toBeGreaterThan(0);

    const ownTenantRows = await prisma.withTenant(b.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { action: 'RLS_TEST_TENANT_B' } }),
    );
    expect(ownTenantRows).toHaveLength(1);
    expect(ownTenantRows[0].tenantId).toBe(b.tenantId);
  }, 60_000);
});

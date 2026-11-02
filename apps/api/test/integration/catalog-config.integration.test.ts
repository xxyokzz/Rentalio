/**
 * Integration test: konfigurasi presentasi katalog (Notion 06 WEB-07).
 *
 * Mencakup:
 * - status awal tenant (belum ada draf/published) + konfigurasi default
 * - allowlist blok & properti: komponen/properti tak dikenal ditolak
 * - editor hanya presentasi: properti harga/stok tidak bisa diselundupkan
 * - simulasi XSS: tag/skema berbahaya pada teks & URL ditolak
 * - simpan draf, publish, histori versi, dan rollback tanpa menimpa histori
 * - katalog publik hanya membaca versi PUBLISHED; isolasi antar tenant (API + RLS)
 * - permission: MANAGER/OWNER boleh menulis, STAFF hanya membaca; CSRF wajib
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
const PW = 'kata-sandi-catalog-config-001';
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
  return `${API}/tenants/${tenantId}/catalog-config`;
}

interface Actor {
  cookie: string;
  csrf: string;
  userId: string;
}

interface Fixture {
  owner: Actor;
  tenantId: string;
  slug: string;
}

function session(req: request.Test, fx: Actor): request.Test {
  return req.set('Cookie', fx.cookie);
}

function auth(req: request.Test, fx: Actor): request.Test {
  return session(req, fx).set('X-CSRF-Token', fx.csrf).set('Origin', ORIGIN);
}

const HERO = {
  id: 'hero-1',
  type: 'hero',
  enabled: true,
  config: { heading: 'Sewa mudah', ctaLink: '#produk', overlayOpacity: 60, textAlign: 'center' },
};
const FEATURED = {
  id: 'featured-2',
  type: 'featured',
  enabled: true,
  config: { columns: 3, cardStyle: 'glass', showPrice: true, limit: 6 },
};
const THEME = {
  primaryColor: '#2f2a24',
  accentColor: '#A85F3C',
  pageBgColor: '#f1ede4',
  fontFamily: 'Inter Variable',
  buttonStyle: 'rounded',
  cardRadius: 'md',
  glassmorphism: true,
  cardOpacity: 85,
  backdropBlur: 10,
  glassBorder: 'subtle',
};

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
  const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('rentalio_session='),
  )!;
  const user = await prisma.client.user.findUnique({
    where: { email: emailAddr.toLowerCase() },
  });
  return { cookie: cookie.split(';')[0], csrf: login.headers['x-csrf-token'] as string, userId: user!.id };
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

async function inviteStaff(owner: Actor, tenantId: string, prefix: string): Promise<Actor> {
  const staffEmail = em(prefix);
  const invite = await auth(request(server).post(`${API}/tenants/${tenantId}/members`), owner).send({
    email: staffEmail,
    role: 'STAFF',
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
  const tenantSlug = slug(prefix);
  const tenant = await auth(request(server).post(`${API}/tenants`), owner).send({
    name: `Tenant ${prefix}`,
    slug: tenantSlug,
  });
  if (tenant.status !== 201) throw new Error(JSON.stringify(tenant.body));
  return { owner, tenantId: tenant.body.data.id as string, slug: tenantSlug };
}

const CONFIG = { theme: THEME, branding: {}, blocks: [HERO, FEATURED] };

describe('Konfigurasi katalog — draf, validasi, publish, versi', () => {
  it('tenant baru belum punya draf/published dan mendapat konfigurasi default', async () => {
    const fx = await setup('ccawal');
    const res = await auth(request(server).get(base(fx.tenantId)), fx.owner);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.draft).toBeNull();
    expect(res.body.data.published).toBeNull();
    expect(res.body.data.defaults.schemaVersion).toBe(1);
    expect(res.body.data.defaults.blocks.length).toBeGreaterThan(0);
    expect(res.body.data.defaults.blocks.map((b: { type: string }) => b.type)).toContain('hero');
  });

  it('menolak blok/properti di luar allowlist dan properti non-presentasi', async () => {
    const fx = await setup('ccvalid');
    // `needle` kosong berarti request sudah ditolak ValidationPipe sebelum
    // sampai ke validator skema (mis. properti top-level tak dikenal).
    const cases: Array<{ name: string; body: Record<string, unknown>; needle: string }> = [
      {
        name: 'blok tak dikenal',
        body: { theme: THEME, blocks: [{ id: 'x', type: 'pricing_table', enabled: true, config: {} }] },
        needle: 'blocks[0].type',
      },
      {
        name: 'properti blok di luar allowlist (harga diselundupkan)',
        body: {
          theme: THEME,
          blocks: [{ id: 'x', type: 'featured', enabled: true, config: { pricePerDay: 50000 } }],
        },
        needle: 'blocks[0].config.pricePerDay',
      },
      {
        name: 'bagian di luar allowlist (ditolak di boundary DTO)',
        body: { theme: THEME, scripts: '<script>alert(1)</script>', blocks: [] },
        needle: '',
      },
      {
        name: 'properti tema di luar allowlist',
        body: { theme: { ...THEME, secretWebhook: 'https://evil.test' }, blocks: [] },
        needle: 'theme.secretWebhook',
      },
      {
        name: 'URL berskema javascript',
        body: {
          theme: THEME,
          blocks: [
            { id: 'x', type: 'hero', enabled: true, config: { heading: 'Halo', ctaLink: 'javascript:alert(1)' } },
          ],
        },
        needle: 'blocks[0].config.ctaLink',
      },
      {
        name: 'teks memuat tag',
        body: {
          theme: THEME,
          blocks: [
            { id: 'x', type: 'rich_text', enabled: true, config: { content: '<script>alert(1)</script>' } },
          ],
        },
        needle: 'blocks[0].config.content',
      },
      {
        name: 'warna bukan heksadesimal/rgba',
        body: { theme: { ...THEME, primaryColor: 'red; background: url(evil)' }, blocks: [] },
        needle: 'theme.primaryColor',
      },
      {
        name: 'nilai enum tak dikenal',
        body: {
          theme: THEME,
          blocks: [{ id: 'x', type: 'hero', enabled: true, config: { textAlign: 'diagonal' } }],
        },
        needle: 'blocks[0].config.textAlign',
      },
      {
        name: 'ID blok duplikat',
        body: {
          theme: THEME,
          blocks: [HERO, { ...FEATURED, id: 'hero-1' }],
        },
        needle: 'blocks[1].id',
      },
      {
        name: 'lebih dari 30 blok',
        body: {
          theme: THEME,
          blocks: Array.from({ length: 31 }, (_v, i) => ({
            id: `hero-${i}`,
            type: 'hero',
            enabled: true,
            config: {},
          })),
        },
        needle: 'blocks',
      },
      {
        name: 'video di luar host YouTube/Vimeo',
        body: {
          theme: THEME,
          blocks: [
            { id: 'x', type: 'video_embed', enabled: true, config: { embedUrl: 'https://evil.test/x' } },
          ],
        },
        needle: 'blocks[0].config.embedUrl',
      },
    ];

    for (const testCase of cases) {
      const save = await auth(request(server).put(base(fx.tenantId)), fx.owner).send(testCase.body);
      expect(save.status, `${testCase.name}: ${JSON.stringify(save.body)}`).toBe(400);
      expect(save.body.error.code).toBe('VALIDATION_ERROR');
      if (!testCase.needle) continue;

      const issues = save.body.error.details?.issues ?? [];
      expect(
        issues.some((issue: { path: string }) => issue.path.includes(testCase.needle)),
        `${testCase.name} → ${JSON.stringify(issues)}`,
      ).toBe(true);

      const validate = await auth(
        request(server).post(`${base(fx.tenantId)}/validate`),
        fx.owner,
      ).send(testCase.body);
      expect(validate.status).toBe(200);
      expect(validate.body.data.valid).toBe(false);
      expect(validate.body.data.issues.length).toBeGreaterThan(0);
    }

    // Tidak ada yang tersimpan dari percobaan di atas.
    const state = await auth(request(server).get(base(fx.tenantId)), fx.owner);
    expect(state.body.data.draft).toBeNull();
  });

  it('menyimpan draf ternormalisasi dan tetap DRAFT (katalog publik belum berubah)', async () => {
    const fx = await setup('ccsimpan');
    const save = await auth(request(server).put(base(fx.tenantId)), fx.owner).send({
      theme: { ...THEME, accentColor: '#A85F3C' },
      branding: { businessName: 'Sewa Kamera Jaya', whatsappNumber: '+628123456789' },
      blocks: [HERO, { ...FEATURED, config: { ...FEATURED.config, columns: 3, bgColor: '' } }],
      templateKey: 'glass-minimalis',
    });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(save.body.data.status).toBe('DRAFT');
    expect(save.body.data.version).toBe(1);
    expect(save.body.data.blockCount).toBe(2);
    expect(save.body.data.config.theme.primaryColor).toBe('#2f2a24');
    // Warna dinormalisasi ke huruf kecil, string kosong dibuang.
    expect(save.body.data.config.theme.accentColor).toBe('#a85f3c');
    expect(save.body.data.config.blocks[1].config.bgColor).toBeUndefined();
    expect(save.body.data.config.branding.businessName).toBe('Sewa Kamera Jaya');

    const state = await auth(request(server).get(base(fx.tenantId)), fx.owner);
    expect(state.body.data.draft.id).toBe(save.body.data.id);
    expect(state.body.data.draft.status).toBe('DRAFT');
    expect(state.body.data.published).toBeNull();

    // Katalog publik masih memakai konfigurasi default (draf belum tayang).
    const live = await request(server).get(`${API}/public/${fx.slug}/catalog-config`);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body.data.isPublished).toBe(false);
    expect(live.body.data.version).toBeNull();
    expect(live.body.data.config.blocks).toHaveLength(5);

    // Menyimpan ulang tanpa templateKey tidak menghapus label template.
    const resave = await auth(request(server).put(base(fx.tenantId)), fx.owner).send(CONFIG);
    expect(resave.status, JSON.stringify(resave.body)).toBe(200);
    expect(resave.body.data.templateKey).toBe('glass-minimalis');
    expect(resave.body.data.version).toBe(1);
  });

  it('publish memindahkan draf ke live, mengarsipkan versi lama, dan menyiapkan draf baru', async () => {
    const fx = await setup('ccpublish');
    await auth(request(server).put(base(fx.tenantId)), fx.owner).send(CONFIG);

    const first = await auth(request(server).post(`${base(fx.tenantId)}/publish`), fx.owner);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.published.status).toBe('PUBLISHED');
    expect(first.body.data.published.version).toBe(1);
    expect(first.body.data.published.publishedAt).toBeTruthy();
    expect(first.body.data.draft.status).toBe('DRAFT');
    expect(first.body.data.draft.version).toBe(2);
    // Draf baru melanjutkan dari isi yang baru saja tayang.
    expect(first.body.data.draft.config.blocks).toHaveLength(2);

    const live = await request(server).get(`${API}/public/${fx.slug}/catalog-config`);
    expect(live.body.data.isPublished).toBe(true);
    expect(live.body.data.version).toBe(1);
    expect(live.body.data.config.blocks[0].id).toBe('hero-1');
    expect(live.body.data.tenant.slug).toBe(fx.slug);

    // Edit draf: live TIDAK boleh ikut berubah sebelum publish.
    await auth(request(server).put(base(fx.tenantId)), fx.owner).send({
      theme: { ...THEME, primaryColor: '#000000' },
      branding: {},
      blocks: [HERO],
      templateKey: 'foto-kreatif',
    });
    const liveAfterEdit = await request(server).get(`${API}/public/${fx.slug}/catalog-config`);
    expect(liveAfterEdit.body.data.version).toBe(1);
    expect(liveAfterEdit.body.data.config.theme.primaryColor).toBe('#2f2a24');
    expect(liveAfterEdit.body.data.config.blocks).toHaveLength(2);

    const second = await auth(request(server).post(`${base(fx.tenantId)}/publish`), fx.owner);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.data.published.version).toBe(2);
    expect(second.body.data.published.config.blocks).toHaveLength(1);

    const liveAfterPublish = await request(server).get(`${API}/public/${fx.slug}/catalog-config`);
    expect(liveAfterPublish.body.data.version).toBe(2);
    expect(liveAfterPublish.body.data.config.theme.primaryColor).toBe('#000000');
    expect(liveAfterPublish.body.data.templateKey).toBe('foto-kreatif');

    const versions = await auth(request(server).get(`${base(fx.tenantId)}/versions`), fx.owner);
    expect(versions.status).toBe(200);
    const statuses = versions.body.data.map(
      (row: { version: number; status: string }) => `${row.version}:${row.status}`,
    );
    expect(statuses).toContain('2:PUBLISHED');
    expect(statuses).toContain('1:ARCHIVED');
    expect(statuses).toContain('3:DRAFT');
    // Daftar versi tidak memuat snapshot penuh (payload ringan).
    expect(versions.body.data[0].config).toBeUndefined();
  });

  it('rollback menyalin snapshot lama ke draf dan baru tayang setelah publish', async () => {
    const fx = await setup('ccrollback');
    await auth(request(server).put(base(fx.tenantId)), fx.owner).send(CONFIG);
    await auth(request(server).post(`${base(fx.tenantId)}/publish`), fx.owner);
    await auth(request(server).put(base(fx.tenantId)), fx.owner).send({
      theme: { ...THEME, primaryColor: '#101010' },
      branding: {},
      blocks: [HERO],
      templateKey: 'klasik-hangat',
    });
    const published = await auth(request(server).post(`${base(fx.tenantId)}/publish`), fx.owner);
    const versionOne = (
      await auth(request(server).get(`${base(fx.tenantId)}/versions`), fx.owner)
    ).body.data.find((row: { version: number }) => row.version === 1);

    const restored = await auth(
      request(server).post(`${base(fx.tenantId)}/versions/${versionOne.id}/restore`),
      fx.owner,
    );
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.data.status).toBe('DRAFT');
    expect(restored.body.data.config.blocks).toHaveLength(2);
    expect(restored.body.data.config.theme.primaryColor).toBe('#2f2a24');
    expect(restored.body.data.templateKey).toBe('klasik-hangat');

    // Live masih versi publish terakhir sampai publish dijalankan lagi.
    const live = await request(server).get(`${API}/public/${fx.slug}/catalog-config`);
    expect(live.body.data.version).toBe(published.body.data.published.version);
    expect(live.body.data.config.blocks).toHaveLength(1);

    const detail = await auth(
      request(server).get(`${base(fx.tenantId)}/versions/${versionOne.id}`),
      fx.owner,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.config.blocks).toHaveLength(2);

    const republished = await auth(request(server).post(`${base(fx.tenantId)}/publish`), fx.owner);
    expect(republished.status).toBe(200);
    const liveAfter = await request(server).get(`${API}/public/${fx.slug}/catalog-config`);
    expect(liveAfter.body.data.config.blocks).toHaveLength(2);
    expect(liveAfter.body.data.config.theme.primaryColor).toBe('#2f2a24');
  });

  it('setiap template bawaan lolos skema dan dapat diterapkan tanpa menimpa branding tenant', async () => {
    const fx = await setup('cctemplate');
    await auth(request(server).put(base(fx.tenantId)), fx.owner).send({
      theme: THEME,
      branding: { businessName: 'Toko Saya', whatsappNumber: '+628111222333' },
      blocks: [HERO],
    });

    const gallery = await auth(request(server).get(`${base(fx.tenantId)}/templates`), fx.owner);
    expect(gallery.status).toBe(200);
    const templates = gallery.body.data.templates as Array<{ key: string; blockCount: number }>;
    expect(templates.length).toBeGreaterThanOrEqual(6);
    const blockTypes = new Set(
      (gallery.body.data.blocks as Array<{ type: string }>).map((block) => block.type),
    );
    expect(blockTypes.size).toBeGreaterThanOrEqual(14);

    for (const template of templates) {
      const applied = await auth(
        request(server).post(`${base(fx.tenantId)}/templates/${template.key}/apply`),
        fx.owner,
      );
      expect(applied.status, `${template.key}: ${JSON.stringify(applied.body)}`).toBe(200);
      expect(applied.body.data.templateKey).toBe(template.key);
      expect(applied.body.data.blockCount).toBe(template.blockCount);
      expect(applied.body.data.config.branding.businessName).toBe('Toko Saya');
      const types = (applied.body.data.config.blocks as Array<{ type: string }>).map((b) => b.type);
      expect(types.every((type) => blockTypes.has(type)), `${template.key}: ${types.join(',')}`).toBe(
        true,
      );

      // Hasil template harus bisa disimpan apa adanya.
      const roundTrip = await auth(request(server).put(base(fx.tenantId)), fx.owner).send({
        theme: applied.body.data.config.theme,
        branding: applied.body.data.config.branding,
        blocks: applied.body.data.config.blocks,
        templateKey: template.key,
      });
      expect(roundTrip.status, `${template.key}: ${JSON.stringify(roundTrip.body)}`).toBe(200);
    }

    const unknown = await auth(
      request(server).post(`${base(fx.tenantId)}/templates/tidak-ada/apply`),
      fx.owner,
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
  });

  it('menjaga permission, CSRF, dan isolasi antar tenant (API + RLS)', async () => {
    const a = await setup('ccisoa');
    const b = await setup('ccisob');
    await auth(request(server).put(base(a.tenantId)), a.owner).send(CONFIG);
    await auth(request(server).post(`${base(a.tenantId)}/publish`), a.owner);

    const readOther = await auth(request(server).get(base(a.tenantId)), b.owner);
    expect(readOther.status).toBe(403);
    const writeOther = await auth(request(server).put(base(a.tenantId)), b.owner).send(CONFIG);
    expect(writeOther.status).toBe(403);

    const rowsB = await prisma.withTenant(b.tenantId, (tx) =>
      tx.catalogConfigVersion.findMany({ where: { tenantId: a.tenantId } }),
    );
    expect(rowsB).toHaveLength(0);

    // CSRF wajib untuk mutasi berbasis cookie.
    const noCsrf = await session(request(server).put(base(a.tenantId)), a.owner)
      .set('Origin', ORIGIN)
      .send(CONFIG);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_VALIDATION_FAILED');

    // Portal publik: katalog tenant B belum publish → default, bukan data A.
    const liveB = await request(server).get(`${API}/public/${b.slug}/catalog-config`);
    expect(liveB.status).toBe(200);
    expect(liveB.body.data.isPublished).toBe(false);
    const liveA = await request(server).get(`${API}/public/${a.slug}/catalog-config`);
    expect(liveA.body.data.isPublished).toBe(true);
    expect(liveA.body.data.config.theme.primaryColor).toBe('#2f2a24');

    const missing = await request(server).get(`${API}/public/tidak-ada-tenant/catalog-config`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('restricted mode: baca tetap terbuka, mutasi konfigurasi ditolak 403', async () => {
    const fx = await setup('ccrestricted');
    await auth(request(server).put(base(fx.tenantId)), fx.owner).send(CONFIG);
    const versionId = (
      await auth(request(server).get(`${base(fx.tenantId)}/versions`), fx.owner)
    ).body.data[0].id as string;

    // Kebijakan subscription (dokumen 10 & 04): trial berakhir → restricted,
    // lalu seluruh perubahan katalog diblokir.
    const expired = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.withTenant(fx.tenantId, async (tx) => {
      await tx.tenant.update({
        where: { id: fx.tenantId },
        data: { activatedAt: expired, trialEndsAt: expired },
      });
      await tx.subscription.updateMany({
        where: { tenantId: fx.tenantId },
        data: { trialEndsAt: expired, status: 'TRIALING' },
      });
    });

    const read = await auth(request(server).get(base(fx.tenantId)), fx.owner);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.draft).not.toBeNull();

    const save = await auth(request(server).put(base(fx.tenantId)), fx.owner).send(CONFIG);
    expect(save.status, JSON.stringify(save.body)).toBe(403);
    expect(save.body.error.code).toBe('TENANT_RESTRICTED');

    const publish = await auth(request(server).post(`${base(fx.tenantId)}/publish`), fx.owner);
    expect(publish.status).toBe(403);
    expect(publish.body.error.code).toBe('TENANT_RESTRICTED');

    const apply = await auth(
      request(server).post(`${base(fx.tenantId)}/templates/glass-minimalis/apply`),
      fx.owner,
    );
    expect(apply.status).toBe(403);
    expect(apply.body.error.code).toBe('TENANT_RESTRICTED');

    const restore = await auth(
      request(server).post(`${base(fx.tenantId)}/versions/${versionId}/restore`),
      fx.owner,
    );
    expect(restore.status).toBe(403);

    // Katalog publik tetap membaca versi live apa adanya (baca tetap jalan).
    const live = await request(server).get(`${API}/public/${fx.slug}/catalog-config`);
    expect(live.status).toBe(200);
  });

  it('STAFF hanya boleh membaca; menyimpan/menerbitkan ditolak 403', async () => {
    const fx = await setup('ccperm');
    const staff = await inviteStaff(fx.owner, fx.tenantId, 'ccperm-staff');

    const read = await auth(request(server).get(base(fx.tenantId)), staff);
    expect(read.status, JSON.stringify(read.body)).toBe(200);

    const save = await auth(request(server).put(base(fx.tenantId)), staff).send(CONFIG);
    expect(save.status).toBe(403);
    expect(save.body.error.code).toBe('PERMISSION_DENIED');

    const publish = await auth(request(server).post(`${base(fx.tenantId)}/publish`), staff);
    expect(publish.status).toBe(403);

    const templates = await auth(request(server).get(`${base(fx.tenantId)}/templates`), staff);
    expect(templates.status).toBe(200);
    const apply = await auth(
      request(server).post(`${base(fx.tenantId)}/templates/klasik-hangat/apply`),
      staff,
    );
    expect(apply.status).toBe(403);
  });
});

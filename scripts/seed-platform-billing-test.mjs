#!/usr/bin/env node
/**
 * Seed data uji untuk alur settle tagihan langganan (Admin Platform).
 *
 * Membuat satu set data tetap (id deterministik) sehingga aman dijalankan
 * berulang kali:
 *   - tenant   `tenant-uji-settle` (ACTIVE)
 *   - plan     platform-wide (`tenantId = NULL`) bila belum ada
 *   - subscription TRIALING milik tenant tersebut
 *   - satu tagihan QRIS `PENDING` (unik per tenant: index one_pending)
 *
 * Semua penulisan memakai `set_config('app.tenant_id', ...)` karena tabel
 * tenants/subscriptions/subscription_invoices memakai RLS FORCE; tanpa konteks
 * tenant, INSERT ditolak policy.
 *
 * Kredensial DB dibaca dari `database/.env.supabase` (DIRECT_URL, role
 * migrator) — file itu gitignored dan tidak pernah dicetak.
 *
 * Pemakaian:
 *   node scripts/seed-platform-billing-test.mjs [--keep-paid]
 *
 *   --keep-paid  jangan reset tagihan yang sudah PAID (default: reset ke
 *                PENDING supaya skenario settle bisa diulang).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const SUBSCRIPTION_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_SLUG = 'tenant-uji-settle';
const PLAN_CODE = 'PLATFORM-TEST';
const EXTERNAL_ID = 'platform-test-qris-0001';
const INVOICE_TTL_HOURS = 24;

const keepPaid = process.argv.includes('--keep-paid');

/** Baca satu nilai dari file .env tanpa mencetak isi file. */
function envValue(path, key) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${key}=`)) continue;
    return line
      .slice(key.length + 1)
      .trim()
      .replace(/^"|"$/g, '');
  }
  return undefined;
}

const directUrl = envValue(resolve(repoRoot, 'database/.env.supabase'), 'DIRECT_URL');
if (!directUrl) {
  console.error('DIRECT_URL tidak ditemukan di database/.env.supabase');
  process.exit(1);
}

const rootEnv = resolve(repoRoot, '.env');
const priceText = envValue(rootEnv, 'SUBSCRIPTION_PRICE_AMOUNT');
const configuredPrice = Number(priceText);
const amount = Number.isInteger(configuredPrice) && configuredPrice > 0 ? configuredPrice : 149000;

/**
 * Payload QRIS dinamis nyata memakai logika produksi (`convertQRIS`) dari
 * build yang sudah ada. Bila build belum tersedia, kolom qrPayload dibiarkan
 * kosong: nilainya informatif, bukan syarat settle.
 */
function buildQrPayload() {
  const staticPayload = envValue(rootEnv, 'PLATFORM_QRIS_STATIC_PAYLOAD');
  if (!staticPayload) return { payload: null, note: 'PLATFORM_QRIS_STATIC_PAYLOAD kosong' };
  try {
    const mod = require(resolve(repoRoot, 'apps/api/dist/billing/qris/index.js'));
    const validation = mod.validateQRIS(staticPayload);
    if (!validation.valid) return { payload: null, note: `QRIS statis tidak valid: ${validation.errors.join('; ')}` };
    return { payload: mod.convertQRIS(staticPayload, { amount }), note: 'dinamis dari PLATFORM_QRIS_STATIC_PAYLOAD' };
  } catch (error) {
    return { payload: null, note: `modul QRIS build tidak terbaca: ${error.message}` };
  }
}

const pool = new pg.Pool({
  connectionString: `${directUrl}&sslmode=disable`,
  ssl: { rejectUnauthorized: false },
});

function fail(error) {
  console.error('GAGAL:', error.code ?? '', error.message);
  process.exit(1);
}

const client = await pool.connect().catch(fail);
try {
  await client.query('BEGIN');
  // Konteks tenant untuk lolos WITH CHECK policy RLS.
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_ID]);

  const now = new Date();
  await client.query(
    `INSERT INTO tenants (id, slug, name, status, timezone, currency, "activatedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'ACTIVE', 'Asia/Jakarta', 'IDR', $4, $4, $4)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           status = 'ACTIVE',
           "activatedAt" = COALESCE(tenants."activatedAt", EXCLUDED."activatedAt"),
           "updatedAt" = EXCLUDED."updatedAt"`,
    [TENANT_ID, TENANT_SLUG, 'Tenant Uji Settle', now],
  );

  const existingPlan = await client.query(
    `SELECT id FROM plans WHERE "tenantId" IS NULL AND code = $1 ORDER BY "createdAt" ASC LIMIT 1`,
    [PLAN_CODE],
  );
  let planId = existingPlan.rows[0]?.id;
  if (!planId) {
    await client.query(
      `INSERT INTO plans (id, "tenantId", code, name, "priceAmount", currency, "isActive", "createdAt", "updatedAt")
       VALUES ($1, NULL, $2, $3, $4, 'IDR', true, $5, $5)
       ON CONFLICT (id) DO NOTHING`,
      [PLAN_ID, PLAN_CODE, 'Paket Uji Platform', amount, now],
    );
    planId = PLAN_ID;
  }

  await client.query(
    `INSERT INTO subscriptions (id, "tenantId", "planId", status, "activatedAt", "trialEndsAt",
                                "periodStart", "periodEnd", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'TRIALING', $4, $5, $4, $5, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [
      SUBSCRIPTION_ID,
      TENANT_ID,
      planId,
      now,
      new Date(now.getTime() + 72 * 60 * 60 * 1000),
    ],
  );

  const qr = buildQrPayload();
  const expiresAt = new Date(now.getTime() + INVOICE_TTL_HOURS * 60 * 60 * 1000);

  const invoice = await client.query(
    `INSERT INTO subscription_invoices
       (id, "tenantId", provider, "externalId", status, amount, currency, "qrPayload", "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, $2, 'qris', $3, 'PENDING', $4, 'IDR', $5, $6, $7, $7)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, status`,
    [INVOICE_ID, TENANT_ID, EXTERNAL_ID, amount, qr.payload, expiresAt, now],
  );

  if (invoice.rowCount === 0 && !keepPaid) {
    // Jalankan ulang: buka kembali tagihan yang sudah diselesaikan agar
    // skenario settle bisa diuji lagi. Efek samping lama (periodEnd,
    // subscription_events, audit) sengaja TIDAK dihapus — riwayat tetap utuh.
    const reopened = await client.query(
      `UPDATE subscription_invoices
          SET status = 'PENDING', "paidAt" = NULL, "paidAmount" = NULL,
              "paymentMethod" = NULL, "paymentChannel" = NULL,
              "expiresAt" = $2, "updatedAt" = $3
        WHERE id = $1 AND status <> 'PENDING'`,
      [INVOICE_ID, expiresAt, now],
    );
    if (reopened.rowCount > 0) {
      console.log('tagihan uji dibuka kembali ke PENDING (efek settle sebelumnya tetap di audit)');
    }
  }

  // Diverifikasi di dalam transaksi: konteks tenant bersifat transaction-scoped,
  // jadi pembacaan setelah COMMIT akan tertutup RLS.
  const state = await client.query(
    `SELECT i.id, i.status, i.amount::text AS amount, i."externalId",
            i."qrPayload" IS NOT NULL AS punya_qr,
            s.status AS subscription_status,
            t.slug
       FROM subscription_invoices i
       JOIN subscriptions s ON s."tenantId" = i."tenantId"
       JOIN tenants t ON t.id = i."tenantId"
      WHERE i.id = $1`,
    [INVOICE_ID],
  );
  if (state.rowCount === 0) throw new Error('data seed tidak terbaca di dalam transaksi (RLS/tenant context)');
  await client.query('COMMIT');

  console.log('seed selesai:', JSON.stringify(state.rows[0]));
  console.log('qrPayload:', qr.payload ? `diisi (${qr.note})` : `kosong (${qr.note})`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  fail(error);
} finally {
  client.release();
  await pool.end();
}

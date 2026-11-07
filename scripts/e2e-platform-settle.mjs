#!/usr/bin/env node
/**
 * Uji end-to-end Admin Platform: login → MFA → re-auth → CSRF → settle tagihan → logout.
 *
 * Cakupan:
 *   1. `POST /auth/login` menerbitkan challenge MFA (atau enrollment).
 *   2. `POST /auth/mfa` menerbitkan sesi (cookie HttpOnly) + CSRF token.
 *   3. `GET /session` mengembalikan permission efektif.
 *   4. `GET /csrf` merotasi token CSRF sesi.
 *   5. Re-auth: sesi yang sudah "tua" ditolak `REAUTHENTICATION_REQUIRED` pada
 *      settle, lalu `POST /auth/reauth` (password + TOTP) memulihkannya.
 *   6. Negatif: settle tanpa Origin / Origin asing / tanpa header CSRF → 403
 *      `CSRF_VALIDATION_FAILED`; id bukan UUID → 400; tenant atau tagihan tidak
 *      ada → 404; nominal di bawah tagihan → 400.
 *   7. Positif: settle menandai tagihan PAID; settle ulang ditolak 409.
 *   8. Admin tanpa permission `platform.subscriptions.settle` (role
 *      PLATFORM_SUPPORT) ditolak 403 `PERMISSION_DENIED`.
 *   9. `DELETE /session` mencabut sesi; sesudahnya `GET /session` → 401.
 *
 * Admin pendukung untuk uji permission dibuat sementara lalu dihapus lagi.
 * Bila admin utama belum enrollment MFA, skrip melakukan enrollment memakai
 * secret yang dibuatnya sendiri lalu meresetnya di akhir (kecuali
 * `--keep-enrollment`) supaya pemilik proyek tetap bisa mendaftarkan
 * authenticator sendiri. Secret TOTP dan recovery code tidak pernah dicetak.
 *
 * Pemakaian:
 *   PLATFORM_ADMIN_TEST_PASSWORD='...' node scripts/e2e-platform-settle.mjs \
 *     [--base http://localhost:3000] [--tenant <uuid>] [--invoice <uuid>]
 */
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function envValue(path, key) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim().replace(/^"|"$/g, '');
    }
  } catch {
    /* file opsional */
  }
  return undefined;
}

const BASE = arg('base', process.env.PLATFORM_TEST_BASE_URL ?? 'http://localhost:3000');
const ADMIN_ORIGIN = process.env.PLATFORM_ADMIN_TEST_ORIGIN ?? 'http://localhost:3002';
const EMAIL = process.env.PLATFORM_ADMIN_TEST_EMAIL ?? 'platform.admin.test@rentalio.id';
const PASSWORD = process.env.PLATFORM_ADMIN_TEST_PASSWORD;
const SUPPORT_EMAIL = 'platform.support.test@rentalio.id';
const TENANT_ID = arg('tenant', '11111111-1111-4111-8111-111111111111');
const INVOICE_ID = arg('invoice', '44444444-4444-4444-8444-444444444444');
const MISSING_TENANT_ID = '88888888-8888-4888-8888-888888888888';
const MISSING_INVOICE_ID = '99999999-9999-4999-8999-999999999999';
const keepEnrollment = process.argv.includes('--keep-enrollment');
const SETTLE_PERMISSION = 'platform.subscriptions.settle';

const directUrl = envValue(resolve(repoRoot, 'database/.env.supabase'), 'DIRECT_URL');
const encryptionKeyB64 = envValue(resolve(repoRoot, '.env'), 'PLATFORM_ADMIN_ENCRYPTION_KEY');
const API = `${BASE}/api/v1/platform-admin`;

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}

if (!PASSWORD) {
  console.error('PLATFORM_ADMIN_TEST_PASSWORD wajib diisi.');
  process.exit(1);
}

/* ---------- TOTP ---------- */
function base32Decode(input) {
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error('secret TOTP bukan base32');
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function totp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1e6).padStart(6, '0');
}

/** Format `v1.<iv>.<tag>.<ciphertext>` (base64url), sama dengan encryptSecret(). */
function encryptSecret(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

/** Tunggu jendela TOTP berikutnya: kode hanya sah untuk langkah yang belum dipakai. */
async function waitNextTotpStep() {
  const period = 30_000;
  const wait = period - (Date.now() % period) + 1_200;
  await new Promise((resolve) => setTimeout(resolve, wait));
  return Math.floor(Date.now() / period);
}

/* ---------- HTTP ---------- */
function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  const session = raw.find((value) => value.startsWith('rentalio_platform_admin='));
  return session ? session.split(';')[0] : null;
}

async function call(path, { method = 'GET', body, cookie, csrf, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-platform-admin-csrf'] = csrf;
  if (origin) headers.origin = origin;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload, cookie: cookieFrom(response) };
}

/* ---------- DB ---------- */
let pool;
async function db() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: `${directUrl}&sslmode=disable`, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

/** Login dua tahap; `secretOverride` dipakai akun yang sudah enrollment. */
async function signIn(email, password, secretOverride) {
  const login = await call('/auth/login', { method: 'POST', body: { email, password } });
  if (login.status !== 200 || !login.payload?.challenge) {
    return { ok: false, detail: `HTTP ${login.status} ${login.payload?.error?.code ?? ''}`, payload: login.payload };
  }
  const status = login.payload.status;
  let secret = secretOverride;
  if (status === 'MFA_ENROLLMENT_REQUIRED') {
    const uri = login.payload.challenge.provisioningUri;
    if (!uri) return { ok: false, detail: 'provisioningUri tidak ada' };
    secret = new URL(uri).searchParams.get('secret');
  }
  if (!secret) return { ok: false, detail: `status ${status} butuh secret TOTP milik authenticator` };
  const mfa = await call('/auth/mfa', {
    method: 'POST',
    body: { challengeToken: login.payload.challenge.challengeToken, code: totp(secret, Math.floor(Date.now() / 30_000)) },
  });
  return {
    ok: mfa.status === 200 && Boolean(mfa.cookie),
    detail: `HTTP ${mfa.status} ${mfa.payload?.error?.code ?? ''}`,
    cookie: mfa.cookie,
    csrf: mfa.payload?.csrfToken,
    status,
    secret,
    recoveryCodes: mfa.payload?.recoveryCodes?.length ?? 0,
  };
}

/* ---------- Skenario ---------- */
async function main() {
  const health = await fetch(`${BASE}/api/v1/health`);
  record('health API', health.status === 200, `HTTP ${health.status}`);
  if (health.status !== 200) return;

  // --- login + MFA (enrollment bila perlu)
  const login = await call('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  record('login password', login.status === 200 && Boolean(login.payload?.challenge), `HTTP ${login.status} ${login.payload?.status ?? login.payload?.error?.code}`);
  if (login.status !== 200 || !login.payload?.challenge) return;
  const loginStatus = login.payload.status;
  const enrolledNow = loginStatus === 'MFA_ENROLLMENT_REQUIRED';
  let secret = null;
  if (enrolledNow) secret = new URL(login.payload.challenge.provisioningUri).searchParams.get('secret');
  if (!secret) {
    record('MFA', false, `status ${loginStatus}: jalankan ulang skrip saat admin belum enrollment`);
    return;
  }
  const mfa = await call('/auth/mfa', {
    method: 'POST',
    body: { challengeToken: login.payload.challenge.challengeToken, code: totp(secret, Math.floor(Date.now() / 30_000)) },
  });
  let cookie = mfa.cookie;
  record('MFA + sesi', mfa.status === 200 && Boolean(cookie), `HTTP ${mfa.status}, recovery codes: ${mfa.payload?.recoveryCodes?.length ?? 0}`);
  if (!cookie) return;

  // --- principal
  const session = await call('/session', { cookie });
  const permissions = session.payload?.data?.permissions ?? [];
  const sessionId = session.payload?.data?.sessionId;
  record(
    'sesi & permission settle',
    session.status === 200 && permissions.includes(SETTLE_PERMISSION) && Boolean(sessionId),
    `${permissions.length} permission, roles: ${(session.payload?.data?.roles ?? []).join(',')}`,
  );

  // --- CSRF
  const csrfResponse = await call('/csrf', { cookie });
  const csrf = csrfResponse.payload?.csrfToken;
  record('rotasi token CSRF', csrfResponse.status === 200 && Boolean(csrf), `HTTP ${csrfResponse.status}`);
  if (!csrf) return;

  const settlePath = `/tenants/${TENANT_ID}/subscription-invoices/${INVOICE_ID}/settle`;
  const reason = 'Uji e2e settle QRIS: dana terverifikasi di mutasi bank (TEST)';
  const settleBody = { reason };
  const settle = (overrides = {}) =>
    call(settlePath, { method: 'POST', body: settleBody, cookie, csrf, origin: ADMIN_ORIGIN, ...overrides });

  // --- re-auth: bukan hanya endpoint, tapi benar-benar menggerbangi settle
  const noCsrfReauth = await call('/auth/reauth', {
    method: 'POST',
    body: { password: PASSWORD, code: '000000' },
    cookie,
    origin: ADMIN_ORIGIN,
  });
  record(
    'tolak reauth tanpa token CSRF',
    noCsrfReauth.status === 403 && noCsrfReauth.payload?.error?.code === 'CSRF_VALIDATION_FAILED',
    `HTTP ${noCsrfReauth.status} ${noCsrfReauth.payload?.error?.code}`,
  );

  if (sessionId) {
    const client = await (await db()).connect();
    try {
      await client.query(
        `UPDATE platform_admin_sessions SET "reauthenticatedAt" = NOW() - INTERVAL '11 minutes' WHERE id = $1`,
        [sessionId],
      );
    } finally {
      client.release();
    }
  }
  const staleSettle = await settle();
  record(
    'tolak settle saat re-auth kedaluwarsa',
    staleSettle.status === 403 && staleSettle.payload?.error?.code === 'REAUTHENTICATION_REQUIRED',
    `HTTP ${staleSettle.status} ${staleSettle.payload?.error?.code}`,
  );

  const nextStep = await waitNextTotpStep();
  const reauth = await call('/auth/reauth', {
    method: 'POST',
    body: { password: PASSWORD, code: totp(secret, nextStep) },
    cookie,
    csrf,
    origin: ADMIN_ORIGIN,
  });
  record(
    'reauth password + TOTP',
    reauth.status === 200 && Boolean(reauth.payload?.data?.reauthenticatedAt),
    `HTTP ${reauth.status} ${reauth.payload?.error?.code ?? reauth.payload?.data?.reauthenticatedAt ?? ''}`,
  );

  const noOrigin = await settle({ origin: undefined });
  record(
    'tolak settle tanpa Origin',
    noOrigin.status === 403 && noOrigin.payload?.error?.code === 'CSRF_VALIDATION_FAILED',
    `HTTP ${noOrigin.status} ${noOrigin.payload?.error?.code}`,
  );
  const wrongOrigin = await settle({ origin: 'http://evil.example.com' });
  record(
    'tolak settle dengan Origin asing',
    wrongOrigin.status === 403 && wrongOrigin.payload?.error?.code === 'CSRF_VALIDATION_FAILED',
    `HTTP ${wrongOrigin.status} ${wrongOrigin.payload?.error?.code}`,
  );
  const noCsrf = await settle({ csrf: undefined });
  record(
    'tolak settle tanpa token CSRF',
    noCsrf.status === 403 && noCsrf.payload?.error?.code === 'CSRF_VALIDATION_FAILED',
    `HTTP ${noCsrf.status} ${noCsrf.payload?.error?.code}`,
  );

  // --- skenario gagal
  const invalidId = await call('/tenants/bukan-uuid/subscription-invoices/' + INVOICE_ID + '/settle', {
    method: 'POST',
    body: settleBody,
    cookie,
    csrf,
    origin: ADMIN_ORIGIN,
  });
  record(
    'tolak id bukan UUID',
    invalidId.status === 400 && invalidId.payload?.error?.code === 'VALIDATION_ERROR',
    `HTTP ${invalidId.status} ${invalidId.payload?.error?.code}`,
  );

  const missingTenant = await call(`/tenants/${MISSING_TENANT_ID}/subscription-invoices/${INVOICE_ID}/settle`, {
    method: 'POST',
    body: settleBody,
    cookie,
    csrf,
    origin: ADMIN_ORIGIN,
  });
  record(
    'tolak tenant tidak ditemukan',
    missingTenant.status === 404 && missingTenant.payload?.error?.code === 'NOT_FOUND',
    `HTTP ${missingTenant.status} ${missingTenant.payload?.error?.code}`,
  );

  const missingInvoice = await call(`/tenants/${TENANT_ID}/subscription-invoices/${MISSING_INVOICE_ID}/settle`, {
    method: 'POST',
    body: settleBody,
    cookie,
    csrf,
    origin: ADMIN_ORIGIN,
  });
  record(
    'tolak tagihan tidak ditemukan',
    missingInvoice.status === 404 && missingInvoice.payload?.error?.code === 'NOT_FOUND',
    `HTTP ${missingInvoice.status} ${missingInvoice.payload?.error?.code}`,
  );

  const underpaid = await settle({ body: { paidAmount: 1000, reason } });
  record(
    'tolak nominal di bawah tagihan',
    underpaid.status === 400 && underpaid.payload?.error?.code === 'VALIDATION_ERROR',
    `HTTP ${underpaid.status} ${underpaid.payload?.error?.code}`,
  );

  // --- settle sah
  const paid = await settle();
  record(
    'settle tagihan QRIS',
    paid.status === 200 && paid.payload?.data?.status === 'PAID',
    `HTTP ${paid.status} status=${paid.payload?.data?.status ?? paid.payload?.error?.code} paidAmount=${paid.payload?.data?.paidAmount}`,
  );

  const again = await settle();
  record(
    'tolak settle ganda',
    again.status === 409 && again.payload?.error?.code === 'INVALID_STATE_TRANSITION',
    `HTTP ${again.status} ${again.payload?.error?.code}`,
  );

  // --- admin tanpa permission settle
  await testPermissionDenied();

  // --- logout
  const logout = await call('/session', { method: 'DELETE', cookie, csrf, origin: ADMIN_ORIGIN });
  const afterLogout = await call('/session', { cookie });
  record(
    'logout mencabut sesi',
    logout.status < 300 && afterLogout.status === 401,
    `logout HTTP ${logout.status}, sesudahnya HTTP ${afterLogout.status}`,
  );

  cookie = null;
  if (enrolledNow && !keepEnrollment) await resetEnrollment();
}

/**
 * Admin sementara dengan role PLATFORM_SUPPORT (8 permission, tanpa
 * `platform.subscriptions.settle`) harus ditolak 403 PERMISSION_DENIED.
 * Akun dihapus lagi di akhir agar tidak tertinggal di database.
 */
async function testPermissionDenied() {
  if (!directUrl || !encryptionKeyB64) {
    record('tolak admin tanpa permission settle', false, 'kredensial DB/kunci enkripsi tidak tersedia');
    return;
  }
  const key = Buffer.from(encryptionKeyB64, 'base64');
  const adminId = randomUUID();
  const supportSecret = base32Encode(randomBytes(20));
  const client = await (await db()).connect();
  try {
    const passwordHash = (
      await client.query('SELECT "passwordHash" FROM platform_admin_users WHERE email = $1', [EMAIL])
    ).rows[0]?.passwordHash;
    if (!passwordHash) {
      record('tolak admin tanpa permission settle', false, 'password hash admin uji tidak ditemukan');
      return;
    }
    await client.query('DELETE FROM platform_admin_users WHERE email = $1', [SUPPORT_EMAIL]);
    await client.query(
      `INSERT INTO platform_admin_users (id, email, "passwordHash", status, "totpSecretEncrypted", "mfaEnrolledAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'ACTIVE', $4, NOW(), NOW(), NOW())`,
      [adminId, SUPPORT_EMAIL, passwordHash, encryptSecret(key, supportSecret)],
    );
    const role = await client.query(
      `INSERT INTO platform_admin_roles (id, "adminUserId", "roleId", "assignedAt")
       SELECT gen_random_uuid(), $1, id, NOW() FROM platform_roles WHERE code = 'PLATFORM_SUPPORT'
       RETURNING id`,
      [adminId],
    );
    if (role.rowCount === 0) {
      record('tolak admin tanpa permission settle', false, 'role PLATFORM_SUPPORT tidak ada');
      return;
    }

    const support = await signIn(SUPPORT_EMAIL, PASSWORD, supportSecret);
    if (!support.ok) {
      record('tolak admin tanpa permission settle', false, `login admin support gagal: ${support.detail}`);
      return;
    }
    const supportSession = await call('/session', { cookie: support.cookie });
    const perms = supportSession.payload?.data?.permissions ?? [];
    const attempt = await call(`/tenants/${TENANT_ID}/subscription-invoices/${INVOICE_ID}/settle`, {
      method: 'POST',
      body: { reason: 'Uji permission: admin support tanpa izin settle (TEST)' },
      cookie: support.cookie,
      origin: ADMIN_ORIGIN,
    });
    record(
      'tolak admin tanpa permission settle',
      attempt.status === 403 &&
        attempt.payload?.error?.code === 'PERMISSION_DENIED' &&
        !perms.includes(SETTLE_PERMISSION),
      `roles: ${(supportSession.payload?.data?.roles ?? []).join(',')}, HTTP ${attempt.status} ${attempt.payload?.error?.code}`,
    );
  } finally {
    await client.query('DELETE FROM platform_admin_sessions WHERE "adminUserId" = $1', [adminId]).catch(() => {});
    await client.query('DELETE FROM platform_admin_recovery_codes WHERE "adminUserId" = $1', [adminId]).catch(() => {});
    await client.query('DELETE FROM platform_admin_roles WHERE "adminUserId" = $1', [adminId]).catch(() => {});
    await client.query('DELETE FROM platform_admin_users WHERE id = $1', [adminId]).catch(() => {});
    client.release();
  }
}

/** Kembalikan admin uji ke status "belum enrollment" agar pemilik bisa daftar sendiri. */
async function resetEnrollment() {
  if (!directUrl) {
    console.log('reset enrollment dilewati: database/.env.supabase tidak terbaca');
    return;
  }
  const client = await (await db()).connect();
  try {
    await client.query('BEGIN');
    const id = (await client.query('SELECT id FROM platform_admin_users WHERE email = $1', [EMAIL])).rows[0]?.id;
    if (id) {
      await client.query('DELETE FROM platform_admin_recovery_codes WHERE "adminUserId" = $1', [id]);
      await client.query('DELETE FROM platform_admin_sessions WHERE "adminUserId" = $1', [id]);
      await client.query('DELETE FROM platform_admin_login_challenges WHERE "adminUserId" = $1', [id]);
      await client.query(
        `UPDATE platform_admin_users SET "totpSecretEncrypted" = NULL, "mfaEnrolledAt" = NULL, "lastTotpStep" = NULL WHERE id = $1`,
        [id],
      );
    }
    await client.query('COMMIT');
    console.log('enrollment MFA admin uji direset (audit event tetap tersimpan)');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.log(`reset enrollment gagal: ${error.message}`);
  } finally {
    client.release();
  }
}

try {
  await main();
} finally {
  if (pool) await pool.end().catch(() => {});
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} langkah lulus`);
if (failed.length > 0) process.exitCode = 1;

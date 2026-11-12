#!/usr/bin/env node
/**
 * Seed satu akun Admin Platform yang **sudah ter-enroll TOTP** — khusus
 * staging/preview, supaya login admin bisa diuji lewat UI tanpa alur enrollment.
 *
 * Kenapa terpisah dari `apps/api/src/platform-admin/platform-admin-default.cli.ts`:
 * CLI itu sengaja tidak pernah menanam TOTP (login pertama wajib enrollment) dan
 * memakai password bawaan publik. Untuk staging kita butuh akun yang langsung
 * bisa masuk tahap MFA, dengan password dan secret TOTP acak dari environment.
 *
 * Aturan keamanan:
 * - menolak berjalan bila `NODE_ENV=production`,
 * - password & secret TOTP hanya dibaca dari environment, tidak pernah dicetak,
 * - secret TOTP dienkripsi AES-256-GCM dengan `PLATFORM_ADMIN_ENCRYPTION_KEY`
 *   (key yang sama dengan API), format `v1.<iv>.<tag>.<ciphertext>`,
 * - password di-hash scrypt dengan parameter identik `apps/api/src/common/crypto.ts`,
 * - perubahan tercatat di audit platform (`PLATFORM_ADMIN_MFA_ENROLLED`).
 *
 * Idempoten: akun dicari lewat email lalu dibuat/dipertahankan; role
 * PLATFORM_SUPER_ADMIN diaktifkan kembali bila pernah dicabut, dan `lastTotpStep`
 * di-reset agar kode TOTP berikutnya diterima.
 *
 * Env yang dibutuhkan:
 *   DATABASE_URL
 *   PLATFORM_ADMIN_SEED_EMAIL
 *   PLATFORM_ADMIN_SEED_PASSWORD   (>= 12 karakter)
 *   PLATFORM_ADMIN_SEED_TOTP_SECRET (base32, ditampilkan sebagai QR di aplikasi authenticator)
 *   PLATFORM_ADMIN_ENCRYPTION_KEY  (base64, tepat 32 byte — sama dengan milik API)
 *
 * Pemakaian (root repo, setelah `pnpm --filter @rentalio/database build`):
 *   node database/prisma/seed-platform-admin.mjs
 */
import { createCipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import dotenv from 'dotenv';
import { PrismaClient } from '../dist/index.js';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config({
  path: new URL('../../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
});

const MIN_PASSWORD_LENGTH = 12;
const SUPER_ADMIN_ROLE = 'PLATFORM_SUPER_ADMIN';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function fail(message) {
  process.stderr.write(`Seed Admin Platform dibatalkan: ${message}\n`);
  process.exit(1);
}

/** Hash password dengan format & parameter identik `apps/api/src/common/crypto.ts`. */
function hashPassword(password) {
  const params = { N: 16384, r: 8, p: 1, keylen: 64 };
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Enkripsi secret TOTP: `v1.<iv>.<tag>.<ciphertext>`, seluruhnya base64url. */
function encryptSecret(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function assertBase32(secret) {
  const normalized = secret.toUpperCase().replace(/=+$/, '');
  if (normalized.length < 32) return null;
  for (const char of normalized) {
    if (!BASE32.includes(char)) return null;
  }
  return normalized;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    fail('akun seed TOTP hanya untuk staging/preview; production memakai `admin:bootstrap`.');
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) fail('DATABASE_URL belum di-set.');

  const email = (process.env.PLATFORM_ADMIN_SEED_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_SEED_PASSWORD ?? '';
  const totpSecret = assertBase32((process.env.PLATFORM_ADMIN_SEED_TOTP_SECRET ?? '').trim());
  const encryptionKeyText = process.env.PLATFORM_ADMIN_ENCRYPTION_KEY?.trim() ?? '';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('PLATFORM_ADMIN_SEED_EMAIL tidak valid.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`PLATFORM_ADMIN_SEED_PASSWORD minimal ${MIN_PASSWORD_LENGTH} karakter.`);
  }
  if (!totpSecret) fail('PLATFORM_ADMIN_SEED_TOTP_SECRET harus base32 minimal 32 karakter.');

  const encryptionKey = Buffer.from(encryptionKeyText, 'base64');
  if (encryptionKey.length !== 32) {
    fail('PLATFORM_ADMIN_ENCRYPTION_KEY harus base64 dari tepat 32 byte.');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rentalio.platform_admin.seed'))`;

      const role = await tx.platformRole.findUnique({ where: { code: SUPER_ADMIN_ROLE } });
      if (!role) {
        throw new Error(
          `role ${SUPER_ADMIN_ROLE} belum ada; terapkan migrasi platform admin terlebih dahulu.`,
        );
      }

      const now = new Date();
      const data = {
        passwordHash: hashPassword(password),
        status: 'ACTIVE',
        totpSecretEncrypted: encryptSecret(encryptionKey, totpSecret),
        mfaEnrolledAt: now,
        // Reset agar kode TOTP berikutnya diterima (anti-replay per langkah).
        lastTotpStep: null,
      };
      const existing = await tx.platformAdminUser.findUnique({ where: { email } });
      const admin = existing
        ? await tx.platformAdminUser.update({ where: { id: existing.id }, data })
        : await tx.platformAdminUser.create({ data: { email, ...data } });

      const assignment = await tx.platformAdminRole.findFirst({
        where: { adminUserId: admin.id, roleId: role.id },
      });
      if (!assignment) {
        await tx.platformAdminRole.create({ data: { adminUserId: admin.id, roleId: role.id } });
      } else if (assignment.revokedAt) {
        await tx.platformAdminRole.update({ where: { id: assignment.id }, data: { revokedAt: null } });
      }

      await tx.platformAuditEvent.create({
        data: {
          actorAdminId: admin.id,
          action: 'PLATFORM_ADMIN_MFA_ENROLLED',
          targetType: 'platform_admin_user',
          targetId: admin.id,
          outcome: 'SUCCESS',
          correlationId: `seed-staging-${randomUUID()}`,
          metadata: { source: 'seed-staging', role: role.code, mfaEnrolled: true },
        },
      });

      return { created: !existing, adminId: admin.id, role: role.code };
    });

    process.stdout.write(
      `Admin Platform ${outcome.created ? 'dibuat' : 'diselaraskan'}: ${email}\n` +
        `Role: ${outcome.role} (aktif)\n` +
        'MFA: sudah ter-enroll TOTP (secret tidak ditampilkan; lihat sumber env).\n' +
        'Login admin: password lalu kode 6 digit dari authenticator.\n',
    );
  } catch (error) {
    process.stderr.write(
      `Seed Admin Platform gagal: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}\n`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(
    `Seed Admin Platform gagal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

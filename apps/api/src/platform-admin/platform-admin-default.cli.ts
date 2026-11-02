/**
 * Seed Admin Platform default untuk **development**.
 *
 * Berbeda dari `admin:bootstrap` (interaktif, sekali seumur instalasi), perintah
 * ini idempoten: menjalankannya berulang kali akan menyelaraskan akun bawaan
 * tanpa membuat baris duplikat, sehingga mesin dev baru bisa langsung dipakai.
 *
 * Batasan keamanan:
 * - menolak berjalan saat `NODE_ENV=production` (jalur production tetap
 *   `admin:bootstrap` yang interaktif),
 * - password tetap di-hash scrypt yang sama dengan jalur login,
 * - seluruh perubahan tercatat pada audit platform,
 * - TOTP tidak pernah di-seed; login pertama tetap wajib enrollment.
 *
 * Jalankan: pnpm --filter @rentalio/api admin:seed
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@rentalio/database';
import { hashPassword } from '../common/crypto.js';

const DEFAULT_EMAIL = 'admin@rentalio.my.id';
const DEFAULT_PASSWORD = 'admlogin123';
const POLICY_MIN_LENGTH = 12;

function fail(message: string): never {
  process.stderr.write(`Seed dibatalkan: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  loadEnv({ path: resolve(process.cwd(), '../../.env') });
  loadEnv();

  if (process.env.NODE_ENV === 'production') {
    fail('akun default hanya untuk development; gunakan `admin:bootstrap` di production.');
  }

  const email = (process.env.PLATFORM_ADMIN_DEFAULT_EMAIL ?? DEFAULT_EMAIL).trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_DEFAULT_PASSWORD ?? DEFAULT_PASSWORD;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('format email tidak valid.');
  if (password.length === 0) fail('password kosong.');
  if (password.length < POLICY_MIN_LENGTH) {
    process.stderr.write(
      `Peringatan: password default hanya ${password.length} karakter, di bawah kebijakan ` +
        `${POLICY_MIN_LENGTH} karakter. Aman untuk lokal, jangan dipakai di server bersama.\n`,
    );
  }

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) fail('DATABASE_URL belum di-set (lihat .env.example).');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rentalio.platform_admin.seed'))`;

      const role = await tx.platformRole.findUnique({ where: { code: 'PLATFORM_SUPER_ADMIN' } });
      if (!role) {
        throw new Error(
          'role PLATFORM_SUPER_ADMIN belum ada; jalankan migrasi platform admin terlebih dahulu.',
        );
      }

      const existing = await tx.platformAdminUser.findUnique({ where: { email } });
      const passwordHash = hashPassword(password);
      const admin = existing
        ? await tx.platformAdminUser.update({
            where: { id: existing.id },
            data: { passwordHash, status: 'ACTIVE' },
          })
        : await tx.platformAdminUser.create({ data: { email, passwordHash } });

      const assignment = await tx.platformAdminRole.findFirst({
        where: { adminUserId: admin.id, roleId: role.id },
      });
      if (!assignment) {
        await tx.platformAdminRole.create({ data: { adminUserId: admin.id, roleId: role.id } });
      } else if (assignment.revokedAt) {
        await tx.platformAdminRole.update({
          where: { id: assignment.id },
          data: { revokedAt: null },
        });
      }

      await tx.platformAuditEvent.create({
        data: {
          actorAdminId: admin.id,
          action: 'PLATFORM_ADMIN_BOOTSTRAPPED',
          targetType: 'platform_admin_user',
          targetId: admin.id,
          outcome: 'SUCCESS',
          correlationId: `seed-dev-${admin.id}`,
          metadata: { source: 'seed-dev', role: role.code, passwordReset: Boolean(existing) },
        },
      });

      return { created: !existing, adminId: admin.id, role: role.code };
    });

    process.stdout.write(
      `Admin Platform default ${outcome.created ? 'dibuat' : 'diselaraskan'}: ${email}\n` +
        `Role: ${outcome.role}\n` +
        'Login pertama akan meminta enrollment TOTP sebelum sesi diterbitkan.\n' +
        'Akun ini hanya untuk development; hapus/rotasi sebelum dipakai bersama.\n',
    );
  } catch (error) {
    process.stderr.write(
      `Seed gagal: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}\n`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed gagal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

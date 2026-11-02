/**
 * Bootstrap Admin Platform pertama (PLAT-01).
 *
 * Sengaja TIDAK diekspos sebagai endpoint HTTP: siapa pun yang bisa memanggil
 * bootstrap akan menjadi Super Admin, sehingga jalur ini hanya tersedia lewat
 * shell server. Aturan keamanan yang ditegakkan skrip ini:
 * - hanya berjalan di TTY interaktif (tidak bisa dipakai dari CI/pipe),
 * - password tidak pernah lewat argumen CLI (tidak muncul di process list /
 *   shell history) dan tidak di-echo saat diketik,
 * - password diketik dua kali lalu dikonfirmasi dengan kata kunci,
 * - penulisan memakai advisory lock dan hanya berhasil bila belum ada satu pun
 *   admin platform (sekali seumur instalasi),
 * - kegagalan dijelaskan tanpa mencetak secret.
 *
 * Jalankan: pnpm --filter @rentalio/api admin:bootstrap
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@rentalio/database';
import { hashPassword } from '../common/crypto.js';

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

function fail(message: string): never {
  process.stderr.write(`Bootstrap dibatalkan: ${message}\n`);
  process.exit(1);
}

function requireInteractiveTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('perintah ini wajib dijalankan pada terminal interaktif (bukan pipe/CI).');
  }
}

/** Baca satu baris tanpa menampilkan karakter (untuk password). */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\u0003') {
          cleanup();
          rejectPromise(new Error('dibatalkan dengan Ctrl+C'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolvePromise(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        // Abaikan karakter kontrol lain; jangan pernah menggema isi password.
        if (char >= ' ') value += char;
      }
    };

    stdin.on('data', onData);
  });
}

/** Baca satu baris biasa (email/konfirmasi) tanpa mengubah mode terminal. */
function readVisible(prompt: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const onData = (chunk: string): void => {
      const newline = chunk.indexOf('\n');
      if (newline === -1) {
        value += chunk;
        return;
      }
      value += chunk.slice(0, newline);
      stdin.removeListener('data', onData);
      stdin.pause();
      resolvePromise(value.replace(/\r$/, ''));
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  requireInteractiveTty();
  loadEnv({ path: resolve(process.cwd(), '../../.env') });
  loadEnv();

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    fail('DATABASE_URL belum di-set (lihat .env.example).');
  }

  process.stdout.write(
    '\nMembuat Super Admin Platform pertama.\n' +
      'Akun ini global (bukan tenant) dan wajib mengaktifkan TOTP saat login pertama.\n\n',
  );

  const email = (await readVisible('Email admin: ')).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('format email tidak valid.');

  const password = await readHidden('Password (minimal 12 karakter, tidak ditampilkan): ');
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    fail(`password harus ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} karakter.`);
  }
  const confirmation = await readHidden('Ulangi password: ');
  if (password !== confirmation) fail('password dan konfirmasi tidak sama.');

  const acknowledgement = await readVisible(
    `Ketik BOOTSTRAP untuk membuat akun ${email} (sekali seumur instalasi): `,
  );
  if (acknowledgement.trim() !== 'BOOTSTRAP') fail('konfirmasi tidak cocok.');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rentalio.platform_admin.bootstrap'))`;
      const existing = await tx.platformAdminUser.count();
      if (existing > 0) return null;
      const role = await tx.platformRole.findUnique({ where: { code: 'PLATFORM_SUPER_ADMIN' } });
      if (!role) {
        throw new Error(
          'role PLATFORM_SUPER_ADMIN belum ada; jalankan migrasi platform admin terlebih dahulu.',
        );
      }
      const admin = await tx.platformAdminUser.create({
        data: { email, passwordHash: hashPassword(password) },
      });
      await tx.platformAdminRole.create({ data: { adminUserId: admin.id, roleId: role.id } });
      await tx.platformAuditEvent.create({
        data: {
          actorAdminId: admin.id,
          action: 'PLATFORM_ADMIN_BOOTSTRAPPED',
          targetType: 'platform_admin_user',
          targetId: admin.id,
          outcome: 'SUCCESS',
          correlationId: `bootstrap-cli-${admin.id}`,
          metadata: { source: 'cli' },
        },
      });
      return admin;
    });

    if (!result) {
      process.stderr.write(
        'Bootstrap dibatalkan: sudah ada admin platform. Hapus/bootstrap manual ' +
          'tidak didukung; gunakan alur role assignment yang tercatat audit.\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Admin Platform dibuat: ${result.email}\n` +
        'Login pertama akan meminta enrollment TOTP sebelum sesi diterbitkan.\n',
    );
  } catch (error) {
    process.stderr.write(
      `Bootstrap gagal: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}\n`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Bootstrap gagal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Setup bersih: hapus semua node_modules lalu instal ulang dari lockfile.
 *
 * Tujuan: menyamakan instalasi lokal dengan runner CI. Instalasi yang sudah
 * lama dipakai bisa menyimpan paket yang tidak lagi ada di graf lockfile
 * (mis. salinan ter-hoist di node_modules root), sehingga typecheck lokal lolos
 * padahal CI gagal. Skrip ini menghapusnya agar tata letak mengikuti
 * `pnpm install --frozen-lockfile` dari nol.
 *
 * Pemakaian:
 *   pnpm setup:clean
 *   node scripts/setup-clean-install.mjs --dry-run   # hanya tampilkan rencana
 *
 * Peringatan: hentikan dulu dev server (api/web/admin) — Windows mengunci
 * berkas node_modules yang sedang dipakai proses berjalan.
 *
 * Setelah instal, Gate 2 di CI juga menjalankan:
 *   pnpm db:generate && pnpm --filter @rentalio/database build
 * karena Prisma client dan dist paket database tidak disimpan di Git. Skrip
 * ini mencetak perintah tersebut di akhir agar typecheck lokal setara CI.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

/** Batas kedalaman pencarian: root, apps/*, packages/*, tests/*, database. */
const MAX_DEPTH = 3;

/** Direktori yang tidak perlu ditelusuri (besar, bukan workspace, atau VCS). */
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.tools',
  '.dev-logs',
  '.backups',
  'coverage',
  'dist',
  'build',
]);

/**
 * Kumpulkan direktori node_modules milik workspace. Penelusuran berhenti di
 * node_modules pertama agar tidak masuk ke ribuan paket di dalamnya.
 */
function findNodeModules(startDir, depth = 0) {
  if (depth > MAX_DEPTH) return [];

  const found = [];
  for (const entry of readdirSync(startDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const fullPath = join(startDir, entry.name);
    if (entry.name === 'node_modules') {
      found.push(fullPath);
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    found.push(...findNodeModules(fullPath, depth + 1));
  }
  return found;
}

/** Jaga-jaga: jangan pernah menghapus apa pun di luar repo. */
function assertInsideRepo(target) {
  const rootPrefix = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
  if (!resolve(target).startsWith(rootPrefix)) {
    throw new Error(`Menolak menghapus direktori di luar repo: ${target}`);
  }
}

const targets = findNodeModules(repoRoot).sort();

if (targets.length === 0) {
  console.log('Tidak ada node_modules di workspace — lanjut instal saja.');
} else {
  console.log(`Ditemukan ${targets.length} direktori node_modules:`);
  for (const target of targets) {
    console.log(`  - ${target.slice(repoRoot.length + 1).replaceAll(sep, '/')}`);
  }
}

if (dryRun) {
  console.log('\n--dry-run: tidak ada yang dihapus.');
  console.log('Perintah instal yang akan dijalankan: pnpm install --frozen-lockfile');
  process.exit(0);
}

for (const target of targets) {
  assertInsideRepo(target);
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(`Dihapus: ${target.slice(repoRoot.length + 1).replaceAll(sep, '/')}`);
}

console.log('\nInstal ulang dari lockfile (persis perintah CI)...');
// Satu string konstan (bukan array argumen) menghindari DEP0190 pada Windows,
// tempat pnpm.cmd hanya bisa dijalankan lewat shell.
const install = spawnSync('pnpm install --frozen-lockfile', {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: true,
});

if (install.status !== 0) {
  console.error(`\nInstalasi gagal (exit ${install.status ?? 'sinyal'}).`);
  process.exit(install.status ?? 1);
}

console.log('\nSelesai. Tata letak node_modules kini mengikuti pnpm-lock.yaml.');
console.log('Langkah berikutnya agar Gate 2 lokal setara CI:');
console.log('  pnpm db:generate && pnpm --filter @rentalio/database build');

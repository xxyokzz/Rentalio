#!/usr/bin/env node
/**
 * Backup & restore verification untuk database Rentalio.
 *
 * Alur: pg_dump (custom format) → buat database sementara → pg_restore →
 * bandingkan jumlah baris tiap tabel, jumlah tabel ber-RLS, dan jumlah policy
 * antara database sumber dan hasil restore. Database sementara dihapus lagi
 * kecuali `--keep` diberikan.
 *
 * Pemakaian:
 *   node scripts/ops/backup-restore.mjs
 *   node scripts/ops/backup-restore.mjs --keep --out .backups/manual.dump
 *
 * Konfigurasi:
 *   BACKUP_DATABASE_URL — opsional; role khusus backup (superuser atau BYPASSRLS).
 *   DATABASE_URL        — wajib bila BACKUP_DATABASE_URL kosong
 *                         (fallback: database/.env, lalu .env di root repo)
 *   PG_BIN              — direktori bin PostgreSQL bila pg_dump/psql tidak ada di PATH
 *
 * Catatan RLS: tabel Rentalio memakai FORCE ROW LEVEL SECURITY, sehingga role
 * aplikasi/migrator tidak dapat menyalin seluruh baris. Backup harus memakai
 * role superuser atau role dengan atribut BYPASSRLS; skrip menolak jalan bila
 * role yang dipakai tidak memenuhi syarat itu.
 *
 * Keamanan: hanya menerima host loopback. Untuk host lain, tambahkan
 * `--allow-remote` secara sadar. Password tidak pernah dicetak.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratchDb = 'rentalio_restore_verify';
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);

const args = process.argv.slice(2);
const flags = {
  keep: args.includes('--keep'),
  allowRemote: args.includes('--allow-remote'),
  help: args.includes('--help') || args.includes('-h'),
};
const outArg = args.find((arg) => arg.startsWith('--out='));

if (flags.help) {
  console.log(
    [
      'Backup & restore verification — Rentalio',
      '',
      '  node scripts/ops/backup-restore.mjs [--keep] [--out=<file>] [--allow-remote]',
      '',
      '  --keep          biarkan database sementara + dump setelah verifikasi',
      '  --out=<file>    lokasi dump (default: .backups/<timestamp>.dump)',
      '  --allow-remote  izinkan host non-loopback (default: ditolak)',
      '',
      'Butuh pg_dump/psql versi >= server. Set PG_BIN bila tidak ada di PATH.',
    ].join('\n'),
  );
  process.exit(0);
}

/** Parser .env minimal — tidak menimpa variabel yang sudah ada di process.env. */
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function fail(message) {
  console.error(`GAGAL: ${message}`);
  process.exit(1);
}

function resolvePgBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];

  if (process.env.PG_BIN) {
    candidates.push(join(process.env.PG_BIN, exe), join(process.env.PG_BIN, 'bin', exe));
  }
  for (const prefix of ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    candidates.push(join(prefix, name));
  }
  // Instalasi lokal tanpa installer (mis. pgsql184/pgsql/bin di direktori user).
  for (const parent of [homedir(), 'C:\\Program Files\\PostgreSQL']) {
    if (!existsSync(parent)) continue;
    let entries = [];
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      candidates.push(join(parent, entry.name, 'bin', exe));
      candidates.push(join(parent, entry.name, 'pgsql', 'bin', exe));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Terakhir: andalkan PATH.
  if (spawnSync(name, ['--version'], { encoding: 'utf8' }).status === 0) return name;
  return null;
}

function pgEnv(config) {
  const env = {
    ...process.env,
    PGHOST: config.host,
    PGPORT: config.port,
    PGUSER: config.user,
    PGDATABASE: config.database,
    PGCONNECT_TIMEOUT: '15',
  };
  if (config.password) env.PGPASSWORD = config.password;
  if (config.sslmode) env.PGSSLMODE = config.sslmode;
  return env;
}

function run(bin, argv, env) {
  const result = spawnSync(bin, argv, { env, encoding: 'utf8' });
  if (result.error) throw new Error(`${bin} tidak dapat dijalankan: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${bin} ${argv.join(' ')} keluar dengan status ${result.status}\n${detail}`);
  }
  return (result.stdout || '').trim();
}

/** Hitung baris tepat per tabel di schema public (pakai count(*), bukan estimasi). */
function countRows(psql, env) {
  const builder = run(psql, [
    '-t',
    '-A',
    '-c',
    `SELECT string_agg(
       format('SELECT %L AS t, count(*)::bigint AS c FROM %I.%I',
              c.relname, n.nspname, c.relname),
       ' UNION ALL ' ORDER BY c.relname)
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  ], env);
  if (!builder) return new Map();

  const output = run(psql, ['-t', '-A', '-F', '|', '-c', `${builder} ORDER BY 1`], env);
  const counts = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [table, count] = line.split('|');
    counts.set(table, Number(count));
  }
  return counts;
}

/** Jumlah tabel ber-RLS dan jumlah policy — bukti postur keamanan ikut ter-restore. */
function securityStats(psql, env) {
  const output = run(psql, [
    '-t',
    '-A',
    '-F',
    '|',
    '-c',
    `SELECT
       (SELECT count(*) FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity),
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public')`,
  ], env);
  const [rlsTables, policies] = output.split('|').map(Number);
  return { rlsTables, policies };
}

function diffCounts(source, restored) {
  const differences = [];
  for (const [table, count] of source) {
    const other = restored.get(table);
    if (other === undefined) {
      differences.push(`${table}: tidak ada di hasil restore (sumber ${count} baris)`);
    } else if (other !== count) {
      differences.push(`${table}: sumber ${count} baris, restore ${other} baris`);
    }
  }
  for (const table of restored.keys()) {
    if (!source.has(table)) differences.push(`${table}: hanya ada di hasil restore`);
  }
  return differences;
}

function dropScratch(createdbName, env, psqlMaintenance) {
  spawnSync(psqlMaintenance, [
    '-t',
    '-A',
    '-c',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = '${createdbName}' AND pid <> pg_backend_pid()`,
  ], { env, encoding: 'utf8' });
  const drop = spawnSync(psqlMaintenance, [
    '-c',
    `DROP DATABASE IF EXISTS "${createdbName}"`,
  ], { env, encoding: 'utf8' });
  if (drop.status !== 0) {
    console.warn(`Peringatan: database sementara ${createdbName} gagal dihapus.`);
  }
}

function main() {
  loadDotEnv(join(repoRoot, 'database', '.env'));
  loadDotEnv(join(repoRoot, '.env'));

  const rawUrl = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
  if (!rawUrl) {
    fail('BACKUP_DATABASE_URL/DATABASE_URL tidak ditemukan (env, database/.env, atau .env).');
  }
  if (process.env.BACKUP_DATABASE_URL) {
    console.log('Sumber URL : BACKUP_DATABASE_URL');
  } else {
    console.log('Sumber URL : DATABASE_URL');
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail('DATABASE_URL bukan URL yang valid.');
  }

  const config = {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    sslmode: url.searchParams.get('sslmode') ?? undefined,
  };

  if (!config.database) fail('DATABASE_URL tidak memuat nama database.');
  if (!loopbackHosts.has(config.host) && !flags.allowRemote) {
    fail(`host ${config.host} bukan loopback. Tambahkan --allow-remote bila memang disengaja.`);
  }

  const pgDump = resolvePgBinary('pg_dump');
  const pgRestore = resolvePgBinary('pg_restore');
  const psql = resolvePgBinary('psql');
  if (!pgDump || !pgRestore || !psql) {
    fail('pg_dump/pg_restore/psql tidak ditemukan. Set PG_BIN ke direktori bin PostgreSQL.');
  }

  console.log(`Target     : ${config.host}:${config.port}/${config.database} (user ${config.user})`);
  console.log(`Klien PG   : ${pgDump}`);

  const env = pgEnv(config);

  // Prasyarat RLS: role backup wajib superuser atau punya BYPASSRLS.
  const privilege = run(psql, [
    '-t',
    '-A',
    '-c',
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  ], env);
  const [isSuper, canBypassRls] = privilege.split('|').map((value) => value === 't');
  if (!isSuper && !canBypassRls) {
    fail(
      `role ${config.user} tidak superuser dan tanpa BYPASSRLS; pg_dump akan gagal pada tabel ber-RLS. ` +
        'Pakai BACKUP_DATABASE_URL dengan role backup (superuser/BYPASSRLS).',
    );
  }

  const backupDir = join(repoRoot, '.backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpPath = outArg ? resolve(repoRoot, outArg.slice('--out='.length)) : join(backupDir, `${stamp}.dump`);

  // 1. Dump.
  run(pgDump, [
    '--format=custom',
    '--no-password',
    '--file',
    dumpPath,
  ], env);
  const dumpEntries = run(pgRestore, ['--list', dumpPath], env).split(/\r?\n/).filter(Boolean);
  if (dumpEntries.length === 0) fail('dump kosong — tidak ada entri yang bisa di-restore.');
  console.log(`Dump       : ${dumpPath} (${dumpEntries.length} entri)`);

  // 2. Siapkan database sementara, lalu restore ketat: berhenti pada error pertama.
  dropScratch(scratchDb, env, psql);
  run(psql, ['-c', `CREATE DATABASE "${scratchDb}"`], env);
  const scratchEnv = { ...env, PGDATABASE: scratchDb };

  let differences = [];
  let securityMatches = true;
  let sourceCounts = new Map();
  let restoredCounts = new Map();
  let sourceSecurity = { rlsTables: 0, policies: 0 };
  let restoredSecurity = { rlsTables: 0, policies: 0 };
  try {
    run(pgRestore, ['--dbname', scratchDb, '--no-password', '--exit-on-error', dumpPath], env);
    console.log('Restore    : selesai tanpa error (--exit-on-error)');

    // 4. Bandingkan isi dan postur keamanan.
    sourceCounts = countRows(psql, env);
    restoredCounts = countRows(psql, scratchEnv);
    sourceSecurity = securityStats(psql, env);
    restoredSecurity = securityStats(psql, scratchEnv);

    differences = diffCounts(sourceCounts, restoredCounts);
    securityMatches =
      sourceSecurity.rlsTables === restoredSecurity.rlsTables &&
      sourceSecurity.policies === restoredSecurity.policies;

    const totalRows = [...sourceCounts.values()].reduce((sum, value) => sum + value, 0);
    console.log(
      `Tabel      : ${sourceCounts.size} tabel, ${totalRows} baris (sumber) vs ${restoredCounts.size} tabel (restore)`,
    );
    console.log(
      `RLS        : ${sourceSecurity.rlsTables} tabel + ${sourceSecurity.policies} policy (sumber) vs ` +
        `${restoredSecurity.rlsTables} tabel + ${restoredSecurity.policies} policy (restore)`,
    );
  } finally {
    if (flags.keep) {
      console.log(`Cleanup    : dilewati (--keep); database ${scratchDb} dipertahankan`);
    } else {
      dropScratch(scratchDb, env, psql);
      console.log('Cleanup    : database sementara dihapus (dump tetap disimpan)');
    }
  }

  if (differences.length > 0 || !securityMatches) {
    console.error('\nHasil: TIDAK COCOK');
    for (const item of differences) console.error(`  - ${item}`);
    if (!securityMatches) console.error('  - jumlah tabel RLS/policy berbeda');
    process.exit(1);
  }

  console.log('\nHasil: PASS — jumlah baris seluruh tabel, tabel RLS, dan policy identik.');
}

try {
  main();
} catch (error) {
  console.error(`GAGAL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

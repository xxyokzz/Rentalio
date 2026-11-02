#!/usr/bin/env node
/**
 * Validasi kontrak OpenAPI Rentalio (sumber tunggal: docs/openapi.yaml).
 *
 * Pemeriksaan:
 * 1. YAML dapat di-parse tanpa error.
 * 2. `openapi` tepat 3.1.1 (baseline terkunci) dan `info.version` terisi.
 * 3. Spec valid terhadap skema OpenAPI 3.1 (validator @readme/openapi-parser),
 *    termasuk resolusi seluruh $ref dan deteksi operationId ganda.
 * 4. Setiap path punya `x-implementation-status` bernilai implemented|future.
 * 5. Endpoint `future` wajib berlabel [FUTURE] pada summary, dan sebaliknya
 *    endpoint [FUTURE] wajib berstatus future (mencegah kontrak menyesatkan).
 * 6. Setiap operasi punya operationId dan minimal satu respons.
 * 7. Setiap operasi punya `x-required-permission` non-empty; permission
 *    `membership` wajib menyertakan daftar `x-required-roles` yang valid.
 *
 * Exit code 1 bila ada pelanggaran — dipakai sebagai gate CI (S0-04).
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { validate } from '@readme/openapi-parser';

const REQUIRED_OPENAPI_VERSION = '3.1.1';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Argumen opsional: path lain (relatif repo atau absolut) untuk diuji —
// berguna untuk memverifikasi bahwa gate benar-benar menolak kontrak rusak.
const specArgument = process.argv[2] ?? 'docs/openapi.yaml';
const specPath = resolve(repoRoot, specArgument);

const problems = [];

function fail(message) {
  problems.push(message);
}

let raw;
try {
  raw = readFileSync(specPath, 'utf8');
} catch (err) {
  console.error(`Tidak dapat membaca ${relative(repoRoot, specPath)}: ${err.message}`);
  process.exit(1);
}

const doc = parseDocument(raw);
if (doc.errors.length > 0) {
  console.error('YAML tidak valid:');
  for (const err of doc.errors) console.error(`- ${err.message}`);
  process.exit(1);
}

/** @type {Record<string, unknown>} */
const spec = doc.toJS();

// --- 2. Versi & metadata ------------------------------------------------
if (spec.openapi !== REQUIRED_OPENAPI_VERSION) {
  fail(
    `openapi harus "${REQUIRED_OPENAPI_VERSION}" (baseline terkunci), ditemukan "${String(spec.openapi)}"`,
  );
}
const info = spec.info ?? {};
if (!info.title) fail('info.title wajib diisi');
if (!info.version) fail('info.version wajib diisi');
if (!Array.isArray(spec.servers) || spec.servers.length === 0) {
  fail('servers wajib memuat minimal satu entri');
}

// --- 4-6. Kontrak path & operasi ---------------------------------------
const paths = spec.paths ?? {};
const pathEntries = Object.entries(paths);
const operationIds = new Map();
const futureOperations = [];
let operationCount = 0;

for (const [path, item] of pathEntries) {
  if (!item || typeof item !== 'object') {
    fail(`path ${path} harus berupa object`);
    continue;
  }
  const status = item['x-implementation-status'];
  if (status !== 'implemented' && status !== 'future') {
    fail(
      `path ${path} wajib punya x-implementation-status bernilai "implemented" atau "future"`,
    );
  }

  for (const [method, operation] of Object.entries(item)) {
    if (!HTTP_METHODS.includes(method)) continue;
    operationCount += 1;
    const label = `${method.toUpperCase()} ${path}`;

    if (!operation.operationId) {
      fail(`${label} tidak punya operationId`);
    } else if (operationIds.has(operation.operationId)) {
      fail(
        `operationId "${operation.operationId}" dipakai dua kali (${operationIds.get(
          operation.operationId,
        )} dan ${label})`,
      );
    } else {
      operationIds.set(operation.operationId, label);
    }

    const responses = operation.responses ?? {};
    if (Object.keys(responses).length === 0) {
      fail(`${label} tidak mendeklarasikan respons`);
    }

    const requiredPermission = operation['x-required-permission'];
    if (typeof requiredPermission !== 'string' || requiredPermission.trim().length === 0) {
      fail(`${label} wajib punya x-required-permission berupa string non-empty`);
    } else if (requiredPermission === 'membership') {
      const allowedRoles = ['OWNER', 'MANAGER', 'STAFF', 'CASHIER'];
      const roles = operation['x-required-roles'];
      if (
        !Array.isArray(roles) ||
        roles.length === 0 ||
        roles.some((role) => typeof role !== 'string' || !allowedRoles.includes(role)) ||
        new Set(roles).size !== roles.length
      ) {
        fail(`${label} memakai permission membership tetapi x-required-roles tidak valid`);
      }
    } else if (operation['x-required-roles'] !== undefined) {
      fail(`${label} punya x-required-roles tanpa x-required-permission membership`);
    }

    const summary = typeof operation.summary === 'string' ? operation.summary : '';
    const labelledFuture = summary.includes('[FUTURE]');
    if (status === 'future') {
      futureOperations.push(label);
      if (!labelledFuture) {
        fail(`${label} berstatus future tetapi summary tidak diawali label [FUTURE]`);
      }
    } else if (labelledFuture) {
      fail(`${label} berlabel [FUTURE] tetapi berstatus implemented`);
    }
  }
}

// --- 3. Validasi terhadap skema OpenAPI 3.1 -----------------------------
let specValid = true;
try {
  const result = await validate(structuredClone(spec));
  specValid = result.valid !== false;
  if (!specValid) {
    for (const err of result.errors ?? []) fail(`spec: ${err.message}`);
  }
} catch (err) {
  specValid = false;
  const details = err?.details ?? err?.message ?? String(err);
  fail(`validasi skema OpenAPI gagal: ${typeof details === 'string' ? details : JSON.stringify(details)}`);
}

// --- Ringkasan ----------------------------------------------------------
const summary = [
  `OpenAPI ${String(spec.openapi)} — ${pathEntries.length} path, ${operationCount} operasi`,
  `Skema OpenAPI 3.1: ${specValid ? 'VALID' : 'TIDAK VALID'}`,
  `Endpoint future (${futureOperations.length}): ${
    futureOperations.length > 0 ? futureOperations.join(', ') : 'tidak ada'
  }`,
];

if (problems.length > 0) {
  console.error('Validasi kontrak OpenAPI GAGAL:');
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(summary.join('\n'));
  process.exit(1);
}

console.log('Validasi kontrak OpenAPI lulus.');
console.log(summary.join('\n'));

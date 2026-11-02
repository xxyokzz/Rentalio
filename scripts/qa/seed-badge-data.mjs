#!/usr/bin/env node
/**
 * Seed data QA untuk badge "Pesanan" dan "Konflik perpanjangan".
 *
 * Skrip ini memastikan tenant QA punya:
 *  1. satu permintaan perpanjangan berstatus PENDING_APPROVAL, dan
 *  2. satu konflik perpanjangan berstatus OPEN.
 *
 * Sifat idempoten: setiap bagian diperiksa lebih dulu, dan hanya bagian yang
 * belum ada yang dibuat. Menjalankan ulang saat kedua data sudah tersedia tidak
 * menambah baris baru.
 *
 * Semua perubahan lewat endpoint aplikasi (bukan tulis DB langsung), sehingga
 * aturan ketersediaan, izin, dan pembentukan konflik tetap dijalankan server.
 * Konflik OPEN hanya lahir dari kebijakan katalog SKIP_AVAILABILITY + override
 * berizin; skrip memverifikasi hal itu dan berhenti dengan pesan jelas bila
 * server menolak membentuk konflik (tidak pernah memalsukan baris konflik).
 *
 * Pemakaian:
 *   QA_SEED_EMAIL=owner@contoh.com QA_SEED_PASSWORD=... \
 *     node scripts/qa/seed-badge-data.mjs --tenant qa-badge
 *
 * Opsi (flag menimpa env):
 *   --email      QA_SEED_EMAIL       email pemilik/staf tenant QA
 *   --password   QA_SEED_PASSWORD    kata sandi akun QA
 *   --tenant     QA_SEED_TENANT      slug atau nama tenant (default: tenant pertama)
 *   --product    QA_SEED_PRODUCT     nama produk yang dipakai (default: produk pertama)
 *   --base       QA_SEED_BASE_URL    origin API (default: http://localhost:3000)
 *
 * Kredensial tidak pernah dicetak; skrip hanya melaporkan ringkasan data.
 */
const API_PREFIX = '/api/v1';
const DEFAULT_BASE_URL = 'http://localhost:3000';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Jam 10.00 waktu Jakarta (UTC+7) — sama dengan seed manual sebelumnya. */
const LOCAL_HOUR_OFFSET_MS = 3 * 60 * 60 * 1000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.trim();
    if (inlineValue !== undefined) {
      out[key] = inlineValue;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`• ${message}`);
}

function unwrap(response) {
  const body = response?.data;
  if (body && typeof body === 'object' && 'data' in body) return body.data;
  return body;
}

/** Klien API kecil dengan cookie sesi + token CSRF (tanpa dependensi). */
class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cookie = '';
    this.csrfToken = '';
  }

  async request(method, path, options = {}) {
    const { body, csrf = false, idempotencyKey } = options;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    if (csrf) {
      if (!this.csrfToken) throw new Error('Token CSRF belum tersedia untuk permintaan mutasi.');
      headers['X-CSRF-Token'] = this.csrfToken;
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await fetch(`${this.baseUrl}${API_PREFIX}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length > 0) {
      this.cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    }
    const csrfHeader = response.headers.get('x-csrf-token');
    if (csrfHeader) this.csrfToken = csrfHeader;

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: response.ok, status: response.status, data };
  }

  async get(path) {
    return this.request('GET', path);
  }

  async post(path, body = {}, options = {}) {
    return this.request('POST', path, {
      body,
      csrf: true,
      idempotencyKey: crypto.randomUUID(),
      ...options,
    });
  }
}

function describeError(response) {
  const error = response?.data?.error;
  if (!error) return `HTTP ${response?.status}`;
  const conflicts = error.details?.conflicts?.length ?? 0;
  return `${error.code}: ${error.message}${conflicts ? ` (${conflicts} konflik)` : ''}`;
}

function startOfDayUtc(offsetDays) {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return utcMidnight + offsetDays * DAY_MS + LOCAL_HOUR_OFFSET_MS;
}

function addDays(isoString, days) {
  return new Date(new Date(isoString).getTime() + days * DAY_MS).toISOString();
}

async function login(client, email, password) {
  const response = await client.request('POST', '/auth/sessions', {
    body: { email, password },
    csrf: false,
  });
  if (!response.ok) fail(`Login gagal — ${describeError(response)}`);
  return unwrap(response)?.user ?? null;
}

async function resolveTenant(client, selector) {
  const tenants = unwrap(await client.get('/tenants')) ?? [];
  if (tenants.length === 0) fail('Akun ini tidak punya tenant; jalankan onboarding dulu.');
  if (!selector) return tenants[0];
  const needle = selector.toLowerCase();
  const match = tenants.find(
    (tenant) => tenant.slug?.toLowerCase() === needle || tenant.name?.toLowerCase() === needle,
  );
  if (!match) {
    const names = tenants.map((tenant) => `${tenant.slug} (${tenant.name})`).join(', ');
    fail(`Tenant "${selector}" tidak ditemukan. Tersedia: ${names}`);
  }
  return match;
}

async function listProducts(client, tenantId, preferredName) {
  const products = unwrap(await client.get(`/tenants/${tenantId}/products`)) ?? [];
  if (products.length === 0) fail('Tenant belum punya produk; buat minimal satu produk dulu.');
  if (!preferredName) return products;
  const needle = preferredName.toLowerCase();
  const preferred = products.filter((product) => product.name?.toLowerCase().includes(needle));
  return preferred.length > 0 ? preferred : products;
}

async function listActiveOrders(client, tenantId) {
  const response = await client.get(`/tenants/${tenantId}/orders?status=ACTIVE&page=1&pageSize=50`);
  if (!response.ok) fail(`Gagal membaca daftar pesanan — ${describeError(response)}`);
  return unwrap(response) ?? [];
}

async function loadOrder(client, tenantId, orderId) {
  const response = await client.get(`/tenants/${tenantId}/orders/${orderId}`);
  if (!response.ok) fail(`Gagal membaca pesanan ${orderId} — ${describeError(response)}`);
  return unwrap(response);
}

/** Akhir sewa terbaru dari seluruh item pesanan (periode efektif pesanan). */
function orderEndAt(order) {
  const ends = (order.items ?? []).map((item) => new Date(item.endAt).getTime()).filter(Number.isFinite);
  if (ends.length === 0) return null;
  return new Date(Math.max(...ends)).toISOString();
}

async function findFreeWindow(client, tenantId, product, days) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const startAt = new Date(startOfDayUtc(30 + attempt * 7)).toISOString();
    const endAt = addDays(startAt, days);
    const query = new URLSearchParams({ productId: product.id, startAt, endAt });
    const availability = unwrap(await client.get(`/tenants/${tenantId}/availability?${query}`));
    if ((availability?.available ?? 0) > 0) return { startAt, endAt };
  }
  return null;
}

/** Pastikan ada satu pesanan ACTIVE; buat lengkap lewat alur domain bila kosong. */
async function ensureActiveOrder(client, tenantId, product) {
  const active = await listActiveOrders(client, tenantId);
  if (active.length > 0) {
    const loaded = await loadOrder(client, tenantId, active[0].id);
    log(`Memakai pesanan aktif ${loaded.orderNumber ?? loaded.id}.`);
    return loaded;
  }

  const window = await findFreeWindow(client, tenantId, product, 3);
  if (!window) fail('Tidak menemukan periode kosong 3 hari untuk membuat pesanan QA.');

  const reservation = await client.post(`/tenants/${tenantId}/reservations`, {
    startAt: window.startAt,
    endAt: window.endAt,
    items: [{ productId: product.id, quantity: 1 }],
  });
  if (!reservation.ok) fail(`Gagal membuat reservasi — ${describeError(reservation)}`);
  const reservationId = unwrap(reservation).id;

  const confirmed = await client.post(`/tenants/${tenantId}/reservations/${reservationId}/confirm`, {
    note: 'QA seed: reservasi untuk pesanan uji badge',
  });
  if (!confirmed.ok) fail(`Gagal mengonfirmasi reservasi — ${describeError(confirmed)}`);

  const order = await client.post(`/tenants/${tenantId}/orders`, { reservationId });
  if (!order.ok) fail(`Gagal membuat pesanan — ${describeError(order)}`);
  const orderId = unwrap(order).id;

  const ready = await client.post(`/tenants/${tenantId}/orders/${orderId}/ready-for-handover`, {});
  if (!ready.ok) fail(`Gagal menandai siap serah-terima — ${describeError(ready)}`);

  const handover = await client.post(`/tenants/${tenantId}/orders/${orderId}/handover`, {});
  if (!handover.ok) fail(`Gagal serah-terima — ${describeError(handover)}`);

  const loaded = await loadOrder(client, tenantId, orderId);
  log(`Pesanan aktif baru dibuat: ${loaded.orderNumber ?? orderId}.`);
  return loaded;
}

async function ensurePendingExtension(client, tenantId, order) {
  const endAt = orderEndAt(order);
  if (!endAt) fail('Pesanan tidak punya item; tidak bisa mengajukan perpanjangan.');
  const requestedEndAt = addDays(endAt, 3);

  const created = await client.post(`/tenants/${tenantId}/orders/${order.id}/extensions`, {
    requestedEndAt,
    note: 'QA seed: antrean menunggu keputusan',
  });
  if (!created.ok) fail(`Gagal mengajukan perpanjangan — ${describeError(created)}`);

  const extension = unwrap(created);
  log(
    `Antrean dibuat: ${order.orderNumber ?? order.id} sampai ${requestedEndAt} (${extension?.status ?? 'PENDING_APPROVAL'}).`,
  );
}

async function ensureOpenConflict(client, tenantId, order) {
  const item = (order.items ?? [])[0];
  if (!item) fail('Pesanan tidak punya item; tidak bisa membentuk konflik.');
  const windowStart = orderEndAt(order);
  const windowEnd = addDays(windowStart, 2);

  // Blokir sisa kapasitas pada periode sasaran agar persetujuan pasti bentrok.
  // Bila periode sudah terblokir (mis. dari jalan sebelumnya), lewati pembuatan
  // reservasi supaya skrip tetap idempoten.
  const query = new URLSearchParams({
    productId: item.productId,
    startAt: windowStart,
    endAt: windowEnd,
  });
  const availability = unwrap(await client.get(`/tenants/${tenantId}/availability?${query}`));
  const free = availability?.available ?? 0;
  if (free > 0) {
    const blocking = await client.post(`/tenants/${tenantId}/reservations`, {
      startAt: windowStart,
      endAt: windowEnd,
      items: [{ productId: item.productId, quantity: free }],
    });
    if (!blocking.ok) fail(`Gagal membuat reservasi pemblokir — ${describeError(blocking)}`);
    const blockingId = unwrap(blocking).id;
    const confirmed = await client.post(
      `/tenants/${tenantId}/reservations/${blockingId}/confirm`,
      { note: 'QA seed: booking pemblokir periode perpanjangan' },
    );
    if (!confirmed.ok) fail(`Gagal mengonfirmasi reservasi pemblokir — ${describeError(confirmed)}`);
    log(`Reservasi pemblokir dibuat untuk ${windowStart} – ${windowEnd}.`);
  } else {
    log('Periode sasaran sudah terblokir; tidak membuat reservasi baru.');
  }

  const created = await client.post(`/tenants/${tenantId}/orders/${order.id}/extensions`, {
    requestedEndAt: windowEnd,
    note: 'QA seed: perpanjangan bentrok',
  });
  if (!created.ok) fail(`Gagal mengajukan perpanjangan — ${describeError(created)}`);
  const extension = unwrap(created);

  const approve = await client.post(
    `/tenants/${tenantId}/orders/${order.id}/extensions/${extension.id}/approve`,
    {},
  );
  if (approve.ok) {
    fail(
      'Persetujuan berhasil padahal periode sudah diblokir — konflik tidak terbentuk. ' +
        'Periksa kebijakan katalog tenant (harus SKIP_AVAILABILITY) sebelum menjalankan ulang.',
    );
  }
  if (approve.data?.error?.code !== 'AVAILABILITY_CONFLICT') {
    fail(`Persetujuan gagal karena alasan lain — ${describeError(approve)}`);
  }

  const override = await client.post(
    `/tenants/${tenantId}/orders/${order.id}/extensions/${extension.id}/override-conflict`,
    {
      reason: 'QA seed: unit pengganti dijadwalkan, konflik dipantau tim',
      riskConfirmed: true,
    },
  );
  if (!override.ok) fail(`Override konflik gagal — ${describeError(override)}`);
  log(`Konflik OPEN dibentuk untuk ${order.orderNumber ?? order.id} (${windowStart} – ${windowEnd}).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email ?? process.env.QA_SEED_EMAIL;
  const password = args.password ?? process.env.QA_SEED_PASSWORD;
  const baseUrl = args.base ?? process.env.QA_SEED_BASE_URL ?? DEFAULT_BASE_URL;
  const tenantSelector = args.tenant ?? process.env.QA_SEED_TENANT;
  const productName = args.product ?? process.env.QA_SEED_PRODUCT;

  if (!email || !password) {
    fail('Butuh kredensial: isi --email/--password atau QA_SEED_EMAIL/QA_SEED_PASSWORD.');
  }

  const client = new ApiClient(baseUrl);
  await login(client, email, password);
  const tenant = await resolveTenant(client, tenantSelector);
  log(`Tenant: ${tenant.name} (${tenant.slug}).`);

  const products = await listProducts(client, tenant.id, productName);
  const product = products[0];

  const pendingBefore = unwrap(await client.get(`/tenants/${tenant.id}/extensions?status=PENDING_APPROVAL`)) ?? [];
  const overviewBefore = unwrap(
    await client.get(`/tenants/${tenant.id}/extension-conflicts?status=OPEN`),
  );
  log(
    `Kondisi awal: antrean ${pendingBefore.length}, konflik OPEN ${overviewBefore?.summary?.openConflicts ?? 0}.`,
  );

  // Antrean perpanjangan.
  if (pendingBefore.length > 0) {
    log('Antrean perpanjangan sudah ada; tidak menambah.');
  } else {
    const order = await ensureActiveOrder(client, tenant.id, product);
    await ensurePendingExtension(client, tenant.id, order);
  }

  // Konflik OPEN.
  if ((overviewBefore?.summary?.openConflicts ?? 0) > 0) {
    log('Konflik OPEN sudah ada; tidak menambah.');
  } else {
    const active = await listActiveOrders(client, tenant.id);
    if (active.length === 0) fail('Tidak ada pesanan ACTIVE setelah seeding antrean.');
    // Pilih pesanan berbeda dari yang dipakai antrean bila tersedia, supaya
    // kedua badge tidak bergantung pada satu pesanan yang sama.
    const candidate = active.length > 1 ? active[active.length - 1] : active[0];
    const order = await loadOrder(client, tenant.id, candidate.id);
    await ensureOpenConflict(client, tenant.id, order);
  }

  // Verifikasi hasil lewat endpoint yang dibaca badge.
  const pendingAfter = unwrap(await client.get(`/tenants/${tenant.id}/extensions?status=PENDING_APPROVAL`)) ?? [];
  const overviewAfter = unwrap(
    await client.get(`/tenants/${tenant.id}/extension-conflicts?status=OPEN`),
  );
  const summary = {
    tenant: tenant.slug,
    pendingExtensions: pendingAfter.length,
    openConflicts: overviewAfter?.summary?.openConflicts ?? 0,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (summary.pendingExtensions === 0 || summary.openConflicts === 0) {
    fail('Seed selesai tetapi salah satu badge masih nol; periksa log di atas.');
  }
  log('Selesai: badge Pesanan dan Konflik perpanjangan punya angka.');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

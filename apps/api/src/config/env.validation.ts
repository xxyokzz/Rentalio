/**
 * Validasi environment saat startup.
 * Kontrak: dokumen 12 (Sprint 0, S0-05) — konfigurasi wajib yang hilang
 * menyebabkan startup gagal jelas TANPA mencetak nilai secret.
 */
export interface AppConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  /** Ukuran maksimum pool pg per instance (serverless: kecilkan, mis. 1). */
  DATABASE_POOL_MAX: number;
  /** Pepper HMAC untuk hash OTP/token. Bukan salt per-record; wajib >= 32 char. */
  HMAC_PEPPER: string;
  /** Public origin of the separate Admin Platform application; exact Origin validation for admin CSRF. */
  PLATFORM_ADMIN_BASE_URL: string;
  /** Base64-encoded 32-byte AES-GCM key dedicated to encrypt platform-admin TOTP secrets. */
  PLATFORM_ADMIN_ENCRYPTION_KEY: string;
  /** Cookie sesi: Secure aktif di production (TLS wajib). */
  COOKIE_SECURE: boolean;
  /** Allowlist origin untuk CORS + validasi Origin/Referer CSRF. */
  CORS_ORIGINS: string[];
  /**
   * Pengiriman email OTP/reset.
   * - dev-file: tulis ke folder .dev-mailbox (hanya development/test).
   * - in-memory: untuk test otomatis.
   * - resend: Resend API (wajib di production).
   */
  EMAIL_PROVIDER: 'dev-file' | 'in-memory' | 'resend';
  /** API key Resend — hanya di server, tidak pernah dicetak ke log. */
  RESEND_API_KEY?: string;
  /** Alamat pengirim; wajib domain terverifikasi di Resend untuk production. */
  EMAIL_FROM: string;
  /**
   * Nama/alias template Resend untuk email OTP. Kosong = kirim teks polos.
   * Template harus `published` di akun Resend sebelum dipakai.
   */
  RESEND_OTP_TEMPLATE?: string;
  /** Base URL publik aplikasi (untuk tautan reset password). */
  APP_BASE_URL: string;
  /**
   * Secret Vercel Cron. Kosong = endpoint /internal/cron menolak semua request.
   * Vercel mengirim `Authorization: Bearer <CRON_SECRET>`.
   */
  CRON_SECRET?: string;
  /** Token endpoint status cron; kosong = fallback ke CRON_SECRET. */
  CRON_STATUS_TOKEN?: string;
  /** Penerima alert kegagalan cron; kosong = fallback PLATFORM_OPERATOR_EMAIL. */
  CRON_ALERT_EMAIL?: string;
  /** Jeda minimum antar-alert kegagalan cron (detik). */
  CRON_ALERT_COOLDOWN_SECONDS: number;
  /** Umur maksimum run terakhir sebelum status dianggap stale (detik). */
  CRON_STALE_AFTER_SECONDS: number;
  /**
   * Pengali batas rate limit (default 1 = angka kontrak auth).
   * Dokumen 10: "Ambang maksimum request per jangka waktu ... merupakan
   * parameter konfigurasi". Nilai > 1 dipakai test agar suite biasa tidak
   * saling menghambat pada bucket IP yang sama.
   */
  RATE_LIMIT_SCALE: number;
  /** Worker outbox: nyala eksplisit (default mati, termasuk saat test). */
  OUTBOX_WORKER_ENABLED: boolean;
  OUTBOX_POLL_INTERVAL_MS: number;
  OUTBOX_BATCH_SIZE: number;
  OUTBOX_MAX_ATTEMPTS: number;
  /** Lease klaim baris; bila proses mati, baris dapat diklaim lagi setelah ini. */
  OUTBOX_LEASE_MS: number;
  OUTBOX_BACKOFF_BASE_MS: number;
  OUTBOX_BACKOFF_MAX_MS: number;
  // --- Billing langganan (QRIS dinamis) ---
  /**
   * Payload QRIS statis merchant Rentalio (string EMVCo, diawali `000201`).
   * Kosong = pembayaran langganan dinonaktifkan dan UI memakai jalur manual
   * (hubungi tim Rentalio).
   */
  PLATFORM_QRIS_STATIC_PAYLOAD?: string;
  /**
   * Harga langganan platform per periode (IDR utuh). 0 = belum diatur: endpoint
   * pembuatan tagihan menolak dengan pesan operasional, bukan mengarang harga.
   */
  SUBSCRIPTION_PRICE_AMOUNT: number;
  /** Panjang periode langganan yang ditambahkan setelah pembayaran lunas. */
  SUBSCRIPTION_PERIOD_DAYS: number;
  /** Masa berlaku tagihan QRIS (detik) sebelum tagihan lama ditutup EXPIRED. */
  SUBSCRIPTION_INVOICE_DURATION_SECONDS: number;
  /**
   * Alamat email operator platform yang menerima pengingat tagihan PENDING.
   * Kosong = pengingat dinonaktifkan (tidak ada email keluar).
   */
  PLATFORM_OPERATOR_EMAIL?: string;
  /** Job pengingat tagihan: nyala eksplisit (default mati, termasuk test). */
  BILLING_REMINDER_ENABLED: boolean;
  BILLING_REMINDER_INTERVAL_MS: number;
  BILLING_REMINDER_BATCH_SIZE: number;
  /** Umur minimum tagihan PENDING sebelum pengingat pertama dikirim. */
  BILLING_REMINDER_MIN_AGE_SECONDS: number;
  /** Jarak ke `expiresAt` yang memicu pengingat "mendekati kedaluwarsa". */
  BILLING_REMINDER_EXPIRY_WINDOW_SECONDS: number;
  /** Reconciler subscription: nyala eksplisit (default mati, termasuk test). */
  SUBSCRIPTION_RECONCILER_ENABLED: boolean;
  SUBSCRIPTION_RECONCILE_INTERVAL_MS: number;
  SUBSCRIPTION_RECONCILE_BATCH_SIZE: number;
  // --- Cloudflare R2 ---
  /** Account ID Cloudflare (dari dashboard). */
  R2_ACCOUNT_ID: string;
  /** Access Key ID R2 API token. */
  R2_ACCESS_KEY_ID: string;
  /** Secret Access Key R2 API token. */
  R2_SECRET_ACCESS_KEY: string;
  /** Nama bucket R2. */
  R2_BUCKET_NAME: string;
  /** URL publik bucket (custom domain atau r2.dev subdomain). */
  R2_PUBLIC_URL: string;
}

const REQUIRED = [
  'DATABASE_URL',
  'HMAC_PEPPER',
] as const;

export class ConfigError extends Error {}

export function validateConfig(env: NodeJS.ProcessEnv): AppConfig {
  const missing = REQUIRED.filter((k) => !env[k] || env[k]!.trim() === '');
  if (missing.length > 0) {
    throw new ConfigError(
      `Konfigurasi wajib tidak lengkap: ${missing.join(', ')}. ` +
        'Salin .env.example ke .env dan isi nilainya (lihat README).',
    );
  }

  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['NODE_ENV'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new ConfigError('NODE_ENV harus development|test|production.');
  }

  const pepper = env.HMAC_PEPPER!;
  if (pepper.length < 32) {
    throw new ConfigError('HMAC_PEPPER minimal 32 karakter.');
  }

  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('PORT harus integer 1-65535.');
  }

  const emailProvider = (env.EMAIL_PROVIDER ??
    (nodeEnv === 'test' ? 'in-memory' : 'dev-file')) as AppConfig['EMAIL_PROVIDER'];
  if (!['dev-file', 'in-memory', 'resend'].includes(emailProvider)) {
    throw new ConfigError('EMAIL_PROVIDER harus dev-file|in-memory|resend.');
  }
  if (nodeEnv === 'production' && emailProvider !== 'resend') {
    throw new ConfigError(
      'Di production EMAIL_PROVIDER harus resend (dev-file/in-memory tidak diizinkan).',
    );
  }

  const resendApiKey = env.RESEND_API_KEY?.trim() || undefined;
  if (emailProvider === 'resend' && !resendApiKey) {
    throw new ConfigError(
      'EMAIL_PROVIDER=resend membutuhkan RESEND_API_KEY (lihat .env.example).',
    );
  }

  const emailFrom =
    env.EMAIL_FROM?.trim() || 'Rentalio <onboarding@resend.dev>';
  if (!/^.+<[^@\s]+@[^@\s]+>$/.test(emailFrom) && !/^[^@\s]+@[^@\s]+$/.test(emailFrom)) {
    throw new ConfigError(
      'EMAIL_FROM harus berupa alamat email atau format "Nama <alamat@domain>".',
    );
  }

  const corsOrigins = (env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (corsOrigins.length === 0) {
    throw new ConfigError('CORS_ORIGINS minimal satu origin.');
  }

  const platformAdminBaseUrl = env.PLATFORM_ADMIN_BASE_URL ?? 'http://localhost:3002';
  let parsedAdminOrigin: URL;
  try {
    parsedAdminOrigin = new URL(platformAdminBaseUrl);
  } catch {
    throw new ConfigError('PLATFORM_ADMIN_BASE_URL harus berupa origin HTTP(S) yang valid.');
  }
  if (!['http:', 'https:'].includes(parsedAdminOrigin.protocol) || parsedAdminOrigin.origin !== platformAdminBaseUrl) {
    throw new ConfigError('PLATFORM_ADMIN_BASE_URL harus berupa origin HTTP(S) tanpa path.');
  }
  if (nodeEnv === 'production' && parsedAdminOrigin.protocol !== 'https:') {
    throw new ConfigError('PLATFORM_ADMIN_BASE_URL harus HTTPS di production.');
  }
  const adminEncryptionKeyText = env.PLATFORM_ADMIN_ENCRYPTION_KEY?.trim();
  const adminEncryptionKey = adminEncryptionKeyText ? Buffer.from(adminEncryptionKeyText, 'base64') : null;
  if (adminEncryptionKey && adminEncryptionKey.length !== 32) {
    throw new ConfigError('PLATFORM_ADMIN_ENCRYPTION_KEY harus base64 dari tepat 32 byte.');
  }
  if (nodeEnv === 'production' && !adminEncryptionKey) {
    throw new ConfigError('PLATFORM_ADMIN_ENCRYPTION_KEY wajib tersedia di production.');
  }
  const rateLimitScale = Number(env.RATE_LIMIT_SCALE ?? '1');
  if (!Number.isFinite(rateLimitScale) || rateLimitScale < 1 || rateLimitScale > 1_000_000) {
    throw new ConfigError('RATE_LIMIT_SCALE harus angka 1..1000000.');
  }

  const intEnv = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    const value = raw == null || raw.trim() === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ConfigError(`${name} harus integer ${min}..${max}.`);
    }
    return value;
  };

  // Vercel menjalankan banyak instance function; pool per instance harus kecil
  // karena Supabase transaction pooler yang membagi koneksi ke Postgres.
  const databasePoolMax = intEnv('DATABASE_POOL_MAX', 10, 1, 50);
  const cronSecret = env.CRON_SECRET?.trim() || undefined;
  const cronStatusToken = env.CRON_STATUS_TOKEN?.trim() || undefined;
  const cronAlertEmail = env.CRON_ALERT_EMAIL?.trim() || undefined;
  if (cronAlertEmail && !/^[^@\s]+@[^@\s]+$/.test(cronAlertEmail)) {
    throw new ConfigError('CRON_ALERT_EMAIL harus berupa alamat email yang valid.');
  }
  const cronAlertCooldownSeconds = intEnv(
    'CRON_ALERT_COOLDOWN_SECONDS',
    3_600,
    60,
    86_400,
  );
  const cronStaleAfterSeconds = intEnv('CRON_STALE_AFTER_SECONDS', 300, 60, 86_400);

  const outboxWorkerEnabled = env.OUTBOX_WORKER_ENABLED === 'true';
  const outboxPollIntervalMs = intEnv('OUTBOX_POLL_INTERVAL_MS', 5_000, 100, 3_600_000);
  const outboxBatchSize = intEnv('OUTBOX_BATCH_SIZE', 20, 1, 500);
  const outboxMaxAttempts = intEnv('OUTBOX_MAX_ATTEMPTS', 5, 1, 100);
  const outboxLeaseMs = intEnv('OUTBOX_LEASE_MS', 60_000, 1_000, 3_600_000);
  const outboxBackoffBaseMs = intEnv('OUTBOX_BACKOFF_BASE_MS', 5_000, 100, 3_600_000);
  const outboxBackoffMaxMs = intEnv('OUTBOX_BACKOFF_MAX_MS', 300_000, 1_000, 3_600_000);

  // QRIS dinamis: platform hanya menyimpan satu QRIS statis milik merchant.
  // Validasi format dangkal di sini menangkap salah tempel sejak startup;
  // validasi CRC/tag lengkap dilakukan QrisService saat tagihan dibuat.
  const qrisStaticPayload = env.PLATFORM_QRIS_STATIC_PAYLOAD?.trim() || undefined;
  if (qrisStaticPayload) {
    if (qrisStaticPayload.length < 20 || !qrisStaticPayload.startsWith('000201')) {
      throw new ConfigError(
        'PLATFORM_QRIS_STATIC_PAYLOAD harus payload QRIS EMVCo yang diawali "000201" ' +
          'dan minimal 20 karakter.',
      );
    }
  }
  const subscriptionInvoiceDurationSeconds = intEnv(
    'SUBSCRIPTION_INVOICE_DURATION_SECONDS',
    86_400,
    300,
    604_800,
  );
  const subscriptionPriceAmount = intEnv('SUBSCRIPTION_PRICE_AMOUNT', 0, 0, 1_000_000_000_000);
  const subscriptionPeriodDays = intEnv('SUBSCRIPTION_PERIOD_DAYS', 30, 1, 366);

  const operatorEmail = env.PLATFORM_OPERATOR_EMAIL?.trim() || undefined;
  if (operatorEmail && !/^[^@\s]+@[^@\s]+$/.test(operatorEmail)) {
    throw new ConfigError('PLATFORM_OPERATOR_EMAIL harus berupa alamat email yang valid.');
  }
  const billingReminderEnabled = env.BILLING_REMINDER_ENABLED === 'true';
  const billingReminderIntervalMs = intEnv(
    'BILLING_REMINDER_INTERVAL_MS',
    300_000,
    1_000,
    3_600_000,
  );
  const billingReminderBatchSize = intEnv('BILLING_REMINDER_BATCH_SIZE', 50, 1, 500);
  const billingReminderMinAgeSeconds = intEnv(
    'BILLING_REMINDER_MIN_AGE_SECONDS',
    600,
    0,
    604_800,
  );
  const billingReminderExpiryWindowSeconds = intEnv(
    'BILLING_REMINDER_EXPIRY_WINDOW_SECONDS',
    3_600,
    60,
    604_800,
  );

  const subscriptionReconcilerEnabled =
    env.SUBSCRIPTION_RECONCILER_ENABLED === 'true';
  const subscriptionReconcileIntervalMs = intEnv(
    'SUBSCRIPTION_RECONCILE_INTERVAL_MS',
    900_000,
    1_000,
    3_600_000,
  );
  const subscriptionReconcileBatchSize = intEnv(
    'SUBSCRIPTION_RECONCILE_BATCH_SIZE',
    200,
    1,
    1_000,
  );

  return {
    NODE_ENV: nodeEnv,
    PORT: port,
    DATABASE_URL: env.DATABASE_URL!,
    DATABASE_POOL_MAX: databasePoolMax,
    HMAC_PEPPER: pepper,
    COOKIE_SECURE:
      env.COOKIE_SECURE != null
        ? env.COOKIE_SECURE === 'true'
        : nodeEnv === 'production',
    CORS_ORIGINS: corsOrigins,
    EMAIL_PROVIDER: emailProvider,
    RESEND_API_KEY: resendApiKey,
    EMAIL_FROM: emailFrom,
    RESEND_OTP_TEMPLATE: env.RESEND_OTP_TEMPLATE?.trim() || 'verifrentalio-resend',
    APP_BASE_URL: env.APP_BASE_URL ?? 'http://localhost:3001',
    PLATFORM_ADMIN_BASE_URL: platformAdminBaseUrl,
    PLATFORM_ADMIN_ENCRYPTION_KEY: adminEncryptionKeyText ?? Buffer.alloc(32).toString('base64'),
    CRON_SECRET: cronSecret,
    CRON_STATUS_TOKEN: cronStatusToken,
    CRON_ALERT_EMAIL: cronAlertEmail,
    CRON_ALERT_COOLDOWN_SECONDS: cronAlertCooldownSeconds,
    CRON_STALE_AFTER_SECONDS: cronStaleAfterSeconds,
    RATE_LIMIT_SCALE: rateLimitScale,
    OUTBOX_WORKER_ENABLED: outboxWorkerEnabled,
    OUTBOX_POLL_INTERVAL_MS: outboxPollIntervalMs,
    OUTBOX_BATCH_SIZE: outboxBatchSize,
    OUTBOX_MAX_ATTEMPTS: outboxMaxAttempts,
    OUTBOX_LEASE_MS: outboxLeaseMs,
    OUTBOX_BACKOFF_BASE_MS: outboxBackoffBaseMs,
    OUTBOX_BACKOFF_MAX_MS: outboxBackoffMaxMs,
    PLATFORM_QRIS_STATIC_PAYLOAD: qrisStaticPayload,
    SUBSCRIPTION_PRICE_AMOUNT: subscriptionPriceAmount,
    SUBSCRIPTION_PERIOD_DAYS: subscriptionPeriodDays,
    SUBSCRIPTION_INVOICE_DURATION_SECONDS: subscriptionInvoiceDurationSeconds,
    PLATFORM_OPERATOR_EMAIL: operatorEmail,
    BILLING_REMINDER_ENABLED: billingReminderEnabled,
    BILLING_REMINDER_INTERVAL_MS: billingReminderIntervalMs,
    BILLING_REMINDER_BATCH_SIZE: billingReminderBatchSize,
    BILLING_REMINDER_MIN_AGE_SECONDS: billingReminderMinAgeSeconds,
    BILLING_REMINDER_EXPIRY_WINDOW_SECONDS: billingReminderExpiryWindowSeconds,
    SUBSCRIPTION_RECONCILER_ENABLED: subscriptionReconcilerEnabled,
    SUBSCRIPTION_RECONCILE_INTERVAL_MS: subscriptionReconcileIntervalMs,
    SUBSCRIPTION_RECONCILE_BATCH_SIZE: subscriptionReconcileBatchSize,
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID?.trim() ?? '',
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID?.trim() ?? '',
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY?.trim() ?? '',
    R2_BUCKET_NAME: env.R2_BUCKET_NAME?.trim() ?? '',
    R2_PUBLIC_URL: env.R2_PUBLIC_URL?.trim() ?? '',
  };
}

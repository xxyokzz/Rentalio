import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config/env.validation.js';
import { redact } from '../common/redact.js';
import { StructuredLogger } from '../common/logger.service.js';
import { EmailService } from '../email/email.service.js';

/**
 * Peringatan dini kegagalan server pada endpoint API.
 *
 * Latar belakang: insiden produksi berupa HTTP 500 intermiten pada endpoint
 * tenant (`products`, `orders`, `reservations`) yang disebabkan `P2028`
 * (antrean transaksi database). Gejalanya hanya muncul saat beberapa request
 * paralel dan dilaporkan pengguna sebelum ada sinyal apa pun.
 *
 * Setiap 5xx dicatat sebagai satu baris log terstruktur `api_failure_alert`
 * (bisa langsung dipakai alert log collector), dan kegagalan pertama pada satu
 * jendela cooldown juga dikirim sebagai email ke operator. Pengiriman email
 * dibatasi per instance: Vercel menjalankan beberapa instance, jadi satu
 * kegagalan dapat menghasilkan lebih dari satu email — itu disengaja agar alert
 * tetap keluar walau instance lain tidak pernah menerima request gagal.
 *
 * Service ini tidak boleh menggagalkan response: pemanggil tidak menunggu dan
 * semua error internal ditelan (dicatat sebagai `api_alert_failed`).
 */
/** Batas waktu kirim email; kegagalan Resend tidak boleh menahan request. */
const SEND_TIMEOUT_MS = 5_000;
const TRANSACTION_QUEUE_CODES = new Set(['P2028']);
const TRANSACTION_QUEUE_MESSAGE = /P2028|Unable to start a transaction/i;

@Injectable()
export class ApiFailureAlertService {
  private lastAlertAtMs = 0;
  private suppressedSinceLastAlert = 0;

  constructor(
    @Inject('APP_CONFIG') private readonly config: AppConfig,
    private readonly logger: StructuredLogger,
    private readonly email: EmailService,
  ) {}

  /**
   * Laporkan satu response gagal. Status < 500 diabaikan (4xx bukan
   * kegagalan sistem). Selalu resolve; tidak pernah melempar.
   */
  async report(input: ApiFailureAlertInput): Promise<void> {
    try {
      await this.reportInternal(input);
    } catch (error) {
      this.logger.error('api_alert_failed', { error: errorMessage(error) });
    }
  }

  private async reportInternal(input: ApiFailureAlertInput): Promise<void> {
    if (input.status < 500) return;

    const failure = describeFailure(input.error);
    const path = sanitizePath(input.path);
    const fields = {
      status: input.status,
      code: input.code,
      method: input.method,
      path,
      correlationId: input.correlationId,
      userId: input.userId ?? undefined,
      tenantSlug: input.tenantSlug ?? undefined,
      failureKind: failure.kind,
      prismaCode: failure.prismaCode,
      error: failure.message,
    };

    // Satu baris per kegagalan: log collector dapat memberi alert real-time
    // tanpa menunggu email, dan email hanya pembawa ringkasan pertama.
    this.logger.error('api_failure_alert', fields);

    const recipient =
      this.config.API_ALERT_EMAIL ?? this.config.PLATFORM_OPERATOR_EMAIL;
    if (!recipient) {
      this.logger.warn('api_alert_skipped', {
        reason: 'API_ALERT_EMAIL/PLATFORM_OPERATOR_EMAIL kosong',
        failureKind: failure.kind,
      });
      return;
    }

    const cooldownMs = this.config.API_ALERT_COOLDOWN_SECONDS * 1_000;
    const now = Date.now();
    if (this.lastAlertAtMs > 0 && now - this.lastAlertAtMs < cooldownMs) {
      this.suppressedSinceLastAlert += 1;
      this.logger.warn('api_alert_suppressed', {
        reason: 'cooldown',
        failureKind: failure.kind,
        suppressedSinceLastAlert: this.suppressedSinceLastAlert,
        retryAfterMs: this.lastAlertAtMs + cooldownMs - now,
      });
      return;
    }

    const suppressedSincePreviousAlert = this.suppressedSinceLastAlert;
    await withTimeout(
      this.email.send({
        to: recipient,
        subject: formatSubject(input.status, failure.kind, input.method, path),
        body: formatBody({
          ...input,
          path,
          failure,
          suppressedSincePreviousAlert,
          cooldownSeconds: this.config.API_ALERT_COOLDOWN_SECONDS,
        }),
      }),
      SEND_TIMEOUT_MS,
    );

    this.lastAlertAtMs = Date.now();
    this.suppressedSinceLastAlert = 0;
    this.logger.info('api_alert_sent', {
      status: input.status,
      failureKind: failure.kind,
      prismaCode: failure.prismaCode,
      correlationId: input.correlationId,
      suppressedSincePreviousAlert,
    });
  }

  /** Hanya untuk test: apakah jendela cooldown sedang aktif. */
  get lastAlertAt(): number {
    return this.lastAlertAtMs;
  }
}

export type ApiFailureKind = 'transaction_queue' | 'server_error';

export interface ApiFailureAlertInput {
  /** Status HTTP yang dikirim ke klien (hanya >= 500 yang dilaporkan). */
  status: number;
  /** Kode error kontrak (`INTERNAL_ERROR`, `PAYMENT_PROVIDER_ERROR`, …). */
  code: string;
  method: string;
  path: string;
  correlationId: string;
  userId?: string | null;
  tenantSlug?: string | null;
  /** Exception asli; dipakai untuk mengenali P2028 dan pesan akar masalah. */
  error?: unknown;
}

interface FailureDescription {
  kind: ApiFailureKind;
  prismaCode?: string;
  message: string;
}

/**
 * Telusuri rantai `cause`/`meta` Prisma untuk menemukan kode dan pesan akar
 * masalah. Kegagalan transaksi sering terbungkus (`PrismaClientUnknownRequestError`
 * dengan `cause` driver adapter), jadi hanya `error.code` teratas tidak cukup.
 */
function describeFailure(error: unknown): FailureDescription {
  let prismaCode: string | undefined;
  let message = '';
  let transactionQueue = false;

  const visited = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const candidate = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      meta?: { code?: unknown; driverAdapterError?: unknown };
    };

    if (typeof candidate.message === 'string') {
      if (!message) message = candidate.message;
      if (TRANSACTION_QUEUE_MESSAGE.test(candidate.message)) {
        transactionQueue = true;
      }
    }

    const code =
      typeof candidate.code === 'string'
        ? candidate.code
        : typeof candidate.meta?.code === 'string'
          ? candidate.meta.code
          : undefined;
    if (code && !prismaCode) prismaCode = code;
    if (code && TRANSACTION_QUEUE_CODES.has(code)) {
      transactionQueue = true;
    }

    pending.push(candidate.cause);
    pending.push(candidate.meta?.driverAdapterError);
  }

  return {
    kind: transactionQueue ? 'transaction_queue' : 'server_error',
    ...(prismaCode ? { prismaCode } : {}),
    message: redactText(message),
  };
}

/** Portal order memakai token di path — jangan pernah masuk log/email. */
function sanitizePath(path: string): string {
  return path.replace(
    /^(\/api\/v1)?\/portal\/orders\/[^/]+/,
    '$1/portal/orders/[redacted]',
  );
}

function redactText(value: string): string {
  const redacted = redact(value);
  return typeof redacted === 'string' ? redacted : String(redacted);
}

function formatSubject(
  status: number,
  kind: ApiFailureKind,
  method: string,
  path: string,
): string {
  const label =
    kind === 'transaction_queue'
      ? 'antrean transaksi database'
      : 'kesalahan server';
  const endpoint = `${method} ${path}`;
  return `[Rentalio] API ${status} (${label}): ${endpoint}`.slice(0, 200);
}

function formatBody(input: {
  status: number;
  code: string;
  method: string;
  path: string;
  correlationId: string;
  userId?: string | null;
  tenantSlug?: string | null;
  failure: FailureDescription;
  suppressedSincePreviousAlert: number;
  cooldownSeconds: number;
}): string {
  const lines = [
    'Kegagalan server terdeteksi pada API Rentalio.',
    '',
    `Waktu         : ${new Date().toISOString()}`,
    `Status        : ${input.status} ${input.code}`,
    `Jenis         : ${
      input.failure.kind === 'transaction_queue'
        ? 'antrean transaksi database (P2028)'
        : 'kesalahan server'
    }`,
    `Endpoint      : ${input.method} ${input.path}`,
    `Correlation ID: ${input.correlationId}`,
    `Tenant        : ${input.tenantSlug ?? '-'}`,
    `Pengguna      : ${input.userId ?? '-'}`,
    `Kode Prisma   : ${input.failure.prismaCode ?? '-'}`,
    `Pesan         : ${input.failure.message || '-'}`,
    '',
    'Langkah awal:',
    '1. Cek log dengan correlation ID di atas untuk stack trace lengkap.',
    '2. Bila jenisnya antrean transaksi (P2028), periksa DATABASE_POOL_MAX dan',
    '   beban request paralel pada instance tersebut.',
    '3. Ulangi request yang sama setelah penyebabnya hilang.',
    '',
    `Email ini dikirim maksimal sekali per ${input.cooldownSeconds} detik per instance.`,
  ];
  if (input.suppressedSincePreviousAlert > 0) {
    lines.push(
      `Kegagalan serupa yang diredam sebelum email ini: ${input.suppressedSincePreviousAlert}.`,
    );
  }
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

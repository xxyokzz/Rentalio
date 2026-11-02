import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { hmac } from '../common/crypto.js';
import type { AppConfig } from '../config/env.validation.js';

/**
 * Rate limit store PostgreSQL (keputusan final parameter auth 14 Okt 2026 #13):
 * transaksi/operasi atomik, expiry/cleanup, identifier HMAC ber-key,
 * abstraksi memungkinkan pindah ke Redis kelak tanpa mengubah kontrak API.
 */
export interface RateLimitRule {
  bucket: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

@Injectable()
export class RateLimitService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  /**
   * Hitung satu request pada bucket. Fixed window per (bucket, identifier).
   * Identifier di-hash dengan pepper — IP/email mentah tidak disimpan.
   */
  async consume(rule: RateLimitRule, identifier: string): Promise<RateLimitResult> {
    // Angka batas mengikuti kontrak auth × RATE_LIMIT_SCALE (parameter
    // konfigurasi; default 1 sehingga perilaku produksi = kontrak dokumen).
    const limit = Math.max(
      1,
      Math.round(rule.limit * this.config.RATE_LIMIT_SCALE),
    );
    const idHash = hmac(identifier, this.config.HMAC_PEPPER);
    const now = new Date();
    const windowIndex = Math.floor(now.getTime() / 1000 / rule.windowSeconds);
    const windowStartSec = windowIndex * rule.windowSeconds;
    const windowStart = new Date(windowStartSec * 1000);
    const windowEnd = new Date((windowStartSec + rule.windowSeconds) * 1000);

    // Upsert atomik: INSERT ... ON CONFLICT DO UPDATE SET count = count + 1
    const rows = await this.prisma.client.$queryRaw<{ count: number }[]>`
      INSERT INTO rate_limit_counters (id, bucket, identifier, "windowStart", "windowEnd", count, "createdAt")
      VALUES (${randomUUID()}::uuid, ${rule.bucket}, ${idHash}, ${windowStart}, ${windowEnd}, 1, ${now})
      ON CONFLICT ("bucket", identifier, "windowStart")
      DO UPDATE SET count = rate_limit_counters.count + 1
      RETURNING count
    `;
    const count = rows[0]?.count ?? 1;

    // Cleanup ringan: buang window yang sudah lewat (aman diulang).
    await this.prisma.client.$executeRaw`
      DELETE FROM rate_limit_counters WHERE "windowEnd" < ${now}
    `;

    const allowed = count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: allowed
        ? 0
        : Math.ceil((windowEnd.getTime() - now.getTime()) / 1000),
    };
  }
}

/**
 * Bucket rate limit auth (keputusan final parameter auth, 14 Okt 2026):
 * signup 5/IP/jam & 3/email/jam; resend 10/IP/jam & 3/email/15 menit;
 * verify 10/IP/15 menit & 5/email/15 menit (+ 5 percobaan per OTP);
 * login 10/IP/15 menit & 5/akun/15 menit;
 * reset request 10/IP/jam & 3/email/jam; reset complete 10/IP/15 menit.
 */
export const AUTH_RATE_LIMITS = {
  signupIp: { bucket: 'auth.signup:ip', limit: 5, windowSeconds: 3600 },
  signupEmail: { bucket: 'auth.signup:email', limit: 3, windowSeconds: 3600 },
  resendIp: { bucket: 'auth.resend:ip', limit: 10, windowSeconds: 3600 },
  resendEmail: { bucket: 'auth.resend:email', limit: 3, windowSeconds: 900 },
  verifyIp: { bucket: 'auth.verify:ip', limit: 10, windowSeconds: 900 },
  verifyEmail: { bucket: 'auth.verify:email', limit: 5, windowSeconds: 900 },
  loginIp: { bucket: 'auth.login:ip', limit: 10, windowSeconds: 900 },
  loginAccount: { bucket: 'auth.login:account', limit: 5, windowSeconds: 900 },
  resetRequestIp: { bucket: 'auth.reset-request:ip', limit: 10, windowSeconds: 3600 },
  resetRequestEmail: { bucket: 'auth.reset-request:email', limit: 3, windowSeconds: 3600 },
  resetCompleteIp: { bucket: 'auth.reset-complete:ip', limit: 10, windowSeconds: 900 },
  /** Penerimaan undangan staf: token rahasia 256-bit; batas menjaga brute force. */
  invitationAcceptIp: { bucket: 'auth.invitation-accept:ip', limit: 20, windowSeconds: 900 },
} as const;

/**
 * Bucket rate limit alur publik (Notion 04: "Terapkan rate limit pada login,
 * booking publik, portal token, dan webhook"). Nilai adalah baseline awal;
 * bukan hasil load test.
 */
export const PUBLIC_RATE_LIMITS = {
  catalogIp: { bucket: 'public.catalog:ip', limit: 120, windowSeconds: 60 },
  /** Resolusi hostname kustom dipanggil server-side per request halaman. */
  hostIp: { bucket: 'public.host:ip', limit: 120, windowSeconds: 60 },
  availabilityIp: { bucket: 'public.availability:ip', limit: 60, windowSeconds: 60 },
  bookingIp: { bucket: 'public.booking:ip', limit: 10, windowSeconds: 3600 },
  bookingTenant: { bucket: 'public.booking:tenant', limit: 60, windowSeconds: 3600 },
  portalIp: { bucket: 'public.portal:ip', limit: 60, windowSeconds: 60 },
} as const;

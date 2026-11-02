import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EmailService } from '../email/email.service.js';
import { RateLimitService, AUTH_RATE_LIMITS } from '../rate-limit/rate-limit.service.js';
import {
  constantTimeEqual,
  generateOtp,
  hashPassword,
  hashToken,
  hmac,
  randomToken,
  verifyPassword,
} from '../common/crypto.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { AppConfig } from '../config/env.validation.js';

// --- Parameter autentikasi (keputusan final 14 Okt 2026) ---
const OTP_TTL_MS = 10 * 60 * 1000; // 10 menit
const OTP_MAX_ATTEMPTS = 5; // 5 percobaan per OTP
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 detik
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 menit
const SESSION_ABSOLUTE_MS = 7 * 24 * 3600 * 1000; // 7 hari
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 menit
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

export const SESSION_COOKIE = 'rentalio_session';

export interface SessionIssued {
  token: string;
  csrfToken: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

/** Profil pendaftaran OWNER yang ikut respons login & sesi (prefill onboarding). */
export interface SessionProfile {
  ownerName: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
}

export interface SessionInfo {
  id: string;
  userId: string;
  email: string;
  /** Prefill pendaftaran OWNER (dokumen 04) — dipakai onboarding; null bila tidak diisi. */
  ownerName: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertPasswordPolicy(password: string): void {
  // Kontrak: min 12, maks 128; tanpa pola campuran wajib; jangan trim.
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new ApiError(
      ErrorCode.VALIDATION_ERROR,
      `Password harus ${PASSWORD_MIN}-${PASSWORD_MAX} karakter.`,
    );
  }
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly rateLimit: RateLimitService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  private hashSecret(value: string): string {
    return hmac(value, this.config.HMAC_PEPPER);
  }

  // ============================================================
  // Pendaftaran OWNER + OTP email
  // ============================================================

  async register(
    input: {
      email: string;
      password: string;
      ownerName?: string;
      tenantName?: string;
      tenantSlug?: string;
      /** Bukti persetujuan legal (dokumen 04): versi + waktu penerimaan. */
      termsVersion: string;
      privacyVersion: string;
    },
    ctx: { ip: string; correlationId: string },
  ): Promise<{ status: 202 }> {
    const email = normalizeEmail(input.email);
    // Normalisasi prefill onboarding: slug diseragamkan seperti
    // `TenantService.createTenant` (lowercase + trim), nama cukup di-trim;
    // string kosong diperlakukan sebagai "tidak diisi".
    const ownerName = input.ownerName?.trim() || null;
    const tenantName = input.tenantName?.trim() || null;
    const tenantSlug = input.tenantSlug?.trim().toLowerCase() || null;
    const consent = {
      termsConsentVersion: input.termsVersion,
      privacyConsentVersion: input.privacyVersion,
      legalConsentAt: new Date(),
    };

    const rlIp = await this.rateLimit.consume(AUTH_RATE_LIMITS.signupIp, ctx.ip);
    if (!rlIp.allowed) throw this.rateLimited(rlIp.retryAfterSeconds);
    const rlEmail = await this.rateLimit.consume(AUTH_RATE_LIMITS.signupEmail, email);
    if (!rlEmail.allowed) throw this.rateLimited(rlEmail.retryAfterSeconds);

    assertPasswordPolicy(input.password);

    // Respons generik anti-enumerasi: sukses maupun email sudah terdaftar
    // menghasilkan 202 identik; OTP hanya dikirim bila akun belum terverifikasi.
    const existing = await this.prisma.client.user.findUnique({ where: { email } });
    if (!existing) {
      const passwordHash = hashPassword(input.password);
      await this.prisma.client.user.create({
        data: {
          email,
          passwordHash,
          status: 'PENDING_VERIFICATION',
          ownerName,
          tenantName,
          tenantSlug,
          ...consent,
        },
      });
      await this.issueOtp(email, ctx.correlationId, null);
      await this.audit.record({
        action: 'OWNER_SIGNUP_STARTED',
        domain: 'auth',
        correlationId: ctx.correlationId,
        metadata: {
          emailHash: this.hashSecret(email),
          termsVersion: consent.termsConsentVersion,
          privacyVersion: consent.privacyConsentVersion,
        },
      });
    } else if (existing.status === 'PENDING_VERIFICATION') {
      // Akun pending: terbitkan ulang OTP (membatalkan kode lama).
      // Persetujuan terbaru yang dicatat — versi dokumen yang benar-benar
      // dilihat pemilik pada percobaan pendaftaran terakhir.
      await this.prisma.client.user.update({
        where: { id: existing.id },
        data: {
          ...consent,
          // Data profil dari percobaan pendaftaran terakhir yang paling baru
          // diisi; `undefined` (tidak dikirim) mempertahankan nilai lama.
          ownerName: ownerName ?? undefined,
          tenantName: tenantName ?? undefined,
          tenantSlug: tenantSlug ?? undefined,
        },
      });
      await this.issueOtp(email, ctx.correlationId, existing.id);
      await this.audit.record({
        action: 'OWNER_SIGNUP_STARTED',
        domain: 'auth',
        actorUserId: existing.id,
        correlationId: ctx.correlationId,
        metadata: {
          emailHash: this.hashSecret(email),
          reissued: true,
          termsVersion: consent.termsConsentVersion,
          privacyVersion: consent.privacyConsentVersion,
        },
      });
    } else {
      // Email terdaftar aktif: audit saja, respons tetap generik.
      await this.audit.record({
        action: 'OWNER_SIGNUP_STARTED',
        domain: 'auth',
        actorUserId: existing.id,
        correlationId: ctx.correlationId,
        metadata: { emailHash: this.hashSecret(email), alreadyRegistered: true },
      });
    }
    return { status: 202 };
  }

  private async issueOtp(
    email: string,
    correlationId: string,
    userId: string | null,
  ): Promise<void> {
    const user =
      userId != null
        ? await this.prisma.client.user.findUniqueOrThrow({ where: { id: userId } })
        : await this.prisma.client.user.findUniqueOrThrow({ where: { email } });

    const now = new Date();
    const latest = await this.prisma.client.emailVerificationChallenge.findFirst({
      where: { email, purpose: 'OWNER_SIGNUP_EMAIL_VERIFICATION' },
      orderBy: { createdAt: 'desc' },
    });

    // Cooldown resend: hanya relevan bila OTP aktif masih berlaku.
    if (
      latest &&
      latest.consumedAt == null &&
      latest.invalidatedAt == null &&
      latest.expiresAt > now &&
      now.getTime() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      // Resend terlalu cepat: jangan terbitkan kode baru, jangan kirim email.
      await this.audit.record({
        action: 'OWNER_EMAIL_OTP_RESENT',
        domain: 'auth',
        actorUserId: user.id,
        correlationId,
        metadata: { outcome: 'cooldown' },
      });
      return;
    }

    const otp = generateOtp();
    await this.prisma.client.$transaction(async (tx) => {
      // Resend menginvalidasi challenge aktif sebelumnya (atomic swap).
      await tx.emailVerificationChallenge.updateMany({
        where: {
          email,
          purpose: 'OWNER_SIGNUP_EMAIL_VERIFICATION',
          consumedAt: null,
          invalidatedAt: null,
        },
        data: { invalidatedAt: new Date() },
      });
      await tx.emailVerificationChallenge.create({
        data: {
          userId: user.id,
          email,
          purpose: 'OWNER_SIGNUP_EMAIL_VERIFICATION',
          otpHash: this.hashSecret(`${email}:OWNER_SIGNUP:${otp}`),
          expiresAt: new Date(Date.now() + OTP_TTL_MS),
          nextResendAt: new Date(Date.now() + OTP_RESEND_COOLDOWN_MS),
        },
      });
    });

    // Isi email (teks + variabel template OTP) disusun EmailService agar jalur
    // registrasi dan test e2e memakai komposisi yang sama.
    await this.email.sendOtp({
      to: email,
      code: otp,
      recipientName: user.ownerName,
      expiresInMinutes: OTP_TTL_MS / 60_000,
    });

    await this.audit.record({
      action: 'OWNER_EMAIL_VERIFICATION_SENT',
      domain: 'auth',
      actorUserId: user.id,
      correlationId,
      metadata: { emailHash: this.hashSecret(email) },
    });
  }

  async verifyEmail(
    input: { email: string; code: string },
    ctx: { ip: string; correlationId: string },
  ): Promise<{ status: 204 }> {
    const email = normalizeEmail(input.email);

    const rlIp = await this.rateLimit.consume(AUTH_RATE_LIMITS.verifyIp, ctx.ip);
    if (!rlIp.allowed) throw this.rateLimited(rlIp.retryAfterSeconds);
    const rlEmail = await this.rateLimit.consume(AUTH_RATE_LIMITS.verifyEmail, email);
    if (!rlEmail.allowed) throw this.rateLimited(rlEmail.retryAfterSeconds);

    // Konsumsi atomik: satu OTP hanya dapat dipakai sekali, termasuk paralel.
    let transactionResult: { ok: boolean; userId?: string; reason?: string } = { ok: true };

    // Capture user's existing tenant fields before transaction
    // These will be used inside the transaction since input (VerifyEmailDto) only has email+code
    const userBeforeTx = await this.prisma.client.user.findUnique({
      where: { email },
      select: {
        id: true,
        ownerName: true,
        tenantName: true,
        tenantSlug: true,
      },
    });

    try {
      transactionResult = await this.prisma.client.$transaction(
        async (tx) => {
          const challenge = await tx.emailVerificationChallenge.findFirst({
            where: {
              email,
              purpose: 'OWNER_SIGNUP_EMAIL_VERIFICATION',
              consumedAt: null,
              invalidatedAt: null,
            },
            orderBy: { createdAt: 'desc' },
          });

          const now = new Date();
          if (
            !challenge ||
            challenge.expiresAt <= now ||
            challenge.attemptCount >= OTP_MAX_ATTEMPTS
          ) {
            return { ok: false, reason: 'missing_or_expired' };
          }

          const expected = this.hashSecret(
            `${email}:OWNER_SIGNUP:${input.code}`,
          );
          const matches = constantTimeEqual(challenge.otpHash, expected);

          const updated = await tx.emailVerificationChallenge.update({
            where: { id: challenge.id },
            data: { attemptCount: { increment: 1 } },
          });

          if (!matches) {
            return {
              ok: false,
              reason:
                updated.attemptCount >= OTP_MAX_ATTEMPTS
                  ? 'attempts_exhausted'
                  : 'mismatch',
            };
          }

          // Atomic consume: kondisi consumedAt null pada where mencegah double-use.
          const consumed = await tx.emailVerificationChallenge.updateMany({
            where: { id: challenge.id, consumedAt: null },
            data: { consumedAt: now },
          });
          if (consumed.count === 0) {
            return { ok: false, reason: 'already_used' };
          }

          await tx.user.update({
            where: { id: challenge.userId },
            data: { status: 'ACTIVE', emailVerifiedAt: now },
          });

          // Verifikasi email hanya mengaktifkan akun dan menyimpan profil
          // pendaftaran. Tenant TIDAK dibuat di sini: satu-satunya jalur
          // pembuatan tenant adalah `TenantService.createTenant` (POST /tenants),
          // yang sekaligus memulai trial 72 jam, membuat subscription TRIALING,
          // dan men-seed 9 template WhatsApp bawaan.
          //
          // Tenant yang dibuat inline di sini sebelumnya tidak punya entitlement
          // sama sekali: tanpa `activatedAt`/`trialEndsAt` dan tanpa baris
          // subscription, `SubscriptionPolicyService` mengembalikan
          // `NO_ENTITLEMENT` sehingga SEMUA mutasi katalog/booking/order ditolak
          // 403 TENANT_RESTRICTED, dan halaman onboarding (yang hanya tampil saat
          // actor belum punya tenant) tidak pernah tercapai.
          await tx.user.update({
            where: { id: challenge.userId },
            data: {
              // Disimpan sebagai data pendaftaran untuk prefill onboarding.
              ownerName: userBeforeTx?.ownerName ?? undefined,
              tenantName: userBeforeTx?.tenantName ?? undefined,
              tenantSlug: userBeforeTx?.tenantSlug ?? undefined,
            },
          });

          return { ok: true, userId: challenge.userId };
        },
        {
          // Prisma transaction options if needed
        },
      );
    } catch (err) {
      // Kegagalan nyata (DB/RLS/constraint) tidak boleh disamarkan menjadi
      // sukses 204. Catat audit tanpa rahasia lalu teruskan errornya.
      await this.audit.record({
        action: 'OWNER_EMAIL_VERIFICATION_FAILED',
        domain: 'auth',
        correlationId: ctx.correlationId,
        metadata: { emailHash: this.hashSecret(email), reason: 'transaction_error' },
      });
      throw err;
    }

    if (transactionResult.ok === false) {
      await this.audit.record({
        action: 'OWNER_EMAIL_VERIFICATION_FAILED',
        domain: 'auth',
        correlationId: ctx.correlationId,
        metadata: { emailHash: this.hashSecret(email), reason: transactionResult.reason },
      });
      throw new ApiError(
        ErrorCode.OTP_INVALID_OR_EXPIRED,
        'Kode verifikasi tidak valid atau sudah kedaluwarsa.',
      );
    }

    // Setelah pengecekan ok === false, TypeScript mengetahui ok bernilai true.
    await this.audit.record({
      action: 'OWNER_EMAIL_VERIFIED',
      domain: 'auth',
      actorUserId: transactionResult.userId,
      correlationId: ctx.correlationId,
      metadata: { emailHash: this.hashSecret(email) },
    });
    return { status: 204 };
  }

  async resendOtp(

    input: { email: string },
    ctx: { ip: string; correlationId: string },
  ): Promise<{ status: 202 }> {
    const email = normalizeEmail(input.email);

    const rlIp = await this.rateLimit.consume(AUTH_RATE_LIMITS.resendIp, ctx.ip);
    if (!rlIp.allowed) throw this.rateLimited(rlIp.retryAfterSeconds);
    const rlEmail = await this.rateLimit.consume(AUTH_RATE_LIMITS.resendEmail, email);
    if (!rlEmail.allowed) throw this.rateLimited(rlEmail.retryAfterSeconds);

    const user = await this.prisma.client.user.findUnique({ where: { email } });
    // Respons generik: jangan ungkap keberadaan akun.
    if (user && user.status === 'PENDING_VERIFICATION') {
      await this.issueOtp(email, ctx.correlationId, user.id);
    } else {
      await this.audit.record({
        action: 'OWNER_EMAIL_OTP_RESENT',
        domain: 'auth',
        correlationId: ctx.correlationId,
        metadata: { emailHash: this.hashSecret(email), outcome: 'no_pending_account' },
      });
    }
    return { status: 202 };
  }

  // ============================================================
  // Sesi & CSRF
  // ============================================================

  async login(
    input: { email: string; password: string },
    ctx: { ip: string; correlationId: string },
  ): Promise<SessionIssued & { profile: SessionProfile }> {
    const email = normalizeEmail(input.email);

    const rlIp = await this.rateLimit.consume(AUTH_RATE_LIMITS.loginIp, ctx.ip);
    if (!rlIp.allowed) throw this.rateLimited(rlIp.retryAfterSeconds);
    const rlAccount = await this.rateLimit.consume(
      AUTH_RATE_LIMITS.loginAccount,
      email,
    );
    if (!rlAccount.allowed) throw this.rateLimited(rlAccount.retryAfterSeconds);

    const user = await this.prisma.client.user.findUnique({ where: { email } });
    const invalid = new ApiError(
      ErrorCode.INVALID_CREDENTIALS,
      'Email atau password salah.',
    );
    if (!user || !user.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
      await this.audit.record({
        action: 'LOGIN_FAILED',
        domain: 'auth',
        actorUserId: user?.id ?? null,
        correlationId: ctx.correlationId,
        metadata: { emailHash: this.hashSecret(email) },
      });
      throw invalid;
    }
    if (user.status !== 'ACTIVE') {
      // Respons sama agar tidak membocorkan status akun.
      throw invalid;
    }

    const issued = await this.createSession(user.id);

    await this.audit.record({
      action: 'SESSION_CREATED',
      domain: 'auth',
      actorUserId: user.id,
      correlationId: ctx.correlationId,
    });
    // Sertakan profil pendaftaran agar frontend dapat mengisi onboarding
    // tepat setelah login (satu request, tanpa ronde tambahan ke
    // `GET /auth/sessions/current`).
    return {
      ...issued,
      profile: {
        ownerName: user.ownerName,
        tenantName: user.tenantName,
        tenantSlug: user.tenantSlug,
      },
    };
  }

  private async createSession(userId: string): Promise<SessionIssued> {
    const token = randomToken();
    const csrfToken = randomToken();
    const now = Date.now();
    const idleExpiresAt = new Date(now + SESSION_IDLE_MS);
    const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_MS);

    await this.prisma.client.authSession.create({
      data: {
        userId,
        tokenHash: sha256(token),
        csrfTokenHash: sha256(csrfToken),
        idleExpiresAt,
        absoluteExpiresAt,
      },
    });
    return { token, csrfToken, idleExpiresAt, absoluteExpiresAt };
  }

  /** Validasi sesi dari cookie. Server adalah sumber kebenaran expiry
   * (idle 30 menit, absolut 7 hari). Rotasi lastSeenAt best-effort.
   */
  async resolveSession(token: string | undefined): Promise<SessionInfo | null> {
    if (!token) return null;
    const session = await this.prisma.client.authSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: true },
    });
    if (!session) return null;

    const now = new Date();
    if (
      session.revokedAt != null ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now
    ) {
      return null;
    }

    // Perpanjang idle window (sliding), dibatasi absolute lifetime.
    const nextIdle = new Date(
      Math.min(now.getTime() + SESSION_IDLE_MS, session.absoluteExpiresAt.getTime()),
    );
    await this.prisma.client.authSession.update({
      where: { id: session.id },
      data: { lastSeenAt: now, idleExpiresAt: nextIdle },
    });

    return {
      id: session.id,
      userId: session.userId,
      email: session.user.email,
      ownerName: session.user.ownerName,
      tenantName: session.user.tenantName,
      tenantSlug: session.user.tenantSlug,
    };
  }

  /**
   * `GET /me` — profil akun self-service. Membaca user global + membership
   * aktif; tenant ditampilkan sebagai ringkasan (id/slug/nama/role) tanpa
   * data sensitif lain. Tidak menulis audit: aktor hanya membaca datanya
   * sendiri dan tidak ada perubahan state.
   */
  async getAccount(userId: string): Promise<{
    id: string;
    email: string;
    status: string;
    emailVerifiedAt: Date | null;
    profile: { ownerName: string | null; tenantName: string | null; tenantSlug: string | null };
    createdAt: Date;
    memberships: { tenantId: string; tenantSlug: string; tenantName: string; role: string }[];
  }> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        status: true,
        emailVerifiedAt: true,
        ownerName: true,
        tenantName: true,
        tenantSlug: true,
        createdAt: true,
      },
    });
    if (!user) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi tidak valid.');

    // Policy RLS aktor: hanya membership milik user ini yang terbaca.
    const memberships = await this.prisma.withActor(userId, (tx) =>
      tx.tenantMembership.findMany({
        where: { userId, status: 'ACTIVE' },
        include: { tenant: { select: { slug: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    );

    return {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerifiedAt: user.emailVerifiedAt,
      profile: {
        ownerName: user.ownerName,
        tenantName: user.tenantName,
        tenantSlug: user.tenantSlug,
      },
      createdAt: user.createdAt,
      memberships: memberships.map((membership) => ({
        tenantId: membership.tenantId,
        tenantSlug: membership.tenant.slug,
        tenantName: membership.tenant.name,
        role: membership.role,
      })),
    };
  }

  /** Validasi token CSRF terikat sesi (bukan session ID). */
  async validateCsrf(sessionId: string, presentedToken: string): Promise<boolean> {
    const session = await this.prisma.client.authSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) return false;
    return constantTimeEqual(session.csrfTokenHash, sha256(presentedToken));
  }

  /**
   * Terbitkan token CSRF baru untuk sesi aktif dan simpan hash-nya.
   * Token lama otomatis tidak berlaku (dipakai GET /auth/csrf setelah reload).
   * Token mentah hanya dikembalikan ke klien, tidak pernah dicatat di log.
   */
  async rotateCsrf(sessionId: string): Promise<string> {
    const csrfToken = randomToken();
    await this.prisma.client.authSession.update({
      where: { id: sessionId },
      data: { csrfTokenHash: sha256(csrfToken) },
    });
    return csrfToken;
  }

  async logout(sessionId: string, correlationId: string): Promise<void> {
    await this.prisma.client.authSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      action: 'SESSION_LOGOUT',
      domain: 'auth',
      correlationId,
    });
  }

  /** Cabut seluruh sesi aktif sebuah user (reset password, revoke membership). */
  async revokeAllSessions(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma.client;
    await client.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ============================================================
  // Reset password
  // ============================================================

  async requestPasswordReset(
    input: { email: string },
    ctx: { ip: string; correlationId: string },
  ): Promise<{ status: 202 }> {
    const email = normalizeEmail(input.email);

    const rlIp = await this.rateLimit.consume(
      AUTH_RATE_LIMITS.resetRequestIp,
      ctx.ip,
    );
    if (!rlIp.allowed) throw this.rateLimited(rlIp.retryAfterSeconds);
    const rlEmail = await this.rateLimit.consume(
      AUTH_RATE_LIMITS.resetRequestEmail,
      email,
    );
    if (!rlEmail.allowed) throw this.rateLimited(rlEmail.retryAfterSeconds);

    const user = await this.prisma.client.user.findUnique({ where: { email } });
    if (user) {
      const token = randomToken();
      await this.prisma.client.$transaction(async (tx) => {
        // Penerbitan token baru menginvalidasi token lama untuk akun yang sama.
        await tx.passwordResetChallenge.updateMany({
          where: { userId: user.id, consumedAt: null, invalidatedAt: null },
          data: { invalidatedAt: new Date() },
        });
        await tx.passwordResetChallenge.create({
          data: {
            userId: user.id,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
          },
        });
      });

      const link = `${this.config.APP_BASE_URL}/reset-password?token=${token}`;
      await this.email.send({
        to: email,
        subject: 'Reset password Rentalio',
        body: `Gunakan tautan berikut untuk mengganti password Anda (berlaku 30 menit):\n${link}\n\nJika Anda tidak meminta ini, abaikan email ini.`,
      });

      await this.audit.record({
        action: 'PASSWORD_RESET_REQUESTED',
        domain: 'auth',
        actorUserId: user.id,
        correlationId: ctx.correlationId,
      });
    } else {
      await this.audit.record({
        action: 'PASSWORD_RESET_REQUESTED',
        domain: 'auth',
        correlationId: ctx.correlationId,
        metadata: { emailHash: this.hashSecret(email), outcome: 'unknown_account' },
      });
    }
    // Respons generik identik untuk email terdaftar/tidak.
    return { status: 202 };
  }

  async completePasswordReset(
    input: { token: string; newPassword: string },
    ctx: { ip: string; correlationId: string },
  ): Promise<{ status: 204 }> {
    const rlIp = await this.rateLimit.consume(
      AUTH_RATE_LIMITS.resetCompleteIp,
      ctx.ip,
    );
    if (!rlIp.allowed) throw this.rateLimited(rlIp.retryAfterSeconds);

    assertPasswordPolicy(input.newPassword);
    const passwordHash = hashPassword(input.newPassword);
    const tokenHash = sha256(input.token);

    const outcome = await this.prisma.client.$transaction(async (tx) => {
      const challenge = await tx.passwordResetChallenge.findUnique({
        where: { tokenHash },
      });
      const now = new Date();
      if (
        !challenge ||
        challenge.consumedAt != null ||
        challenge.invalidatedAt != null ||
        challenge.expiresAt <= now
      ) {
        return { ok: false };
      }

      // Konsumsi atomik sekali pakai.
      const consumed = await tx.passwordResetChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count === 0) return { ok: false };

      await tx.user.update({
        where: { id: challenge.userId },
        data: { passwordHash },
      });
      // Reset sukses mencabut seluruh sesi aktif secara atomik.
      await tx.authSession.updateMany({
        where: { userId: challenge.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return { ok: true, userId: challenge.userId };
    });

    if (!outcome.ok) {
      throw new ApiError(
        ErrorCode.RESET_TOKEN_INVALID_OR_EXPIRED,
        'Tautan reset tidak valid atau sudah kedaluwarsa.',
      );
    }

    await this.audit.record({
      action: 'PASSWORD_RESET_COMPLETED',
      domain: 'auth',
      actorUserId: outcome.userId,
      correlationId: ctx.correlationId,
    });
    return { status: 204 };
  }

  // ============================================================
  // Penerimaan undangan staf
  // ============================================================

  /**
   * `POST /auth/invitations/accept` — karyawan menukar token undangan menjadi
   * akun + membership ACTIVE.
   *
   * - Token dicari lewat policy RLS khusus (migration 007) karena tenant belum
   *   diketahui; setelah tenantId terbaca, konteks tenant diset di transaksi
   *   yang sama.
   * - Konsumsi token atomik: dua request paralel dengan token sama hanya
   *   menghasilkan satu keberhasilan.
   * - Undangan TIDAK mengubah password akun yang sudah ada, dan hanya dapat
   *   dipakai untuk email yang diundang.
   */
  async acceptInvitation(
    input: { token: string; password?: string },
    ctx: { ip: string; correlationId: string },
  ): Promise<{ tenantId: string; email: string; role: string }> {
    const rlIp = await this.rateLimit.consume(
      AUTH_RATE_LIMITS.invitationAcceptIp,
      ctx.ip,
    );
    if (!rlIp.allowed) throw this.rateLimited(rlIp.retryAfterSeconds);

    const tokenHash = hashToken(input.token.trim());
    const now = new Date();
    const invalid = new ApiError(
      ErrorCode.INVITATION_INVALID_OR_EXPIRED,
      'Undangan tidak valid atau sudah kedaluwarsa.',
    );

    try {
      return await this.prisma.withInvitationToken(tokenHash, async (tx) => {
        const invitation = await tx.tenantMemberInvitation.findUnique({
          where: { tokenHash },
        });
        if (
          !invitation ||
          invitation.acceptedAt != null ||
          invitation.revokedAt != null ||
          invitation.expiresAt <= now
        ) {
          throw invalid;
        }

        // Konsumsi atomik sekali pakai.
        const consumed = await tx.tenantMemberInvitation.updateMany({
          where: {
            id: invitation.id,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { acceptedAt: now },
        });
        if (consumed.count !== 1) throw invalid;

        let user = await tx.user.findUnique({ where: { email: invitation.email } });
        if (!user) {
          if (!input.password) {
            throw new ApiError(
              ErrorCode.VALIDATION_ERROR,
              'Password wajib diisi untuk membuat akun.',
            );
          }
          assertPasswordPolicy(input.password);
          user = await tx.user.create({
            data: {
              email: invitation.email,
              passwordHash: hashPassword(input.password),
              status: 'ACTIVE',
              emailVerifiedAt: now,
            },
          });
        } else if (user.status === 'PENDING_VERIFICATION') {
          // Token hanya dikirim ke alamat ini, sehingga kepemilikan email
          // terbukti; akun pending diaktifkan tanpa mengubah passwordnya.
          user = await tx.user.update({
            where: { id: user.id },
            data: { status: 'ACTIVE', emailVerifiedAt: user.emailVerifiedAt ?? now },
          });
        } else if (user.status === 'DISABLED') {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Akun dengan email ini dinonaktifkan.',
          );
        }
        // Password akun yang sudah ada sengaja tidak pernah diubah di sini.

        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${invitation.tenantId}, true)`;

        const existing = await tx.tenantMembership.findUnique({
          where: {
            tenantId_userId: { tenantId: invitation.tenantId, userId: user.id },
          },
        });
        if (existing && existing.status === 'ACTIVE') {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Pengguna sudah menjadi anggota tenant.',
          );
        }

        const membership = existing
          ? await tx.tenantMembership.update({
              where: { id: existing.id },
              data: {
                role: invitation.role,
                permissions: invitation.permissions,
                status: 'ACTIVE',
                activatedAt: now,
                revokedAt: null,
              },
            })
          : await tx.tenantMembership.create({
              data: {
                tenantId: invitation.tenantId,
                userId: user.id,
                role: invitation.role,
                status: 'ACTIVE',
                permissions: invitation.permissions,
                activatedAt: now,
                createdByUserId: invitation.createdByUserId,
              },
            });

        await this.audit.record(
          {
            tenantId: invitation.tenantId,
            actorUserId: user.id,
            action: 'MEMBER_ACTIVATED',
            domain: 'membership',
            entityType: 'tenant_membership',
            entityId: membership.id,
            toState: 'ACTIVE',
            correlationId: ctx.correlationId,
            metadata: { role: invitation.role, invitationId: invitation.id },
          },
          tx,
        );

        return {
          tenantId: invitation.tenantId,
          email: invitation.email,
          role: invitation.role,
        };
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Balapan request paralel: unique constraint membership/user menang kalah.
      if (isUniqueViolation(err)) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Undangan ini sedang atau sudah diproses.',
        );
      }
      throw err;
    }
  }

  private rateLimited(retryAfterSeconds: number): ApiError & { retryAfter?: number } {
    const err = new ApiError(ErrorCode.RATE_LIMITED, 'Terlalu banyak permintaan.') as ApiError & {
      retryAfter?: number;
    };
    err.retryAfter = retryAfterSeconds;
    return err;
  }
}
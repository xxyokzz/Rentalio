import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { hashPassword, randomToken, verifyPassword } from '../common/crypto.js';
import type { AppConfig } from '../config/env.validation.js';
import { PLATFORM_ADMIN_PERMISSION_KEY, type PlatformAdminPrincipal } from './platform-admin.auth.js';
import {
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotpStep,
} from './platform-admin.crypto.js';
import {
  recordPlatformAudit,
  type PlatformAuditClient,
  type PlatformAuditEvent,
} from './platform-admin.audit.js';

const LOGIN_TTL_MS = 5 * 60_000;
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60_000;
const MAX_MFA_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

/** Handler/controller Nest tanpa menulis tipe `Function` (dilarang lint). */
type ReflectTarget = ReturnType<ExecutionContext['getHandler']>;

export interface AdminBootstrapInput { email: string; password: string; }
export interface AdminAuthChallenge { challengeToken: string; expiresAt: Date; provisioningUri?: string; }
export interface AdminLoginResult {
  status: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  challenge: AdminAuthChallenge;
}
export interface AdminSessionIssued { token: string; csrfToken: string; expiresAt: Date; }

@Injectable()
export class PlatformAdminService {
  readonly adminOrigin: string;
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    private readonly reflector: Reflector,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {
    this.adminOrigin = config.PLATFORM_ADMIN_BASE_URL;
    this.encryptionKey = Buffer.from(config.PLATFORM_ADMIN_ENCRYPTION_KEY, 'base64');
  }

  requiredPermission(handler: ReflectTarget, controller: ReflectTarget): string | undefined {
    return this.reflector.getAllAndOverride<string>(PLATFORM_ADMIN_PERMISSION_KEY, [handler, controller]);
  }

  async bootstrap(input: AdminBootstrapInput): Promise<{ adminId: string; email: string; role: string }> {
    const email = this.normalizeEmail(input.email);
    this.assertPassword(input.password);
    return this.prisma.withRetryableTransaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rentalio.platform_admin.bootstrap'))`;
      const existing = await tx.platformAdminUser.count();
      if (existing > 0) throw new ApiError(ErrorCode.BUSINESS_RULE_VIOLATION, 'Bootstrap Admin Platform hanya dapat dilakukan sekali.');
      const role = await tx.platformRole.findUnique({ where: { code: 'PLATFORM_SUPER_ADMIN' } });
      if (!role) throw new Error('Platform role seed is missing. Apply platform admin migration first.');
      const admin = await tx.platformAdminUser.create({ data: { email, passwordHash: hashPassword(input.password) } });
      await tx.platformAdminRole.create({ data: { adminUserId: admin.id, roleId: role.id } });
      await this.audit(tx, { actorAdminId: admin.id, action: 'PLATFORM_ADMIN_BOOTSTRAPPED', targetType: 'platform_admin_user', targetId: admin.id, correlationId: `bootstrap-${randomUUID()}` });
      return { adminId: admin.id, email: admin.email, role: role.code };
    });
  }

  async beginLogin(emailInput: string, password: string, ip: string): Promise<AdminLoginResult> {
    const email = this.normalizeEmail(emailInput);
    const ipLimit = await this.rateLimit.consume({ bucket: 'platform.admin.login:ip', limit: 10, windowSeconds: 900 }, ip);
    if (!ipLimit.allowed) throw this.rateLimited(ipLimit.retryAfterSeconds);
    const accountLimit = await this.rateLimit.consume({ bucket: 'platform.admin.login:account', limit: 5, windowSeconds: 900 }, email);
    if (!accountLimit.allowed) throw this.rateLimited(accountLimit.retryAfterSeconds);

    const admin = await this.prisma.client.platformAdminUser.findUnique({ where: { email } });
    if (!admin || admin.status !== 'ACTIVE' || !verifyPassword(password, admin.passwordHash)) {
      await this.audit(this.prisma.client, { actorAdminId: admin?.id, action: 'PLATFORM_ADMIN_LOGIN_FAILED', targetType: 'platform_admin_user', targetId: admin?.id, outcome: 'DENIED', correlationId: `admin-login-${randomUUID()}`, metadata: { emailHash: this.hash(email) } });
      throw new ApiError(ErrorCode.INVALID_CREDENTIALS, 'Email atau password salah.');
    }

    const rawChallenge = randomToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOGIN_TTL_MS);
    const enrollment = !admin.totpSecretEncrypted;
    const pendingSecret = enrollment ? generateTotpSecret() : null;
    await this.prisma.client.platformAdminLoginChallenge.create({
      data: {
        adminUserId: admin.id,
        tokenHash: this.sha256(rawChallenge),
        csrfTokenHash: this.sha256(randomToken()),
        expiresAt,
        pendingTotpSecretEncrypted: pendingSecret
          ? encryptSecret(this.encryptionKey, pendingSecret)
          : null,
        setupIssuedAt: enrollment ? now : null,
      },
    });
    await this.audit(this.prisma.client, { actorAdminId: admin.id, action: enrollment ? 'PLATFORM_ADMIN_MFA_ENROLLMENT_STARTED' : 'PLATFORM_ADMIN_MFA_CHALLENGE_ISSUED', targetType: 'platform_admin_user', targetId: admin.id, correlationId: `admin-login-${randomUUID()}` });
    return {
      status: enrollment ? 'MFA_ENROLLMENT_REQUIRED' : 'MFA_REQUIRED',
      challenge: {
        challengeToken: rawChallenge,
        expiresAt,
        ...(pendingSecret
          ? { provisioningUri: totpProvisioningUri(admin.email, pendingSecret) }
          : {}),
      },
    };
  }

  async completeMfa(challengeToken: string, code: string, ip: string): Promise<{ session: AdminSessionIssued; recoveryCodes?: string[] }> {
    const rl = await this.rateLimit.consume({ bucket: 'platform.admin.mfa:ip', limit: 20, windowSeconds: 900 }, ip);
    if (!rl.allowed) throw this.rateLimited(rl.retryAfterSeconds);
    const challengeHash = this.sha256(challengeToken);
    const now = new Date();
    const result = await this.prisma.withRetryableTransaction(async (tx) => {
      const challenge = await tx.platformAdminLoginChallenge.findUnique({ where: { tokenHash: challengeHash }, include: { adminUser: true } });
      if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attemptCount >= MAX_MFA_ATTEMPTS || challenge.adminUser.status !== 'ACTIVE') return null;
      const enrolling = !challenge.adminUser.totpSecretEncrypted;
      const secretEncrypted = enrolling ? challenge.pendingTotpSecretEncrypted : challenge.adminUser.totpSecretEncrypted;
      if (!secretEncrypted) return null;
      const secret = decryptSecret(this.encryptionKey, secretEncrypted);
      const verifiedStep = verifyTotpStep(
        secret,
        code,
        now.getTime(),
        challenge.adminUser.lastTotpStep,
      );
      if (verifiedStep == null) {
        await tx.platformAdminLoginChallenge.update({ where: { id: challenge.id }, data: { attemptCount: { increment: 1 } } });
        return null;
      }
      const consumed = await tx.platformAdminLoginChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now }, attemptCount: { lt: MAX_MFA_ATTEMPTS } }, data: { consumedAt: now } });
      if (consumed.count !== 1) return null;
      if (enrolling) {
        await tx.platformAdminUser.update({ where: { id: challenge.adminUserId }, data: { totpSecretEncrypted: secretEncrypted, mfaEnrolledAt: now, lastTotpStep: BigInt(verifiedStep), lastLoginAt: now } });
      } else {
        await tx.platformAdminUser.update({ where: { id: challenge.adminUserId }, data: { lastTotpStep: BigInt(verifiedStep), lastLoginAt: now } });
      }
      const recoveryCodes = enrolling ? await this.issueRecoveryCodes(tx, challenge.adminUserId) : undefined;
      const session = await this.createSession(tx, challenge.adminUserId, now);
      await this.audit(tx, { actorAdminId: challenge.adminUserId, action: enrolling ? 'PLATFORM_ADMIN_MFA_ENROLLED' : 'PLATFORM_ADMIN_LOGIN_SUCCEEDED', targetType: 'platform_admin_user', targetId: challenge.adminUserId, correlationId: `admin-mfa-${randomUUID()}` });
      return { session, recoveryCodes };
    });
    if (!result) throw new ApiError(ErrorCode.MFA_INVALID_OR_EXPIRED, 'Kode MFA tidak valid atau challenge sudah kedaluwarsa.');
    return result;
  }

  async loginWithRecoveryCode(challengeToken: string, recoveryCode: string, ip: string): Promise<AdminSessionIssued> {
    const rl = await this.rateLimit.consume({ bucket: 'platform.admin.recovery:ip', limit: 5, windowSeconds: 3600 }, ip);
    if (!rl.allowed) throw this.rateLimited(rl.retryAfterSeconds);
    const challengeHash = this.sha256(challengeToken);
    const candidateHash = this.hash(recoveryCode.trim().toUpperCase());
    const now = new Date();
    const result = await this.prisma.withRetryableTransaction(async (tx) => {
      const challenge = await tx.platformAdminLoginChallenge.findUnique({ where: { tokenHash: challengeHash }, include: { adminUser: true } });
      if (!challenge || challenge.consumedAt || challenge.expiresAt <= now || challenge.attemptCount >= MAX_MFA_ATTEMPTS || challenge.adminUser.status !== 'ACTIVE' || !challenge.adminUser.totpSecretEncrypted) return null;
      const code = await tx.platformAdminRecoveryCode.findFirst({ where: { adminUserId: challenge.adminUserId, codeHash: candidateHash, usedAt: null } });
      if (!code) {
        await tx.platformAdminLoginChallenge.update({ where: { id: challenge.id }, data: { attemptCount: { increment: 1 } } });
        return null;
      }
      const consumedCode = await tx.platformAdminRecoveryCode.updateMany({ where: { id: code.id, usedAt: null }, data: { usedAt: now } });
      const consumedChallenge = await tx.platformAdminLoginChallenge.updateMany({ where: { id: challenge.id, consumedAt: null, expiresAt: { gt: now }, attemptCount: { lt: MAX_MFA_ATTEMPTS } }, data: { consumedAt: now } });
      if (consumedCode.count !== 1 || consumedChallenge.count !== 1) return null;
      await tx.platformAdminUser.update({ where: { id: challenge.adminUserId }, data: { lastLoginAt: now } });
      const session = await this.createSession(tx, challenge.adminUserId, now);
      await this.audit(tx, { actorAdminId: challenge.adminUserId, action: 'PLATFORM_ADMIN_RECOVERY_CODE_USED', targetType: 'platform_admin_user', targetId: challenge.adminUserId, outcome: 'SUCCESS', correlationId: `admin-recovery-${randomUUID()}` });
      return session;
    });
    if (!result) throw new ApiError(ErrorCode.MFA_INVALID_OR_EXPIRED, 'Kode pemulihan tidak valid atau sudah digunakan.');
    return result;
  }

  /**
   * Re-authentication untuk tindakan berisiko (suspend/reactivate, assignment
   * role, promo aktif, publish pengumuman, settle tagihan).
   *
   * Password dan TOTP diverifikasi ulang terhadap sesi yang sedang aktif.
   * Langkah TOTP yang sudah dipakai login tidak dapat diulang: `lastTotpStep`
   * bersifat global per akun, bukan per sesi, sehingga kode yang sama tidak
   * dapat dipakai dua kali meski berada dalam jendela toleransi.
   */
  async reauthenticate(
    sessionId: string,
    password: string,
    code: string,
    ip: string,
  ): Promise<{ reauthenticatedAt: Date }> {
    const ipLimit = await this.rateLimit.consume(
      { bucket: 'platform.admin.reauth:ip', limit: 10, windowSeconds: 900 },
      ip,
    );
    if (!ipLimit.allowed) throw this.rateLimited(ipLimit.retryAfterSeconds);
    const sessionLimit = await this.rateLimit.consume(
      { bucket: 'platform.admin.reauth:session', limit: 5, windowSeconds: 900 },
      sessionId,
    );
    if (!sessionLimit.allowed) throw this.rateLimited(sessionLimit.retryAfterSeconds);

    const now = new Date();
    const session = await this.prisma.client.platformAdminSession.findUnique({
      where: { id: sessionId },
      include: { adminUser: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.idleExpiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      session.adminUser.status !== 'ACTIVE' ||
      !session.adminUser.totpSecretEncrypted
    ) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi Admin Platform tidak valid.');
    }

    if (!verifyPassword(password, session.adminUser.passwordHash)) {
      await this.audit(this.prisma.client, {
        actorAdminId: session.adminUserId,
        action: 'PLATFORM_ADMIN_REAUTHENTICATION_FAILED',
        targetType: 'platform_admin_session',
        targetId: sessionId,
        outcome: 'DENIED',
        correlationId: `admin-reauth-${randomUUID()}`,
        metadata: { stage: 'password' },
      });
      throw new ApiError(ErrorCode.INVALID_CREDENTIALS, 'Email atau password salah.');
    }

    const secret = decryptSecret(this.encryptionKey, session.adminUser.totpSecretEncrypted);
    const verifiedStep = verifyTotpStep(
      secret,
      code,
      now.getTime(),
      session.adminUser.lastTotpStep,
    );
    if (verifiedStep == null) {
      await this.audit(this.prisma.client, {
        actorAdminId: session.adminUserId,
        action: 'PLATFORM_ADMIN_REAUTHENTICATION_FAILED',
        targetType: 'platform_admin_session',
        targetId: sessionId,
        outcome: 'DENIED',
        correlationId: `admin-reauth-${randomUUID()}`,
        metadata: { stage: 'totp' },
      });
      throw new ApiError(
        ErrorCode.MFA_INVALID_OR_EXPIRED,
        'Kode MFA tidak valid atau sudah dipakai.',
      );
    }

    const reauthenticatedAt = await this.prisma.withRetryableTransaction(async (tx) => {
      const updated = await tx.platformAdminSession.updateMany({
        where: {
          id: sessionId,
          revokedAt: null,
          idleExpiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        data: { reauthenticatedAt: now },
      });
      if (updated.count !== 1) return null;
      await tx.platformAdminUser.update({
        where: { id: session.adminUserId },
        data: { lastTotpStep: BigInt(verifiedStep) },
      });
      await this.audit(tx, {
        actorAdminId: session.adminUserId,
        action: 'PLATFORM_ADMIN_REAUTHENTICATED',
        targetType: 'platform_admin_session',
        targetId: sessionId,
        correlationId: `admin-reauth-${randomUUID()}`,
      });
      return now;
    });
    if (!reauthenticatedAt) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi Admin Platform tidak valid.');
    }
    return { reauthenticatedAt };
  }

  async resolveSession(token: string | undefined): Promise<PlatformAdminPrincipal | null> {
    if (!token) return null;
    const now = new Date();
    const session = await this.prisma.client.platformAdminSession.findUnique({
      where: { tokenHash: this.sha256(token) },
      include: { adminUser: { include: { roles: { where: { revokedAt: null }, include: { role: { include: { permissions: { include: { permission: true } } } } } } } } },
    });
    if (!session || session.revokedAt || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now || session.adminUser.status !== 'ACTIVE' || !session.adminUser.totpSecretEncrypted) return null;
    const permissionSet = new Set<string>();
    const roles: string[] = [];
    for (const assignment of session.adminUser.roles) {
      roles.push(assignment.role.code);
      for (const { permission } of assignment.role.permissions) permissionSet.add(permission.code);
    }
    if (permissionSet.size === 0) return null;
    await this.prisma.client.platformAdminSession.update({ where: { id: session.id }, data: { lastSeenAt: now, idleExpiresAt: new Date(Math.min(now.getTime() + SESSION_IDLE_MS, session.absoluteExpiresAt.getTime())) } });
    return { id: session.adminUser.id, email: session.adminUser.email, sessionId: session.id, permissions: [...permissionSet], roles, reauthenticatedAt: session.reauthenticatedAt };
  }

  async validateCsrf(sessionId: string, presented: string): Promise<boolean> {
    const session = await this.prisma.client.platformAdminSession.findUnique({ where: { id: sessionId } });
    if (!session || session.revokedAt || session.idleExpiresAt <= new Date() || session.absoluteExpiresAt <= new Date()) return false;
    const expected = Buffer.from(session.csrfTokenHash, 'hex');
    const actual = Buffer.from(this.sha256(presented), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async rotateCsrf(sessionId: string): Promise<string> {
    const csrfToken = randomToken();
    const updated = await this.prisma.client.platformAdminSession.updateMany({ where: { id: sessionId, revokedAt: null, idleExpiresAt: { gt: new Date() }, absoluteExpiresAt: { gt: new Date() } }, data: { csrfTokenHash: this.sha256(csrfToken) } });
    if (updated.count !== 1) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi Admin Platform tidak valid.');
    return csrfToken;
  }

  async logout(sessionId: string, correlationId: string, actorAdminId: string): Promise<void> {
    const revoked = await this.prisma.client.platformAdminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (revoked.count === 1) await this.audit(this.prisma.client, { actorAdminId, action: 'PLATFORM_ADMIN_LOGOUT', targetType: 'platform_admin_session', targetId: sessionId, correlationId });
  }

  private async createSession(tx: Prisma.TransactionClient, adminUserId: string, now: Date): Promise<AdminSessionIssued> {
    const token = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
    await tx.platformAdminSession.create({ data: { adminUserId, tokenHash: this.sha256(token), csrfTokenHash: this.sha256(csrfToken), idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS), absoluteExpiresAt: expiresAt, mfaAuthenticatedAt: now, reauthenticatedAt: now } });
    return { token, csrfToken, expiresAt };
  }

  private async issueRecoveryCodes(tx: Prisma.TransactionClient, adminUserId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => `${randomBytes(5).toString('hex').toUpperCase()}-${randomBytes(5).toString('hex').toUpperCase()}`);
    await tx.platformAdminRecoveryCode.createMany({ data: codes.map((code) => ({ adminUserId, codeHash: this.hash(code) })) });
    return codes;
  }

  private async audit(client: PlatformAuditClient, event: PlatformAuditEvent): Promise<void> {
    await recordPlatformAudit(client, event);
  }

  private assertPassword(password: string): void {
    if (password.length < 12 || password.length > 128) throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Password harus 12–128 karakter.');
  }

  private normalizeEmail(email: string): string { return email.trim().toLowerCase(); }
  private sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
  private hash(value: string): string { return createHmac('sha256', this.config.HMAC_PEPPER).update(value).digest('hex'); }

  private rateLimited(retryAfterSeconds: number): ApiError & { retryAfter: number } {
    const error = new ApiError(ErrorCode.RATE_LIMITED, 'Terlalu banyak permintaan.') as ApiError & { retryAfter: number };
    error.retryAfter = retryAfterSeconds;
    return error;
  }
}

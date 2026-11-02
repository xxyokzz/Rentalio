import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type MembershipRole } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EmailService } from '../email/email.service.js';
import { hashToken } from '../common/crypto.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { AppConfig } from '../config/env.validation.js';
import type { CreateTenantDto, UpdateTenantSettingsDto, InviteMemberDto, UpdateMemberDto } from './tenant.dto.js';
import { createDefaultWhatsAppTemplates } from '../whatsapp-templates/whatsapp-templates.defaults.js';
import { SubscriptionPolicyService } from '../subscriptions/subscription-policy.service.js';

/** TTL undangan staf: 7 hari. */
const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

/** Permission default per role (Notion 04 — permission key minimum). */
const ROLE_DEFAULT_PERMISSIONS: Record<string, string[]> = {
  MANAGER: [
    'catalog.read', 'catalog.write', 'inventory.read', 'inventory.write',
    'availability.read', 'reservation.read', 'reservation.create',
    'reservation.approve', 'reservation.cancel', 'order.read', 'order.create',
    'order.handover', 'order.return', 'order.inspect', 'payment.read',
    'payment.record', 'payment.void', 'refund.request', 'refund.approve',
    'refund.process', 'deposit.read', 'deposit.receive', 'deposit.deduct',
    'deposit.refund', 'deposit.deduct.approve',    'rental.extension.request',
    'rental.extension.approve', 'rental.extension.resolve_conflict',
    'customer.read', 'customer.write', 'report.read', 'staff.manage',
  ],
  STAFF: [
    'catalog.read', 'inventory.read', 'availability.read',
    'reservation.read', 'reservation.create', 'order.read', 'order.create',
    'order.handover', 'order.return', 'order.inspect',
    'payment.read', 'payment.record', 'deposit.read', 'deposit.receive',
    'rental.extension.request', 'customer.read', 'customer.write', 'report.read',
  ],
  CASHIER: [
    'catalog.read', 'inventory.read', 'availability.read',
    'reservation.read', 'order.read', 'customer.read',
    'payment.read', 'payment.record', 'deposit.read', 'deposit.receive',
  ],
};

@Injectable()
export class TenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
    private readonly subscriptionPolicy: SubscriptionPolicyService,
  ) {}

  // ============================================================
  // Tenant CRUD
  // ============================================================

  /**
   * Buat tenant baru dan tetapkan actor sebagai OWNER.
   * Trial 72 jam dimulai dari aktivasi (verifikasi email sudah selesai).
   */
  async createTenant(
    dto: CreateTenantDto,
    ctx: { actorUserId: string; correlationId: string },
  ): Promise<{ id: string; slug: string; name: string }> {
    const slug = dto.slug.toLowerCase().trim();

    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + 72 * 3600 * 1000);
    // ID dibuat di klien agar konteks RLS (app.tenant_id) sudah tersedia
    // sebelum INSERT ke tabel tenants yang memakai FORCE RLS (dokumen 03/10).
    const tenantId = randomUUID();

    try {
      const tenant = await this.prisma.withTenant(tenantId, async (tx) => {
        const t = await tx.tenant.create({
          data: {
            id: tenantId,
            slug,
            name: dto.name.trim(),
            timezone: dto.timezone ?? 'Asia/Jakarta',
            status: 'ACTIVE',
            activatedAt: now,
            trialEndsAt,
          },
        });

        // Actor menjadi OWNER dengan semua permission.
        await tx.tenantMembership.create({
          data: {
            tenantId: t.id,
            userId: ctx.actorUserId,
            role: 'OWNER',
            status: 'ACTIVE',
            permissions: [],
            activatedAt: now,
          },
        });

        // Seed 9 template WhatsApp bawaan (3 konteks × 3 metode) + versi 1.
        // Dilakukan di transaksi yang sama agar GET tidak perlu memutasi state.
        await createDefaultWhatsAppTemplates(tx, t.id, ctx.actorUserId);

        // Buat subscription TRIALING awal (plan default 'free').
        //
        // `subscriptions.planId` NOT NULL: tanpa baris plan ini subscription
        // tidak dibuat sama sekali. Baris plan platform `free` dipasang oleh
        // migration `20261027130000_default_platform_plan` dan oleh
        // `database/prisma/seed.mjs` — code di kedua tempat itu HARUS sama
        // dengan nilai di bawah, jangan diganti salah satu saja.
        const freePlan = await tx.plan.findFirst({
          where: { tenantId: null, code: 'free' },
        });
        if (freePlan) {
          await tx.subscription.create({
            data: {
              tenantId: t.id,
              planId: freePlan.id,
              status: 'TRIALING',
              activatedAt: now,
              trialEndsAt,
            },
          });
        }

        await this.audit.record(
          {
            tenantId: t.id,
            actorUserId: ctx.actorUserId,
            action: 'TENANT_CREATED',
            domain: 'tenant',
            entityType: 'tenant',
            entityId: t.id,
            toState: 'ACTIVE',
            correlationId: ctx.correlationId,
          },
          tx,
        );
        return t;
      });

      return { id: tenant.id, slug: tenant.slug, name: tenant.name };
    } catch (err) {
      // Slug unik ditegakkan database; pemeriksaan awal tidak bisa dilakukan
      // karena RLS fail-closed sebelum konteks tenant terbentuk.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ApiError(ErrorCode.BUSINESS_RULE_VIOLATION, 'Slug sudah digunakan.');
      }
      throw err;
    }
  }

  /**
   * Ambil daftar tenant yang diakses actor (berdasarkan membership aktif).
   */
  async listMyTenants(actorUserId: string): Promise<{ id: string; slug: string; name: string; role: string }[]> {
    // Konteks aktor: policy RLS 006 membatasi baca ke membership milik aktor.
    const memberships = await this.prisma.withActor(actorUserId, (tx) =>
      tx.tenantMembership.findMany({
        where: { userId: actorUserId, status: 'ACTIVE' },
        include: { tenant: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return memberships.map((m) => ({
      id: m.tenant.id,
      slug: m.tenant.slug,
      name: m.tenant.name,
      role: m.role,
    }));
  }

  /**
   * Ambil detail tenant. Actor harus memiliki membership aktif di tenant tersebut.
   */
  async getTenant(
    tenantId: string,
    actorUserId: string,
  ): Promise<{
    id: string;
    slug: string;
    name: string;
    timezone: string;
    status: string;
    bookingMode: string;
    catalogPolicy: string;
    rentalExtensionEnabled: boolean;
    whatsappNumber: string | null;
    bankTransferInstructions: string | null;
    qrisImageUrl: string | null;
    activatedAt: Date | null;
    trialEndsAt: Date | null;
    /** Status langganan efektif — dipakai UI untuk mode terbatas (bukan hitungan klien). */
    subscription: {
      status: string;
      restricted: boolean;
      reason: string;
      trialEndsAt: Date | null;
      graceEndsAt: Date | null;
      periodEnd: Date | null;
    };
    /**
     * Ketersediaan pembayaran langganan (QRIS dinamis). UI memakai ini untuk
     * memilih panel QR vs jalur manual; nilainya tetap konfigurasi server,
     * bukan keputusan klien.
     */
    billing: {
      paymentEnabled: boolean;
      priceAmount: string | null;
      periodDays: number;
    };
  }> {
    await this.requireMembership(tenantId, actorUserId, ['OWNER', 'MANAGER', 'STAFF', 'CASHIER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');
      // Evaluasi dengan fungsi murni yang sama seperti guard, sehingga UI tidak
      // pernah menghitung ulang aturan entitlement sendiri (jam browser tidak
      // dipakai, dan tenant lama tanpa baris subscription tetap fail-closed).
      const latestSubscription = await tx.subscription.findFirst({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const entitlement = this.subscriptionPolicy.compute(tenant, latestSubscription);
      return {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        timezone: tenant.timezone,
        status: tenant.status,
        bookingMode: tenant.bookingMode,
        catalogPolicy: tenant.catalogPolicy,
        rentalExtensionEnabled: tenant.rentalExtensionEnabled,
        whatsappNumber: tenant.whatsappNumber,
        bankTransferInstructions: tenant.bankTransferInstructions,
        qrisImageUrl: tenant.qrisImageUrl,
        activatedAt: tenant.activatedAt,
        trialEndsAt: tenant.trialEndsAt,
        subscription: {
          status: entitlement.status,
          restricted: entitlement.restricted,
          reason: entitlement.reason,
          trialEndsAt: entitlement.trialEndsAt,
          graceEndsAt: entitlement.graceEndsAt,
          periodEnd: entitlement.periodEnd,
        },
        billing: {
          paymentEnabled:
            Boolean(this.config.PLATFORM_QRIS_STATIC_PAYLOAD) &&
            this.config.SUBSCRIPTION_PRICE_AMOUNT > 0,
          priceAmount:
            this.config.SUBSCRIPTION_PRICE_AMOUNT > 0
              ? String(this.config.SUBSCRIPTION_PRICE_AMOUNT)
              : null,
          periodDays: this.config.SUBSCRIPTION_PERIOD_DAYS,
        },
      };
    });
  }

  /**
   * Perbarui pengaturan booking/katalog tenant. Hanya OWNER.
   */
  async updateTenantSettings(
    tenantId: string,
    dto: UpdateTenantSettingsDto,
    ctx: { actorUserId: string; correlationId: string },
  ): Promise<void> {
    await this.requireMembership(tenantId, ctx.actorUserId, ['OWNER']);

    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          ...(dto.bookingMode && { bookingMode: dto.bookingMode }),
          ...(dto.catalogPolicy && { catalogPolicy: dto.catalogPolicy }),
          ...(dto.rentalExtensionEnabled !== undefined && {
            rentalExtensionEnabled: dto.rentalExtensionEnabled,
          }),
          ...(dto.whatsappNumber !== undefined && {
            whatsappNumber: dto.whatsappNumber.trim() || null,
          }),
          ...(dto.bankTransferInstructions !== undefined && {
            bankTransferInstructions: dto.bankTransferInstructions.trim() || null,
          }),
          ...(dto.qrisImageUrl !== undefined && {
            qrisImageUrl: dto.qrisImageUrl.trim() || null,
          }),
        },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'TENANT_SETTINGS_UPDATED',
          domain: 'tenant',
          entityType: 'tenant',
          entityId: tenantId,
          correlationId: ctx.correlationId,
          metadata: { changes: dto },
        },
        tx,
      );
    });
  }

  // ============================================================
  // Membership management (OWNER-only per Notion 04)
  // ============================================================

  /**
   * Daftar member aktif tenant.
   */
  async listMembers(
    tenantId: string,
    actorUserId: string,
  ): Promise<{ userId: string; role: string; status: string; permissions: string[]; activatedAt: Date | null }[]> {
    await this.requireMembership(tenantId, actorUserId, ['OWNER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const members = await tx.tenantMembership.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
      });
      return members.map((m) => ({
        userId: m.userId,
        role: m.role,
        status: m.status,
        permissions: m.permissions,
        activatedAt: m.activatedAt,
      }));
    });
  }

  /**
   * Undang staf ke tenant. Menghasilkan token undangan hash-only sekali pakai.
   * Hanya OWNER yang boleh mengundang (Notion 04 — ownership rules).
   */
  async inviteMember(
    tenantId: string,
    dto: InviteMemberDto,
    ctx: { actorUserId: string; correlationId: string },
  ): Promise<{ invitationId: string; expiresAt: Date; emailDelivered: boolean }> {
    await this.requireMembership(tenantId, ctx.actorUserId, ['OWNER']);
    const email = dto.email.trim().toLowerCase();

    const prepared = await this.prisma.withTenant(tenantId, async (tx) => {
      // Cek apakah sudah ada membership aktif untuk email ini.
      const existingUser = await tx.user.findUnique({ where: { email } });
      if (existingUser) {
        const existingMembership = await tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId, userId: existingUser.id } },
        });
        if (existingMembership && existingMembership.status === 'ACTIVE') {
          throw new ApiError(ErrorCode.BUSINESS_RULE_VIOLATION, 'Pengguna sudah menjadi anggota tenant.');
        }
      }

      // Batalkan undangan pending yang sudah ada untuk email yang sama.
      await tx.tenantMemberInvitation.updateMany({
        where: { tenantId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const rawToken = randomBytes(32).toString('base64url');
      // Hash token — simpan hanya hash (Notion 03 — token hash-only).
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });

      const invitation = await tx.tenantMemberInvitation.create({
        data: {
          tenantId,
          email,
          role: dto.role as MembershipRole,
          permissions: dto.permissions ?? ROLE_DEFAULT_PERMISSIONS[dto.role] ?? [],
          tokenHash,
          expiresAt,
          createdByUserId: ctx.actorUserId,
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'MEMBER_INVITED',
          domain: 'membership',
          entityType: 'tenant_member_invitation',
          entityId: invitation.id,
          correlationId: ctx.correlationId,
          metadata: { emailHash: hashToken(email), role: dto.role },
        },
        tx,
      );

      return { invitationId: invitation.id, expiresAt, rawToken, tenantName: tenant?.name ?? 'Rentalio' };
    });

    // Pengiriman email dilakukan SETELAH commit (dokumen 10: jangan memanggil
    // provider eksternal saat transaksi database masih terbuka). Kegagalan
    // delivery tidak membatalkan undangan yang sudah tersimpan, tetapi
    // dicatat sebagai audit event agar tidak tertelan diam-diam.
    let emailDelivered = true;
    try {
      const link = `${this.config.APP_BASE_URL}/invitations/accept?token=${encodeURIComponent(
        prepared.rawToken,
      )}`;
      await this.email.send({
        to: email,
        subject: `Undangan bergabung dengan ${prepared.tenantName}`,
        body: [
          `Anda diundang bergabung dengan ${prepared.tenantName} di Rentalio sebagai ${dto.role}.`,
          '',
          `Buka tautan berikut untuk membuat kredensial dan mengaktifkan akses: ${link}`,
          '',
          `Tautan berlaku sampai ${prepared.expiresAt.toISOString()} dan hanya dapat dipakai sekali.`,
          'Abaikan email ini bila Anda tidak mengenal pengirimnya.',
        ].join('\n'),
      });
    } catch {
      emailDelivered = false;
      await this.audit.record({
        tenantId,
        actorUserId: ctx.actorUserId,
        action: 'MEMBER_INVITE_EMAIL_FAILED',
        domain: 'membership',
        entityType: 'tenant_member_invitation',
        entityId: prepared.invitationId,
        correlationId: ctx.correlationId,
      });
    }

    return {
      invitationId: prepared.invitationId,
      expiresAt: prepared.expiresAt,
      emailDelivered,
    };
  }

  /**
   * Update role/permission/status member. Hanya OWNER.
   * Proteksi: OWNER tunggal tidak boleh mengubah dirinya ke non-OWNER atau merevoke dirinya.
   */
  async updateMember(
    tenantId: string,
    targetUserId: string,
    dto: UpdateMemberDto,
    ctx: { actorUserId: string; correlationId: string },
  ): Promise<void> {
    await this.requireMembership(tenantId, ctx.actorUserId, ['OWNER']);

    await this.prisma.withTenant(tenantId, async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: targetUserId } },
      });
      if (!membership) throw new ApiError(ErrorCode.NOT_FOUND, 'Member tidak ditemukan.');

      // Proteksi lockout OWNER tunggal (Notion 04 — single-owner lockout prevention).
      if (membership.role === 'OWNER' || dto.role === 'MANAGER') {
        const ownerCount = await tx.tenantMembership.count({
          where: { tenantId, role: 'OWNER', status: 'ACTIVE' },
        });
        if (ownerCount <= 1 && membership.role === 'OWNER') {
          if (dto.status === 'REVOKED' || (dto.role !== undefined && membership.role === 'OWNER')) {
            throw new ApiError(
              ErrorCode.BUSINESS_RULE_VIOLATION,
              'Tidak dapat merevoke atau menurunkan role OWNER terakhir. Transfer ownership terlebih dahulu.',
            );
          }
        }
      }

      const prevState = `${membership.role}:${membership.status}`;
      const revoking = dto.status === 'REVOKED' && membership.status !== 'REVOKED';
      const activating = dto.status === 'ACTIVE' && membership.status !== 'ACTIVE';
      const roleChanged = dto.role !== undefined && dto.role !== membership.role;
      const permissionsChanged =
        dto.permissions !== undefined &&
        JSON.stringify(dto.permissions) !== JSON.stringify(membership.permissions);

      await tx.tenantMembership.update({
        where: { id: membership.id },
        data: {
          ...(dto.role && { role: dto.role as MembershipRole }),
          ...(dto.permissions && { permissions: dto.permissions }),
          ...(dto.status && {
            status: dto.status,
            ...(revoking && { revokedAt: new Date() }),
          }),
        },
      });

      // Revoke akses tidak boleh bergantung pada expiry cookie: cabut seluruh
      // sesi aktif milik member yang dicabut (dokumen 10 — revoke flow).
      if (revoking) {
        await tx.authSession.updateMany({
          where: { userId: targetUserId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      // Audit event spesifik sesuai kontrak dokumen 10 (bukan satu event generik).
      const baseAudit = {
        tenantId,
        actorUserId: ctx.actorUserId,
        domain: 'membership',
        entityType: 'tenant_membership',
        entityId: membership.id,
        correlationId: ctx.correlationId,
        metadata: { targetUserId, changes: dto },
      };
      const events: { action: string; fromState?: string; toState?: string }[] = [];
      if (roleChanged) {
        events.push({
          action: 'MEMBER_ROLE_CHANGED',
          fromState: membership.role,
          toState: dto.role!,
        });
      }
      if (permissionsChanged) {
        events.push({ action: 'MEMBER_PERMISSIONS_CHANGED' });
      }
      if (revoking) {
        events.push({ action: 'MEMBER_REVOKED', fromState: membership.status, toState: 'REVOKED' });
      } else if (activating) {
        events.push({ action: 'MEMBER_ACTIVATED', fromState: membership.status, toState: 'ACTIVE' });
      }
      if (events.length === 0) {
        events.push({ action: 'MEMBER_UPDATED', fromState: prevState });
      }
      for (const event of events) {
        await this.audit.record({ ...baseAudit, ...event }, tx);
      }
    });
  }

  // ============================================================
  // Helper: pastikan actor adalah anggota aktif dengan salah satu role
  // ============================================================

  async requireMembership(
    tenantId: string,
    actorUserId: string,
    allowedRoles: string[],
  ): Promise<void> {
    // RLS fail-closed: membership dibaca dengan konteks tenant dari parameter.
    const membership = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: actorUserId } },
      }),
    );
    if (!membership || membership.status !== 'ACTIVE' || !allowedRoles.includes(membership.role)) {
      throw new ApiError(ErrorCode.PERMISSION_DENIED, 'Akses tidak diizinkan.');
    }
  }

  /**
   * Otorisasi berbasis permission key (Notion 04). OWNER selalu memiliki
   * semua permission. Role lain memakai permission eksplisit membership bila
   * diisi; bila kosong (membership lama/dibuat manual), default role dipakai.
   */
  async requirePermission(
    tenantId: string,
    actorUserId: string,
    permission: string,
  ): Promise<{ role: string; permissions: string[] }> {
    const membership = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: actorUserId } },
      }),
    );
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ApiError(ErrorCode.PERMISSION_DENIED, 'Akses tidak diizinkan.');
    }
    if (membership.role === 'OWNER') {
      return { role: membership.role, permissions: ['*'] };
    }
    const granted =
      membership.permissions.length > 0
        ? membership.permissions
        : ROLE_DEFAULT_PERMISSIONS[membership.role] ?? [];
    if (!granted.includes(permission)) {
      throw new ApiError(ErrorCode.PERMISSION_DENIED, 'Akses tidak diizinkan.');
    }
    return { role: membership.role, permissions: granted };
  }
}

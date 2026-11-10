import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@rentalio/database';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AppConfig } from '../config/env.validation.js';

/**
 * Prisma service dengan driver adapter pg (Prisma 7).
 * Menyediakan helper transaksi dengan tenant context (SET LOCAL)
 * untuk RLS — dokumen 10: konteks tenant ditetapkan transaksional.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  private static readonly RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);
  private static readonly TRANSACTION_RETRY_DELAYS_MS = [10, 25, 50] as const;

  /**
   * Anggaran tunggu transaksi. Default Prisma (maxWait 2 detik) membuat request
   * gagal P2028 saat pool koneksi di serverless hanya 1 dan satu halaman
   * mengirim beberapa request paralel; lebih baik menunggu antrean selesai.
   * `maxWait` < `connectionTimeoutMillis` agar pesan galat tetap berasal dari
   * Prisma, bukan dari driver pg.
   */
  private static readonly TRANSACTION_OPTIONS = { maxWait: 20_000, timeout: 30_000 } as const;

  constructor(@Inject('APP_CONFIG') config: AppConfig) {
    // Supabase transaction pooler: pakai pool kecil di serverless (mis. 1)
    // supaya jumlah koneksi tidak meledak mengikuti jumlah instance function.
    // Timeout eksplisit menghindari request menggantung saat pooler sibuk.
    const adapter = new PrismaPg({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_MAX,
      connectionTimeoutMillis: 25_000,
      idleTimeoutMillis: 10_000,
    });
    this.client = new PrismaClient({ adapter });
  }

  /**
   * Transaksi dengan anggaran tunggu eksplisit. Semua helper konteks RLS dan
   * penulisan domain memakai jalur ini supaya perilaku antrean pool konsisten.
   */
  transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.client.$transaction(fn, PrismaService.TRANSACTION_OPTIONS);
  }

  async onModuleInit(): Promise<void> {
    // PrismaPg (node-postgres) manages its own connection pool lazily.
    // Calling $connect() explicitly hangs indefinitely on Node 26 / tsx watch
    // in Windows due to a known pg event-loop interaction. The first query
    // will acquire a connection from the pool automatically.
  }

  async onModuleDestroy(): Promise<void> {
    // Pool teardown is handled by node-postgres on process exit.
    // Avoid await $disconnect() which can also stall graceful shutdown.
  }

  /**
   * Jalankan callback dalam transaksi dengan app.tenant_id disetel
   * transaction-scoped (SET LOCAL). Wajib untuk semua query operasional
   * tenant-scoped: RLS fail-closed tanpa konteks.
   */
  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.withRetryableTransaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  /**
   * Jalankan ulang seluruh transaksi pada serialization failure/deadlock.
   * Callback harus membatasi side effects ke transaksi (tanpa email/API luar),
   * sebab PostgreSQL membatalkan transaksi sebelumnya dan callback dipanggil
   * ulang pada transaksi baru. Hanya SQLSTATE 40001/40P01 yang dicoba ulang.
   */
  async withRetryableTransaction<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.transaction(fn);
      } catch (error) {
        const code = this.postgresSqlState(error);
        const delay = PrismaService.TRANSACTION_RETRY_DELAYS_MS[attempt];
        if (!code || !PrismaService.RETRYABLE_TRANSACTION_CODES.has(code) || delay === undefined) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private postgresSqlState(error: unknown): string | undefined {
    const visited = new Set<unknown>();
    const pending: unknown[] = [error];
    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current !== 'object' || current === null || visited.has(current)) continue;
      visited.add(current);
      const candidate = current as {
        code?: unknown;
        cause?: unknown;
        meta?: { code?: unknown; driverAdapterError?: unknown };
      };
      if (
        typeof candidate.code === 'string' &&
        PrismaService.RETRYABLE_TRANSACTION_CODES.has(candidate.code)
      ) {
        return candidate.code;
      }
      if (
        typeof candidate.meta?.code === 'string' &&
        PrismaService.RETRYABLE_TRANSACTION_CODES.has(candidate.meta.code)
      ) {
        return candidate.meta.code;
      }
      const adapterError = candidate.meta?.driverAdapterError;
      if (adapterError && typeof adapterError === 'object') {
        const adapterCause = (adapterError as { cause?: { originalCode?: unknown } }).cause;
        if (
          typeof adapterCause?.originalCode === 'string' &&
          PrismaService.RETRYABLE_TRANSACTION_CODES.has(adapterCause.originalCode)
        ) {
          return adapterCause.originalCode;
        }
        pending.push(adapterError);
        if (adapterCause && typeof adapterCause === 'object') pending.push(adapterCause);
      }
      pending.push(candidate.cause);
    }
    return undefined;
  }

  /**
   * Set konteks tenant pada transaksi yang sudah berjalan. Dipakai setelah
   * resolusi tenant publik (slug/token portal) sebelum query tenant-scoped.
   */
  async setTenant(tenantId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
  }

  /**
   * Resolusi tenant publik berdasarkan slug tanpa sesi. Policy migration 019
   * hanya membuka baris tenants yang slug-nya cocok dengan
   * `app.public_tenant_slug`; setelah tenantId diketahui, pemanggil wajib
   * memakai `setTenant`/`withTenant` untuk query katalog.
   */
  async withPublicTenantSlug<T>(
    slug: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.public_tenant_slug', ${slug}, true)`;
      return fn(tx);
    });
  }

  /**
   * Resolusi tenant publik berdasarkan hostname kustom (`tenant_domains`).
   * Policy migration 020 hanya membuka baris yang hostname-nya persis sama
   * dengan `app.public_hostname`. Pemanggil wajib menyetel `app.tenant_id`
   * setelah tenantId ditemukan sebelum membaca tabel tenant-scoped lain.
   */
  async withPublicHostname<T>(
    hostname: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.public_hostname', ${hostname}, true)`;
      return fn(tx);
    });
  }

  /**
   * Akses portal pesanan tamu berdasarkan hash token. Policy migration 019
   * hanya membuka baris `public_order_access` yang token hash-nya cocok.
   * Pemanggil wajib menyetel `app.tenant_id` setelah baris ditemukan.
   */
  async withPortalToken<T>(
    tokenHash: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.portal_token_hash', ${tokenHash}, true)`;
      return fn(tx);
    });
  }

  /**
   * Jalankan callback dengan konteks TOKEN UNDANGAN (`app.invitation_token_hash`).
   * Dipakai `POST /auth/invitations/accept` sebelum tenant diketahui: policy
   * migration 007 hanya membuka baris yang token hash-nya cocok. Setelah
   * tenantId terbaca, pemanggil menyetel `app.tenant_id` di transaksi yang
   * sama untuk menyelesaikan membership + audit.
   */
  async withInvitationToken<T>(
    tokenHash: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.invitation_token_hash', ${tokenHash}, true)`;
      return fn(tx);
    });
  }

  /**
   * Jalankan callback dengan konteks SISTEM OUTBOX (`app.outbox_system = 'on'`).
   * Policy migration 009 membuka SELECT/UPDATE seluruh baris `outbox_events`
   * untuk worker. Tidak membuka INSERT: event tetap ditulis transaksi domain
   * dengan `app.tenant_id` (policy migration 008).
   */
  async withOutboxSystem<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.outbox_system', 'on', true)`;
      return fn(tx);
    });
  }

  /**
   * Jalankan callback dengan konteks RECONCILER (`app.subscription_reconciler`).
   * Policy migration 015 hanya membuka SELECT pada `tenants` dan
   * `subscriptions`; transisi status tetap memakai `withTenant` sehingga tidak
   * ada penulisan lintas tenant. Dipakai untuk menemukan trial/grace yang
   * sudah berakhir tanpa melonggarkan policy tenant biasa.
   */
  async withSubscriptionReconciler<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.subscription_reconciler', 'on', true)`;
      return fn(tx);
    });
  }

  /**
   * Jalankan callback dengan konteks PENGINGAT BILLING (`app.billing_reminder`).
   * Policy migration 030 hanya membuka SELECT pada `subscription_invoices`,
   * dipakai job pengingat untuk menemukan tagihan PENDING lintas tenant.
   * Klaim dan audit tetap dijalankan pada `withTenant` masing-masing.
   */
  async withBillingReminder<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.billing_reminder', 'on', true)`;
      return fn(tx);
    });
  }

  /**
   * Jalankan callback dengan konteks ADMIN PLATFORM (`app.platform_admin`).
   * Policy migration `20261029100000_platform_admin_tenant_directory` hanya
   * membuka SELECT pada `tenants`; tabel tenant-scoped lain (members, katalog,
   * order, dst.) tetap tertutup. Konteks ini bukan pengganti otorisasi:
   * pemanggil wajib sudah memverifikasi sesi admin + permission backend.
   */
  async withPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_admin', 'on', true)`;
      return fn(tx);
    });
  }

  /**
   * Jalankan callback dengan konteks AKTOR (`app.user_id`) untuk query yang
   * memang perlu melintasi tenant milik aktor itu sendiri — misalnya
   * `GET /tenants`. Policy actor (migration 006) membatasi baca hanya ke baris
   * milik aktor; penulisan tetap memerlukan `app.tenant_id`.
   */
  async withActor<T>(
    actorUserId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${actorUserId}, true)`;
      return fn(tx);
    });
  }
}

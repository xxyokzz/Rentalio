import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@rentalio/database';
import type { AppConfig } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Bentuk event yang diserahkan ke handler (payload domain apa adanya). */
export interface OutboxEventRecord {
  id: string;
  tenantId: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  createdAt: Date;
  retryCount: number;
}

export interface OutboxEventHandler {
  eventType: string;
  handle(event: OutboxEventRecord): Promise<void>;
}

export interface OutboxRunResult {
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  /** Klaim/finalisasi dilewati karena lease sudah diambil proses lain. */
  skipped: number;
}

/**
 * Worker outbox — at-least-once delivery.
 *
 * Alur:
 * 1. Klaim batch dengan `FOR UPDATE SKIP LOCKED` + lease di `nextAttemptAt`,
 *    sehingga dua worker tidak memproses event yang sama.
 * 2. Handler dijalankan di luar transaksi (efek eksternal aman).
 * 3. Sukses → `publishedAt`; gagal → `retryCount` + backoff eksponensial,
 *    lalu `deadLetteredAt` setelah batas percobaan.
 *
 * Crash setelah handler sukses tetapi sebelum `publishedAt` tersimpan dapat
 * menyebabkan pengiriman ulang; karena itu handler wajib idempoten. Lease
 * memastikan baris yang tertinggal dapat diklaim worker lain setelah
 * `OUTBOX_LEASE_MS`.
 */
@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private readonly handlers = new Map<string, OutboxEventHandler>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  registerHandler(handler: OutboxEventHandler): void {
    this.handlers.set(handler.eventType, handler);
  }

  onModuleInit(): void {
    if (!this.config.OUTBOX_WORKER_ENABLED) return;
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Mulai polling periodik. Interval di-unref agar tidak menahan proses. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.OUTBOX_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Satu putaran klaim + proses. `now` dapat diinjeksi untuk test/backoff. */
  async runOnce(now: Date = new Date()): Promise<OutboxRunResult> {
    const leaseUntil = new Date(now.getTime() + this.config.OUTBOX_LEASE_MS);
    const claimed = await this.claimBatch(now, leaseUntil);

    const result: OutboxRunResult = {
      claimed: claimed.length,
      published: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
    };

    for (const event of claimed) {
      const handler = this.handlers.get(event.eventType);
      try {
        if (!handler) {
          throw new Error(`NO_HANDLER: ${event.eventType}`);
        }
        await handler.handle(event);

        const updated = await this.prisma.withOutboxSystem((tx) =>
          tx.outboxEvent.updateMany({
            where: {
              id: event.id,
              publishedAt: null,
              nextAttemptAt: leaseUntil,
            },
            data: { publishedAt: new Date(), lastError: null },
          }),
        );
        if (updated.count === 1) result.published += 1;
        else result.skipped += 1;
      } catch (err) {
        const outcome = await this.recordFailure(event, leaseUntil, now, err);
        if (outcome === 'retried') result.retried += 1;
        else if (outcome === 'dead') result.deadLettered += 1;
        else result.skipped += 1;
      }
    }

    return result;
  }

  private async claimBatch(now: Date, leaseUntil: Date): Promise<OutboxEventRecord[]> {
    return this.prisma.withOutboxSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "outbox_events"
        WHERE "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        ORDER BY "createdAt" ASC
        LIMIT ${this.config.OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `);
      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.id);
      await tx.outboxEvent.updateMany({
        where: { id: { in: ids } },
        data: { nextAttemptAt: leaseUntil },
      });

      const events = await tx.outboxEvent.findMany({ where: { id: { in: ids } } });
      return events
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((event) => ({
          id: event.id,
          tenantId: event.tenantId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          payload: event.payload as unknown,
          createdAt: event.createdAt,
          retryCount: event.retryCount,
        }));
    });
  }

  private async recordFailure(
    event: OutboxEventRecord,
    leaseUntil: Date,
    now: Date,
    err: unknown,
  ): Promise<'retried' | 'dead' | 'skipped'> {
    const attempt = event.retryCount + 1;
    const isDead = attempt >= this.config.OUTBOX_MAX_ATTEMPTS;
    const delayMs = Math.min(
      this.config.OUTBOX_BACKOFF_BASE_MS * 2 ** (attempt - 1),
      this.config.OUTBOX_BACKOFF_MAX_MS,
    );
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);

    const updated = await this.prisma.withOutboxSystem((tx) =>
      tx.outboxEvent.updateMany({
        where: {
          id: event.id,
          publishedAt: null,
          nextAttemptAt: leaseUntil,
        },
        data: isDead
          ? {
              retryCount: attempt,
              lastError: message,
              nextAttemptAt: null,
              deadLetteredAt: now,
            }
          : {
              retryCount: attempt,
              lastError: message,
              nextAttemptAt: new Date(now.getTime() + delayMs),
            },
      }),
    );

    if (updated.count === 0) return 'skipped';
    return isDead ? 'dead' : 'retried';
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.runOnce();
      if (result.claimed > 0) {
        this.logger.log(
          `outbox: claimed=${result.claimed} published=${result.published} ` +
            `retried=${result.retried} dead=${result.deadLettered} skipped=${result.skipped}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `outbox run gagal: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

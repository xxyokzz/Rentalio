import { Injectable } from '@nestjs/common';
import type { CronRunStatus, Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PlatformCronRunQueryDto } from './platform-admin.dto.js';

const CRON_JOBS = ['outbox', 'subscriptions', 'billingReminders'] as const;

export type CronJobName = (typeof CRON_JOBS)[number];
export type CronJobState = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

/**
 * Status per job diturunkan dari dua sumber yang sudah dicatat controller:
 * `failedJobs` untuk kegagalan, dan `results` untuk job yang selesai. Job yang
 * tidak muncul di keduanya berarti belum berjalan (mis. worker context gagal),
 * sehingga ditandai UNKNOWN — bukan diam-diam dianggap sukses.
 */
function jobStates(row: {
  failedJobs: string[];
  results: Prisma.JsonValue | null;
}): Record<CronJobName, CronJobState> {
  const results =
    row.results !== null &&
    typeof row.results === 'object' &&
    !Array.isArray(row.results)
      ? (row.results as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    CRON_JOBS.map((name) => [
      name,
      row.failedJobs.includes(name)
        ? 'FAILED'
        : Object.prototype.hasOwnProperty.call(results, name)
          ? 'SUCCEEDED'
          : 'UNKNOWN',
    ]),
  ) as Record<CronJobName, CronJobState>;
}

/**
 * Riwayat cron untuk Admin Platform (`GET /platform-admin/cron-runs`).
 *
 * Read-only: halaman ini tidak menjalankan job. Data berasal dari tabel
 * platform-level `cron_runs`, tanpa tenant context. Hasil job hanya berisi
 * hitungan operasional, bukan data pelanggan.
 */
@Injectable()
export class PlatformCronService {
  constructor(private readonly prisma: PrismaService) {}

  async listRuns(query: PlatformCronRunQueryDto) {
    const where: Prisma.CronRunWhereInput = query.status
      ? { status: query.status as CronRunStatus }
      : {};

    const [rows, total] = await Promise.all([
      this.prisma.client.cronRun.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          status: true,
          durationMs: true,
          failedJobs: true,
          results: true,
          alertedAt: true,
        },
      }),
      this.prisma.client.cronRun.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        status: row.status,
        durationMs: row.durationMs,
        failedJobs: row.failedJobs,
        results: row.results,
        alertedAt: row.alertedAt,
        jobs: jobStates(row),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }
}

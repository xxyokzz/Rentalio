-- ============================================================
-- Rentalio — Migration 032: riwayat run cron untuk monitoring
--
-- Tabel platform-level (tanpa tenant) yang mencatat setiap putaran endpoint
-- cron Vercel: status, hasil per job, durasi, dan waktu alert. Endpoint status
-- membaca baris terbaru; alert email memakai `alertedAt` untuk cooldown.
-- Retensi 14 hari dijalankan aplikasi setelah insert.
--
-- Tidak ada RLS: tabel tidak berisi data tenant dan tidak diekspos ke role
-- anon/authenticated. Grant hanya diberikan ke role runtime sewain_dev.
-- ============================================================

CREATE TYPE "CronRunStatus" AS ENUM ('SUCCEEDED', 'PARTIAL', 'FAILED');

CREATE TABLE "cron_runs" (
    "id" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "CronRunStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "durationMs" INTEGER NOT NULL,
    "failedJobs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "results" JSONB,
    "alertedAt" TIMESTAMP(3),
    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cron_runs_startedAt_idx" ON "cron_runs"("startedAt");
CREATE INDEX "cron_runs_alertedAt_idx" ON "cron_runs"("alertedAt");

GRANT SELECT, INSERT, UPDATE, DELETE ON "cron_runs" TO sewain_dev;

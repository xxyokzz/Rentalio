import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module.js';
import { ConfigError } from './config/env.validation.js';

/**
 * Entrypoint proses worker (tanpa HTTP).
 *
 * Job periodik — reconciler subscription, outbox, dan pengingat tagihan — tidak
 * lagi hidup di proses API. Proses ini dapat dijalankan sebagai deployment
 * terpisah dan diskalakan horizontal selama flag job aktif.
 *
 * Flag job default MATI di API (fail-safe untuk test); di proses worker
 * flag tersebut default NYALA agar operator cukup menjalankan proses ini.
 */
async function bootstrap(): Promise<void> {
  loadEnv({ path: resolve(process.cwd(), '../../.env') });
  loadEnv();

  if (process.env.OUTBOX_WORKER_ENABLED === undefined) {
    process.env.OUTBOX_WORKER_ENABLED = 'true';
  }
  if (process.env.SUBSCRIPTION_RECONCILER_ENABLED === undefined) {
    process.env.SUBSCRIPTION_RECONCILER_ENABLED = 'true';
  }
  if (process.env.BILLING_REMINDER_ENABLED === undefined) {
    process.env.BILLING_REMINDER_ENABLED = 'true';
  }
  // Proses worker tidak membuka listener HTTP; PORT hanya warisan validasi
  // konfigurasi bersama. Nilai dari .env (mis. placeholder kosong/0) tidak
  // boleh menggagalkan startup worker, jadi port dummy yang valid dipaksa.
  process.env.PORT = '3000';

  try {
    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['error', 'warn', 'log'],
    });

    Logger.log(
      'Worker berjalan: outbox + reconciler subscription + pengingat tagihan.',
      'Worker',
    );

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      Logger.log(`Menerima ${signal}; menutup worker...`, 'Worker');
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        process.stderr.write(
          `Gagal menutup worker: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Konfigurasi invalid: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

bootstrap().catch((err) => {
  process.stderr.write(`Gagal menjalankan worker: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});

import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { HttpErrorFilter } from './common/http-error.filter.js';
import { ConfigError, validateConfig } from './config/env.validation.js';

/**
 * Bootstrap API Rentalio.
 * - Muat .env dari root repo (Prisma 7 & NestJS tidak auto-load env).
 * - Validasi env saat startup (fail-fast, tanpa mencetak secret).
 * - ValidationPipe: whitelist + forbid properti tak dikenal pada endpoint.
 * - Error mapping konsisten, correlation ID, security headers sederhana.
 * - OpenAPI di /docs (development).
 */
async function bootstrap(): Promise<void> {
  // Cari .env di root monorepo, bukan hanya cwd.
  loadEnv({ path: resolve(process.cwd(), '../../.env') });
  loadEnv(); // nilai dari shell/.env cwd tetap menang bila sudah di-set

  let config;
  try {
    config = validateConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Pesan jelas tanpa nilai secret.
      process.stderr.write(`Konfigurasi invalid: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.enableCors({
    origin: config.CORS_ORIGINS,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());

  // Security headers sederhana ( helmet tidak dipakai agar dependency minimal ).
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  if (config.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Rentalio API')
      .setDescription('REST API Rentalio — kontrak OpenAPI sumber tunggal')
      .setVersion('1.0')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(config.PORT);
  Logger.log(`API berjalan pada http://localhost:${config.PORT}/api/v1`, 'Bootstrap');
}

bootstrap().catch((err) => {
  process.stderr.write(`Gagal menjalankan API: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});

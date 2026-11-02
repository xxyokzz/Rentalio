import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { StructuredLogger } from './logger.service.js';

/**
 * Log akses HTTP satu baris per request.
 *
 * Yang dicatat hanya metadata operasional — method, path tanpa query string,
 * status, durasi, correlation ID, dan user ID. Body, header, dan query TIDAK
 * dicatat agar token/OTP tidak pernah menyentuh log; bila suatu saat field
 * sensitif ditambahkan, `StructuredLogger` tetap meredaksinya.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(private readonly logger: StructuredLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedNs = process.hrtime.bigint() - startedAt;
      this.logger.info('http_request', {
        method: req.method,
        // Token portal adalah kredensial: jangan pernah masuk log.
        path: req.path.replace(
          /^(\/api\/v1)?\/portal\/orders\/[^/]+/,
          '$1/portal/orders/[redacted]',
        ),
        status: res.statusCode,
        durationMs: Math.round(Number(elapsedNs) / 1e4) / 100,
        correlationId: req.correlationId,
        userId: req.session?.userId,
      });
    });
    next();
  }
}

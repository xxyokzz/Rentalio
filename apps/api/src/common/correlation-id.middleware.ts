import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Correlation ID: terima X-Correlation-ID dari client bila valid,
 * selalu generate baru bila tidak ada. Dilekatkan ke response header.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-correlation-id');
    const id =
      incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    req.correlationId = id;
    res.setHeader('X-Correlation-ID', id);
    next();
  }
}

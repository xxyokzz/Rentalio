import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * CSRF middleware no-op: validasi CSRF sebenarnya dilakukan CsrfGuard
 * (perlu async DB lookup). Middleware ini hanya menandai method mutasi
 * berbasis cookie agar guard dapat memfilter.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    next();
  }
}

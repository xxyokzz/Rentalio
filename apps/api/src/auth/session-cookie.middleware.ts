import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthService, SESSION_COOKIE } from './auth.service.js';
import type { AppConfig } from '../config/env.validation.js';

/**
 * Session cookie middleware: baca rentalio_session, resolve sesi server-side,
 * lekatkan ke req.session. Tidak ada payload yang dipercaya dari cookie —
 * token hanya dipakai sebagai lookup ke hash di database.
 */
@Injectable()
export class SessionCookieMiddleware implements NestMiddleware {
  constructor(
    private readonly auth: AuthService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const token = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ];
    req.session = (await this.auth.resolveSession(token)) ?? undefined;
    next();
  }
}

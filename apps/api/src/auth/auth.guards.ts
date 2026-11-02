import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { AppConfig } from '../config/env.validation.js';

/**
 * Guard dipisah dari auth.module.ts untuk menghindari circular import
 * (controller → module → controller) yang membuat guard undefined saat
 * decorator @UseGuards dievaluasi.
 */

/** Guard: wajib sesi valid. */
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    }
    return true;
  }
}

/**
 * Guard CSRF untuk mutasi berbasis cookie session:
 * wajib X-CSRF-Token yang cocok dengan hash terikat sesi + Origin valid.
 * CORS allowlist bukan pengganti CSRF (dokumen 10).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { session?: { id: string } }>();
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    }

    const origin = req.header('origin');
    if (origin && !this.config.CORS_ORIGINS.includes(origin)) {
      throw new ApiError(ErrorCode.CSRF_VALIDATION_FAILED, 'Origin tidak diizinkan.');
    }

    const presented = req.header('x-csrf-token');
    if (!presented || !(await this.auth.validateCsrf(req.session.id, presented))) {
      throw new ApiError(
        ErrorCode.CSRF_VALIDATION_FAILED,
        'Token CSRF tidak valid.',
      );
    }
    return true;
  }
}

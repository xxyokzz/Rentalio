import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Optional,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import {
  ApiError,
  ApiErrorBody,
  ERROR_STATUS,
  ErrorCode,
} from './errors.js';
import { StructuredLogger } from './logger.service.js';
import { ApiFailureAlertService } from '../monitoring/api-failure-alert.service.js';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger: StructuredLogger;
  private readonly alerts?: ApiFailureAlertService;

  // Semua parameter opsional agar `new HttpErrorFilter()` tetap jalan di test;
  // NestJS menyuntikkan logger dan layanan alert bila filter didaftarkan sebagai
  // provider (AppModule + main.ts).
  constructor(
    @Optional() logger?: StructuredLogger,
    @Optional() alerts?: ApiFailureAlertService,
  ) {
    this.logger = logger ?? new StructuredLogger();
    this.alerts = alerts;
  }

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();
    const correlationId = request.correlationId ?? 'unknown';

    let status = ERROR_STATUS[ErrorCode.INTERNAL_ERROR];
    let code: ErrorCode = ErrorCode.INTERNAL_ERROR;
    let message = 'Terjadi kesalahan internal.';
    let details: unknown;

    if (exception instanceof ApiError) {
      status = ERROR_STATUS[exception.code];
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      // NestJS validation pipe → 400 VALIDATION_ERROR
      code =
        status === 400
          ? ErrorCode.VALIDATION_ERROR
          : status === 401
            ? ErrorCode.UNAUTHENTICATED
            : status === 403
              ? ErrorCode.PERMISSION_DENIED
              : status === 404
                ? ErrorCode.NOT_FOUND
                : status === 429
                  ? ErrorCode.RATE_LIMITED
                  : ErrorCode.INTERNAL_ERROR;
      message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message?.toString() ??
            exception.message);
    } else {
      // Jangan pernah membocorkan stack trace ke response (dokumen 10).
      // Log terstruktur meredaksi token/cookie/OTP di pesan maupun stack.
      this.logger.error('unhandled_exception', {
        method: request.method,
        path: request.path,
        correlationId,
        error:
          exception instanceof Error
            ? { name: exception.name, message: exception.message, stack: exception.stack }
            : exception,
      });
    }

    if (status >= 500) {
      const session = request.session;
      // Ditunggu dengan batas waktu di dalam service: function serverless
      // dibekukan begitu response selesai, sehingga pengiriman fire-and-forget
      // bisa hilang tanpa jejak. `report` tidak pernah melempar dan email
      // dibatasi cooldown, jadi hanya 5xx pertama per jendela yang menambah
      // latensi (maksimal beberapa detik).
      await this.alerts?.report({
        status,
        code,
        method: request.method,
        path: request.path,
        correlationId,
        userId: session?.userId,
        tenantSlug: session?.tenantSlug,
        error: exception,
      });
    }

    const body: ApiErrorBody = {
      error: {
        code,
        message,
        request_id: correlationId,
        ...(details !== undefined ? { details } : {}),
      },
    };
    response.status(status).json(body);
  }
}

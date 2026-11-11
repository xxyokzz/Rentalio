import { describe, expect, it } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { ApiError, ErrorCode } from '../../src/common/errors.js';
import { HttpErrorFilter } from '../../src/common/http-error.filter.js';
import { StructuredLogger } from '../../src/common/logger.service.js';
import type {
  ApiFailureAlertInput,
  ApiFailureAlertService,
} from '../../src/monitoring/api-failure-alert.service.js';

/** Host minimal: cukup untuk `switchToHttp()` yang dipakai filter. */
function createHost(request: Record<string, unknown>) {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

function createFilter() {
  const reported: ApiFailureAlertInput[] = [];
  const alerts = {
    report: async (input: ApiFailureAlertInput) => {
      reported.push(input);
    },
  } as unknown as ApiFailureAlertService;
  const filter = new HttpErrorFilter(new StructuredLogger(() => {}), alerts);
  return { filter, reported };
}

const p2028 = Object.assign(
  new Error('Transaction API error: Unable to start a transaction in the given time.'),
  { code: 'P2028' },
);

describe('HttpErrorFilter — peringatan dini 5xx', () => {
  it('melaporkan 5xx beserta konteks request ke layanan alert', () => {
    const { filter, reported } = createFilter();
    const { host, response } = createHost({
      method: 'GET',
      path: '/api/v1/tenants/7ef54012/products',
      correlationId: 'corr-9',
      session: { userId: 'user-1', tenantSlug: 'demo-sewa' },
    });

    filter.catch(new Error('boom', { cause: p2028 }), host);

    expect(response.statusCode).toBe(500);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      method: 'GET',
      path: '/api/v1/tenants/7ef54012/products',
      correlationId: 'corr-9',
      userId: 'user-1',
      tenantSlug: 'demo-sewa',
    });
    expect(reported[0]?.error).toBeInstanceOf(Error);
  });

  it('tidak melaporkan respons 4xx', () => {
    const { filter, reported } = createFilter();
    const { host, response } = createHost({
      method: 'GET',
      path: '/api/v1/tenants/7ef54012/products',
      correlationId: 'corr-10',
    });

    filter.catch(new ApiError(ErrorCode.NOT_FOUND, 'Tidak ditemukan.'), host);

    expect(response.statusCode).toBe(404);
    expect(reported).toHaveLength(0);
  });
});

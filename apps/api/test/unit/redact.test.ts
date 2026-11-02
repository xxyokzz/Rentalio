import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactString } from '../../src/common/redact.js';
import { StructuredLogger } from '../../src/common/logger.service.js';

describe('redact — field sensitif', () => {
  it('menyamarkan token, cookie, password, authorization, dan CSRF', () => {
    const result = redact({
      email: 'owner@contoh.com',
      password: 'rahasia-sekali',
      authorization: 'Bearer abc.def.ghi',
      cookie: 'rentalio_session=abc123',
      'x-csrf-token': 'csrf-123',
      csrfToken: 'csrf-456',
      nested: { sessionToken: 'sess-789', amount: 150000 },
    }) as Record<string, unknown>;

    expect(result.email).toBe('owner@contoh.com');
    expect(result.password).toBe(REDACTED);
    expect(result.authorization).toBe(REDACTED);
    expect(result.cookie).toBe(REDACTED);
    expect(result['x-csrf-token']).toBe(REDACTED);
    expect(result.csrfToken).toBe(REDACTED);
    expect((result.nested as Record<string, unknown>).sessionToken).toBe(REDACTED);
    expect((result.nested as Record<string, unknown>).amount).toBe(150000);
  });

  it('menyamarkan OTP 6 digit pada field code, tetapi bukan kode error', () => {
    expect(redact({ code: '123456' })).toEqual({ code: REDACTED });
    expect(redact({ otp: '1234' })).toEqual({ otp: REDACTED });
    expect(redact({ code: 'INVALID_STATE_TRANSITION' })).toEqual({
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('redact — pola di dalam string', () => {
  it('menyamarkan Bearer token dan cookie sesi', () => {
    const header =
      'Authorization: Bearer eyJhbGciOi.payload.sig; Cookie: rentalio_session=abc123; Path=/';
    const out = redactString(header);
    expect(out).not.toContain('eyJhbGciOi.payload.sig');
    expect(out).not.toContain('abc123');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).toContain('rentalio_session=[REDACTED]');
  });

  it('menyamarkan token/OTP di query string dan JSON string', () => {
    expect(redactString('/auth?otp=123456&email=a%40b.com')).toBe(
      '/auth?otp=[REDACTED]&email=a%40b.com',
    );
    expect(redactString('{"resetToken":"abc-123","email":"a@b.com"}')).toBe(
      '{"resetToken":"[REDACTED]","email":"a@b.com"}',
    );
  });

  it('menangani struktur melingkar dan BigInt tanpa melempar error', () => {
    const circular: Record<string, unknown> = { password: 'x' };
    circular.self = circular;
    const out = redact({ circular, penalty: 125000n }) as Record<string, unknown>;
    expect(out.penalty).toBe('125000');
    expect(JSON.stringify(out)).toContain('[Circular]');
  });
});

describe('StructuredLogger', () => {
  it('menulis satu baris JSON dengan metadata dan tanpa secret', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));

    logger.info('http_request', {
      method: 'POST',
      path: '/api/v1/auth/sessions',
      status: 201,
      correlationId: 'corr-1',
      accessToken: 'super-secret-token',
      authorization: 'Bearer abc.def',
      code: '654321',
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.level).toBe('info');
    expect(entry.service).toBe('rentalio-api');
    expect(entry.msg).toBe('http_request');
    expect(typeof entry.time).toBe('string');
    expect(entry.path).toBe('/api/v1/auth/sessions');
    expect(entry.accessToken).toBe(REDACTED);
    expect(entry.authorization).toBe(REDACTED);
    expect(entry.code).toBe(REDACTED);
    expect(lines[0]).not.toContain('super-secret-token');
    expect(lines[0]).not.toContain('abc.def');
    expect(lines[0]).not.toContain('654321');
  });

  it('meredaksi pesan error yang mengandung token', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger((line) => lines.push(line));
    logger.error('unhandled_exception', {
      error: new Error('Gagal memakai Bearer zzz.yyy.xxx'),
    });
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    const error = entry.error as Record<string, unknown>;
    expect(error.message).toContain('Bearer [REDACTED]');
    expect(lines[0]).not.toContain('zzz.yyy.xxx');
    expect(entry.level).toBe('error');
  });
});

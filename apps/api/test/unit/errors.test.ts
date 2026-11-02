import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, ErrorCode } from '../../src/common/errors.js';

describe('error contract (ADR-001 §6 + Notion 04)', () => {
  it('status code sesuai kontrak untuk setiap error code', () => {
    expect(ERROR_STATUS[ErrorCode.VALIDATION_ERROR]).toBe(400);
    expect(ERROR_STATUS[ErrorCode.UNAUTHENTICATED]).toBe(401);
    expect(ERROR_STATUS[ErrorCode.INVALID_CREDENTIALS]).toBe(401);
    expect(ERROR_STATUS[ErrorCode.OTP_INVALID_OR_EXPIRED]).toBe(400);
    expect(ERROR_STATUS[ErrorCode.RESET_TOKEN_INVALID_OR_EXPIRED]).toBe(400);
    expect(ERROR_STATUS[ErrorCode.PERMISSION_DENIED]).toBe(403);
    expect(ERROR_STATUS[ErrorCode.CSRF_VALIDATION_FAILED]).toBe(403);
    expect(ERROR_STATUS[ErrorCode.NOT_FOUND]).toBe(404);
    expect(ERROR_STATUS[ErrorCode.INVALID_STATE_TRANSITION]).toBe(409);
    expect(ERROR_STATUS[ErrorCode.AVAILABILITY_CONFLICT]).toBe(409);
    expect(ERROR_STATUS[ErrorCode.IDEMPOTENCY_KEY_REUSED]).toBe(409);
    expect(ERROR_STATUS[ErrorCode.BUSINESS_RULE_VIOLATION]).toBe(422);
    expect(ERROR_STATUS[ErrorCode.PAYMENT_METHOD_DISABLED]).toBe(422);
    expect(ERROR_STATUS[ErrorCode.RATE_LIMITED]).toBe(429);
    expect(ERROR_STATUS[ErrorCode.INTERNAL_ERROR]).toBe(500);
  });

  it('setiap error code punya mapping HTTP status (tidak ada yang undefined)', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_STATUS[code], `${code} harus ada di ERROR_STATUS`).toBeDefined();
    }
  });

  it('IDEMPOTENCY_KEY_REUSED → 409 (Notion 04 kontrak)', () => {
    expect(ERROR_STATUS[ErrorCode.IDEMPOTENCY_KEY_REUSED]).toBe(409);
  });
});

/**
 * Kontrak error stabil (ADR-001 §6 + dokumen 03 bagian OpenAPI).
 * Error code tidak boleh berubah tanpa review kontrak.
 */
export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  NOT_FOUND = 'NOT_FOUND',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
  AVAILABILITY_CONFLICT = 'AVAILABILITY_CONFLICT',
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  BUSINESS_RULE_VIOLATION = 'BUSINESS_RULE_VIOLATION',
  PAYMENT_METHOD_DISABLED = 'PAYMENT_METHOD_DISABLED',
  TENANT_RESTRICTED = 'TENANT_RESTRICTED',
  /** Pembayaran langganan tidak tersedia (kredensial provider / harga belum diatur). */
  BILLING_NOT_CONFIGURED = 'BILLING_NOT_CONFIGURED',
  /** Provider pembayaran menolak atau tidak dapat dihubungi. */
  PAYMENT_PROVIDER_ERROR = 'PAYMENT_PROVIDER_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  CSRF_VALIDATION_FAILED = 'CSRF_VALIDATION_FAILED',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  OTP_INVALID_OR_EXPIRED = 'OTP_INVALID_OR_EXPIRED',
  RESET_TOKEN_INVALID_OR_EXPIRED = 'RESET_TOKEN_INVALID_OR_EXPIRED',
  INVITATION_INVALID_OR_EXPIRED = 'INVITATION_INVALID_OR_EXPIRED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  MFA_REQUIRED = 'MFA_REQUIRED',
  MFA_INVALID_OR_EXPIRED = 'MFA_INVALID_OR_EXPIRED',
  REAUTHENTICATION_REQUIRED = 'REAUTHENTICATION_REQUIRED',
}

export const ERROR_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.OTP_INVALID_OR_EXPIRED]: 400,
  [ErrorCode.RESET_TOKEN_INVALID_OR_EXPIRED]: 400,
  [ErrorCode.INVITATION_INVALID_OR_EXPIRED]: 400,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.CSRF_VALIDATION_FAILED]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.INVALID_STATE_TRANSITION]: 409,
  [ErrorCode.AVAILABILITY_CONFLICT]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,
  [ErrorCode.BUSINESS_RULE_VIOLATION]: 422,
  [ErrorCode.PAYMENT_METHOD_DISABLED]: 422,
  [ErrorCode.TENANT_RESTRICTED]: 403,
  [ErrorCode.BILLING_NOT_CONFIGURED]: 503,
  [ErrorCode.PAYMENT_PROVIDER_ERROR]: 502,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.MFA_REQUIRED]: 401,
  [ErrorCode.MFA_INVALID_OR_EXPIRED]: 401,
  [ErrorCode.REAUTHENTICATION_REQUIRED]: 403,
};

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /**
     * ID korelasi request — bernilai sama dengan header X-Correlation-ID.
     * Disebut request_id di kontrak OpenAPI (Notion 04) agar selaras dengan
     * terminologi REST publik; secara internal disebut correlationId.
     */
    request_id: string;
    /**
     * Detail aman untuk keputusan pengguna, misalnya daftar konflik
     * perpanjangan. Tidak boleh memuat stack trace, SQL, atau rahasia.
     */
    details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

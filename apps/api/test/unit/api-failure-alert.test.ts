import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config/env.validation.js';
import { StructuredLogger } from '../../src/common/logger.service.js';
import type { EmailService, OutgoingEmail } from '../../src/email/email.service.js';
import { ApiFailureAlertService } from '../../src/monitoring/api-failure-alert.service.js';

type LogLine = Record<string, unknown>;

function setup(config: Partial<AppConfig> = {}) {
  const lines: LogLine[] = [];
  const sent: OutgoingEmail[] = [];
  const logger = new StructuredLogger((line) => {
    lines.push(JSON.parse(line) as LogLine);
  });
  const email = {
    send: async (message: OutgoingEmail) => {
      sent.push(message);
    },
  } as unknown as EmailService;
  const service = new ApiFailureAlertService(
    {
      API_ALERT_EMAIL: 'ops@rentalio.test',
      API_ALERT_COOLDOWN_SECONDS: 300,
      ...config,
    } as AppConfig,
    logger,
    email,
  );
  return { service, lines, sent };
}

/** Error P2028 seperti yang muncul dari Prisma saat antrean transaksi habis. */
const p2028 = Object.assign(
  new Error('Transaction API error: Unable to start a transaction in the given time.'),
  { code: 'P2028' },
);

const failure500 = {
  status: 500,
  code: 'INTERNAL_ERROR',
  method: 'GET',
  path: '/api/v1/tenants/7ef54012-b50e-4c3e-af11-85a759859c1a/products',
  correlationId: 'corr-1',
  userId: 'user-1',
  tenantSlug: 'demo-sewa',
};

describe('ApiFailureAlertService', () => {
  it('mengirim satu email dan menandai P2028 sebagai kegagalan antrean transaksi', async () => {
    const { service, lines, sent } = setup();

    // Prisma membungkus error driver, jadi kode hanya terlihat di `cause`.
    await service.report({
      ...failure500,
      error: new Error('Invalid `prisma.$transaction()` invocation', { cause: p2028 }),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ops@rentalio.test');
    expect(sent[0]?.subject).toContain('antrean transaksi');
    expect(sent[0]?.body).toContain('P2028');
    expect(sent[0]?.body).toContain('corr-1');
    expect(sent[0]?.body).toContain('demo-sewa');

    const alert = lines.find((line) => line.msg === 'api_failure_alert');
    expect(alert?.failureKind).toBe('transaction_queue');
    expect(alert?.prismaCode).toBe('P2028');
    expect(alert?.status).toBe(500);
    expect(lines.some((line) => line.msg === 'api_alert_sent')).toBe(true);
  });

  it('membedakan 5xx biasa dari kegagalan antrean transaksi', async () => {
    const { service, lines, sent } = setup();

    await service.report({ ...failure500, status: 502, error: new Error('Resend down') });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('kesalahan server');
    expect(sent[0]?.subject).not.toContain('antrean transaksi');
    expect(lines.find((line) => line.msg === 'api_failure_alert')?.failureKind).toBe(
      'server_error',
    );
  });

  it('mengabaikan respons 4xx', async () => {
    const { service, lines, sent } = setup();

    await service.report({ ...failure500, status: 404, code: 'NOT_FOUND' });

    expect(sent).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it('meredam alert berikutnya selama cooldown tetapi tetap mencatat log', async () => {
    const { service, lines, sent } = setup();

    await service.report({ ...failure500, error: p2028 });
    await service.report({ ...failure500, correlationId: 'corr-2', error: p2028 });

    expect(sent).toHaveLength(1);
    expect(lines.filter((line) => line.msg === 'api_failure_alert')).toHaveLength(2);
    const suppressed = lines.find((line) => line.msg === 'api_alert_suppressed');
    expect(suppressed?.suppressedSinceLastAlert).toBe(1);
  });

  it('melewati email bila penerima tidak dikonfigurasi, dengan fallback operator', async () => {
    const tanpaPenerima = setup({ API_ALERT_EMAIL: undefined });
    await tanpaPenerima.service.report({ ...failure500, error: p2028 });
    expect(tanpaPenerima.sent).toHaveLength(0);
    expect(
      tanpaPenerima.lines.find((line) => line.msg === 'api_alert_skipped')?.reason,
    ).toContain('kosong');

    const fallback = setup({
      API_ALERT_EMAIL: undefined,
      PLATFORM_OPERATOR_EMAIL: 'operator@rentalio.test',
    });
    await fallback.service.report({ ...failure500, error: p2028 });
    expect(fallback.sent[0]?.to).toBe('operator@rentalio.test');
  });

  it('tidak pernah melempar saat pengiriman email gagal', async () => {
    const lines: LogLine[] = [];
    const logger = new StructuredLogger((line) => {
      lines.push(JSON.parse(line) as LogLine);
    });
    const email = {
      send: async () => {
        throw new Error('Resend 500');
      },
    } as unknown as EmailService;
    const service = new ApiFailureAlertService(
      {
        API_ALERT_EMAIL: 'ops@rentalio.test',
        API_ALERT_COOLDOWN_SECONDS: 300,
      } as AppConfig,
      logger,
      email,
    );

    await expect(service.report({ ...failure500, error: p2028 })).resolves.toBeUndefined();
    expect(lines.some((line) => line.msg === 'api_alert_failed')).toBe(true);
  });

  it('menyamarkan token portal sebelum masuk log maupun email', async () => {
    const { service, sent, lines } = setup();

    await service.report({
      ...failure500,
      path: '/api/v1/portal/orders/tok-rahasia-123',
      error: new Error('boom'),
    });

    expect(sent[0]?.body).not.toContain('tok-rahasia-123');
    expect(sent[0]?.body).toContain('/portal/orders/[redacted]');
    expect(lines.find((line) => line.msg === 'api_failure_alert')?.path).toBe(
      '/api/v1/portal/orders/[redacted]',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/prisma/prisma.service.js';

const config = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/rentalio',
  DATABASE_POOL_MAX: 5,
} as never;

function withStubbedClient() {
  const service = new PrismaService(config);
  const calls: { options: unknown }[] = [];
  (service as unknown as { client: unknown }).client = {
    $transaction: (fn: () => Promise<unknown>, options: unknown) => {
      calls.push({ options });
      return fn();
    },
  };
  return { service, calls };
}

describe('PrismaService.transaction', () => {
  it('memberi anggaran tunggu eksplisit agar antrean pool tidak jadi P2028', async () => {
    const { service, calls } = withStubbedClient();
    await expect(service.transaction(async () => 'ok')).resolves.toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ maxWait: 20_000, timeout: 30_000 });
  });

  it('withTenant memakai jalur transaksi yang sama', async () => {
    const { service, calls } = withStubbedClient();
    const tx = { $executeRaw: () => Promise.resolve(1) };
    (service as unknown as { client: unknown }).client = {
      $transaction: (fn: (client: unknown) => Promise<unknown>, options: unknown) => {
        calls.push({ options });
        return fn(tx);
      },
    };
    await expect(service.withTenant('11111111-1111-4111-8111-111111111111', async () => 'ok')).resolves.toBe(
      'ok',
    );
    expect(calls[0]?.options).toEqual({ maxWait: 20_000, timeout: 30_000 });
  });
});

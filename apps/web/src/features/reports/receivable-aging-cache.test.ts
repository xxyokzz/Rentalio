import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { invalidateReceivableAging, loadReceivableAging } from "./receivable-aging-cache";

const api = vi.hoisted(() => ({ receivableAging: vi.fn() }));

vi.mock("@/shared/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/endpoints")>();
  return { ...actual, reportApi: { ...actual.reportApi, ...api } };
});

function sample(alertCount: number): Schema<"ReceivableAgingResponse"> {
  return {
    asOf: "2026-11-18T00:00:00.000Z",
    thresholds: { invoiceDays: 14, penaltyDays: 7 },
    outstanding: { orders: 0, amount: "0", overdueOrders: 0, overdueAmount: "0", oldestDays: 0 },
    penalties: { orders: 0, amount: "0", agedOrders: 0, agedAmount: "0", oldestDays: 0 },
    buckets: [],
    alertCount,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T00:00:00.000Z"));
  invalidateReceivableAging();
  api.receivableAging.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  invalidateReceivableAging();
});

describe("cache ringkasan umur piutang", () => {
  it("memakai hasil cache selama TTL sehingga badge dan Ringkasan berbagi satu panggilan", async () => {
    api.receivableAging.mockResolvedValue(sample(2));

    const badge = await loadReceivableAging("tenant-1");
    const ringkasan = await loadReceivableAging("tenant-1");

    expect(badge).toBe(ringkasan);
    expect(api.receivableAging).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    await loadReceivableAging("tenant-1");
    expect(api.receivableAging).toHaveBeenCalledTimes(2);
  });

  it("menggabungkan permintaan bersamaan menjadi satu request", async () => {
    let resolve: (value: Schema<"ReceivableAgingResponse">) => void = () => {};
    api.receivableAging.mockReturnValue(
      new Promise<Schema<"ReceivableAgingResponse">>((done) => {
        resolve = done;
      }),
    );

    const first = loadReceivableAging("tenant-1");
    const second = loadReceivableAging("tenant-1");
    resolve(sample(1));

    await expect(first).resolves.toMatchObject({ alertCount: 1 });
    await expect(second).resolves.toMatchObject({ alertCount: 1 });
    expect(api.receivableAging).toHaveBeenCalledTimes(1);
  });

  it("tidak menyimpan kegagalan dan memisahkan cache per tenant", async () => {
    api.receivableAging.mockRejectedValueOnce(new Error("gagal")).mockResolvedValue(sample(3));

    await expect(loadReceivableAging("tenant-1")).rejects.toThrow("gagal");
    await expect(loadReceivableAging("tenant-1")).resolves.toMatchObject({ alertCount: 3 });
    await loadReceivableAging("tenant-2");

    expect(api.receivableAging).toHaveBeenCalledTimes(3);
  });
});

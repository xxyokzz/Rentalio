import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyExtensionActivity } from "@/shared/events/extension-activity";
import { invalidateConflictOverview, loadConflictOverview } from "./conflict-overview-cache";

const conflictOverview = vi.fn();

vi.mock("@/shared/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/endpoints")>();
  return {
    ...actual,
    extensionApi: {
      ...actual.extensionApi,
      conflictOverview: (...args: unknown[]) => conflictOverview(...args),
    },
  };
});

function summary(openConflicts: number) {
  return {
    summary: { openConflicts, resolvedConflicts: 0, flaggedOrders: 0, flaggedReservations: 0 },
  };
}

beforeEach(() => {
  conflictOverview.mockReset();
  invalidateConflictOverview();
});

describe("loadConflictOverview", () => {
  it("menggabungkan dua pemanggil bersamaan menjadi satu request", async () => {
    conflictOverview.mockResolvedValue(summary(1));

    const [first, second] = await Promise.all([
      loadConflictOverview("tenant-1", "OPEN"),
      loadConflictOverview("tenant-1", "OPEN"),
    ]);

    expect(conflictOverview).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("memakai hasil cache untuk pemanggilan berurutan dalam TTL", async () => {
    conflictOverview.mockResolvedValue(summary(1));

    await loadConflictOverview("tenant-1", "OPEN");
    await loadConflictOverview("tenant-1", "OPEN");

    expect(conflictOverview).toHaveBeenCalledTimes(1);
    expect(conflictOverview).toHaveBeenCalledWith("tenant-1", "OPEN");
  });

  it("memisahkan cache per filter status", async () => {
    conflictOverview.mockResolvedValue(summary(1));

    await loadConflictOverview("tenant-1", "OPEN");
    await loadConflictOverview("tenant-1", "ALL");

    expect(conflictOverview).toHaveBeenCalledTimes(2);
  });

  it("memuat ulang setelah TTL singkat lewat", async () => {
    vi.useFakeTimers();
    try {
      conflictOverview.mockResolvedValue(summary(1));

      await loadConflictOverview("tenant-1", "OPEN");
      vi.setSystemTime(Date.now() + 6_000);
      await loadConflictOverview("tenant-1", "OPEN");

      expect(conflictOverview).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("membuang cache saat ada sinyal aktivitas perpanjangan", async () => {
    conflictOverview.mockResolvedValue(summary(1));

    await loadConflictOverview("tenant-1", "OPEN");
    notifyExtensionActivity();
    await loadConflictOverview("tenant-1", "OPEN");

    expect(conflictOverview).toHaveBeenCalledTimes(2);
  });

  it("tidak menyimpan kegagalan sehingga percobaan berikutnya ke server", async () => {
    conflictOverview.mockRejectedValueOnce(new Error("jaringan putus"));
    await expect(loadConflictOverview("tenant-1", "OPEN")).rejects.toThrow("jaringan putus");

    conflictOverview.mockResolvedValue(summary(3));
    const result = await loadConflictOverview("tenant-1", "OPEN");

    expect(result.summary?.openConflicts).toBe(3);
    expect(conflictOverview).toHaveBeenCalledTimes(2);
  });
});

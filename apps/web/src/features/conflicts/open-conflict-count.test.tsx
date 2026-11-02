import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyExtensionActivity } from "@/shared/events/extension-activity";
import { invalidateConflictOverview } from "./conflict-overview-cache";
import { useOpenConflictCount } from "./open-conflict-count";

const conflictOverview = vi.fn();

let sessionRole: "OWNER" | "MANAGER" | "STAFF" | "CASHIER" = "MANAGER";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/conflicts",
}));

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({ role: sessionRole, tenantId: "tenant-1" }),
}));

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

function overview(openConflicts: number) {
  return { summary: { openConflicts, resolvedConflicts: 0, flaggedOrders: 0, flaggedReservations: 0 } };
}

// Vitest tanpa `globals` tidak memicu auto-cleanup React Testing Library.
afterEach(cleanup);

describe("useOpenConflictCount", () => {
  beforeEach(() => {
    conflictOverview.mockReset();
    // Cache ringkasan bersifat modul-level; bersihkan agar tiap test memakai
    // nilai mock-nya sendiri.
    invalidateConflictOverview();
    sessionRole = "MANAGER";
  });

  it("tidak memanggil API bagi peran tanpa izin resolve_conflict", () => {
    sessionRole = "STAFF";
    const { result } = renderHook(() => useOpenConflictCount());
    expect(result.current).toBeNull();
    expect(conflictOverview).not.toHaveBeenCalled();
  });

  it("membaca summary.openConflicts dari ringkasan OPEN", async () => {
    conflictOverview.mockResolvedValue(overview(2));

    const { result } = renderHook(() => useOpenConflictCount());
    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current).toBe(2));
    expect(conflictOverview).toHaveBeenCalledWith("tenant-1", "OPEN");
  });

  it("tidak menampilkan badge saat tidak ada konflik terbuka", async () => {
    conflictOverview.mockResolvedValue(overview(0));
    const { result } = renderHook(() => useOpenConflictCount());
    await waitFor(() => expect(conflictOverview).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });

  it("turun segera setelah konflik ditandai selesai tanpa pindah halaman", async () => {
    conflictOverview.mockResolvedValue(overview(2));
    const { result } = renderHook(() => useOpenConflictCount());
    await waitFor(() => expect(result.current).toBe(2));

    conflictOverview.mockResolvedValue(overview(1));
    act(() => notifyExtensionActivity());

    await waitFor(() => expect(result.current).toBe(1));
    expect(conflictOverview).toHaveBeenCalledTimes(2);
  });
});

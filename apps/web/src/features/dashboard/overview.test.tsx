import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenConflictCount } from "@/features/conflicts/open-conflict-count";
import { invalidateConflictOverview } from "@/features/conflicts/conflict-overview-cache";
import { DashboardOverview } from "./overview";

/**
 * Regresi: halaman Ringkasan dan badge "Konflik perpanjangan" membaca
 * `GET /tenants/{id}/extension-conflicts` yang sama. Keduanya harus berbagi
 * cache singkat, sehingga satu kali render Ringkasan hanya memicu satu request.
 *
 * Test ini gagal bila Ringkasan kembali memanggil `extensionApi.conflictOverview`
 * langsung (di luar cache) — perilaku yang pernah membuat endpoint ringkasan
 * terpanggil dua kali setiap dashboard dibuka.
 */

const conflictOverview = vi.fn();
const listReservations = vi.fn();
const listOrders = vi.fn();
const listProducts = vi.fn();

// `className` ikut diteruskan supaya query kartu (`.focus-item`) tetap valid.
vi.mock("next/link", () => ({
  default: ({
    href,
    className,
    children,
  }: {
    href: string;
    className?: string;
    children: ReactNode;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app",
}));

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({
    tenantId: "tenant-1",
    role: "OWNER",
    tenant: { name: "QA Badge Rental", timezone: "Asia/Jakarta" },
  }),
}));

vi.mock("@/shared/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/endpoints")>();
  return {
    ...actual,
    reservationApi: { ...actual.reservationApi, list: (...args: unknown[]) => listReservations(...args) },
    orderApi: { ...actual.orderApi, list: (...args: unknown[]) => listOrders(...args) },
    catalogApi: { ...actual.catalogApi, listProducts: (...args: unknown[]) => listProducts(...args) },
    extensionApi: {
      ...actual.extensionApi,
      conflictOverview: (...args: unknown[]) => conflictOverview(...args),
    },
  };
});

/** Pemakai kedua endpoint ringkasan: badge menu konflik. */
function ConflictBadgeProbe() {
  useOpenConflictCount();
  return null;
}

function overview(openConflicts: number) {
  return {
    summary: { openConflicts, resolvedConflicts: 0, flaggedOrders: 0, flaggedReservations: 0 },
  };
}

// Vitest tanpa `globals` tidak memicu auto-cleanup React Testing Library.
afterEach(cleanup);

beforeEach(() => {
  conflictOverview.mockReset();
  listReservations.mockReset();
  listOrders.mockReset();
  listProducts.mockReset();
  invalidateConflictOverview();

  conflictOverview.mockResolvedValue(overview(1));
  listReservations.mockResolvedValue([]);
  listOrders.mockResolvedValue({ data: [], page: 1, pageSize: 100, total: 0 });
  listProducts.mockResolvedValue([]);
});

describe("DashboardOverview × badge konflik", () => {
  it("berbagi satu request ringkasan saat Ringkasan dan badge aktif bersamaan", async () => {
    render(
      <>
        <DashboardOverview />
        <ConflictBadgeProbe />
      </>,
    );

    // Tunggu halaman selesai memuat datanya (kartu konflik tampil).
    await waitFor(() => expect(screen.getAllByText(/Konflik perpanjangan/).length).toBeGreaterThan(0));

    expect(conflictOverview).toHaveBeenCalledTimes(1);
    expect(conflictOverview).toHaveBeenCalledWith("tenant-1", "OPEN");
  });

  it("menampilkan angka dari ringkasan yang sama di kartu Ringkasan", async () => {
    conflictOverview.mockResolvedValue(overview(3));

    const { container } = render(<DashboardOverview />);

    await waitFor(() => expect(conflictOverview).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const card = [...container.querySelectorAll(".focus-item")].find((element) =>
        element.textContent?.includes("Konflik perpanjangan"),
      );
      expect(card?.querySelector(".focus-value")?.textContent).toBe("3");
    });
  });
});

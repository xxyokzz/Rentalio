import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyExtensionActivity } from "@/shared/events/extension-activity";
import { NavCountBadge } from "@/shared/ui/nav-badge";
import { usePendingExtensionCount } from "./pending-extension-count";

const listTenant = vi.fn();

let sessionRole: "OWNER" | "MANAGER" | "STAFF" | "CASHIER" = "MANAGER";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/orders",
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
      listTenant: (...args: unknown[]) => listTenant(...args),
    },
  };
});

// Vitest tanpa `globals` tidak memicu auto-cleanup React Testing Library.
afterEach(cleanup);

describe("usePendingExtensionCount", () => {
  beforeEach(() => {
    listTenant.mockReset();
    sessionRole = "MANAGER";
  });

  it("tidak memanggil API bagi peran tanpa izin approve", () => {
    sessionRole = "STAFF";
    const { result } = renderHook(() => usePendingExtensionCount());
    expect(result.current).toBeNull();
    expect(listTenant).not.toHaveBeenCalled();
  });

  it("mengembalikan jumlah permintaan dari endpoint antrean", async () => {
    listTenant.mockResolvedValue([{ id: "ext-1" }, { id: "ext-2" }, { id: "ext-3" }]);

    const { result } = renderHook(() => usePendingExtensionCount());
    // Selama masih memuat tidak ada angka sehingga badge 0 palsu tidak muncul.
    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current).toBe(3));
    expect(listTenant).toHaveBeenCalledWith("tenant-1");
  });

  it("mengembalikan null ketika antrean kosong", async () => {
    listTenant.mockResolvedValue([]);
    const { result } = renderHook(() => usePendingExtensionCount());
    await waitFor(() => expect(listTenant).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });

  it("memuat ulang tanpa pindah halaman setelah keputusan perpanjangan", async () => {
    listTenant.mockResolvedValue([{ id: "ext-1" }, { id: "ext-2" }]);
    const { result } = renderHook(() => usePendingExtensionCount());
    await waitFor(() => expect(result.current).toBe(2));

    // Keputusan disetujui di halaman yang sama → sinyal aktivitas.
    listTenant.mockResolvedValue([{ id: "ext-2" }]);
    act(() => notifyExtensionActivity());

    await waitFor(() => expect(result.current).toBe(1));
    expect(listTenant).toHaveBeenCalledTimes(2);
  });
});

describe("NavCountBadge", () => {
  it("tidak merender apa pun tanpa angka", () => {
    const { container } = render(
      <NavCountBadge count={null} label="permintaan menunggu keputusan" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("menampilkan angka dan teks alternatif untuk pembaca layar", () => {
    render(<NavCountBadge count={2} label="permintaan menunggu keputusan" />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/2 permintaan menunggu keputusan/i)).toBeInTheDocument();
  });

  it("memakai warna bahaya untuk tugas mendesak", () => {
    render(<NavCountBadge count={1} label="konflik terbuka" tone="danger" />);
    expect(screen.getByText("1")).toHaveClass("nav-badge-danger");
  });
});

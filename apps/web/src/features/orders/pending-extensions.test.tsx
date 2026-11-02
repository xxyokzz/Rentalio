import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { PendingExtensionsPanel } from "./pending-extensions";

const listTenant = vi.fn();
const approve = vi.fn();
const reject = vi.fn();
const notify = vi.fn();

let sessionRole: "OWNER" | "MANAGER" | "STAFF" | "CASHIER" = "MANAGER";

vi.mock("@/shared/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/endpoints")>();
  return {
    ...actual,
    extensionApi: {
      ...actual.extensionApi,
      listTenant: (...args: unknown[]) => listTenant(...args),
      approve: (...args: unknown[]) => approve(...args),
      reject: (...args: unknown[]) => reject(...args),
    },
  };
});

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({
    role: sessionRole,
    tenantId: "tenant-1",
    tenant: { timezone: "Asia/Jakarta" },
  }),
}));

vi.mock("@/shared/ui/overlays", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/overlays")>();
  return {
    ...actual,
    useToast: () => ({ notify: (...args: unknown[]) => notify(...args) }),
  };
});

type Pending = Schema<"TenantExtensionRequest">;

function row(overrides: Partial<Pending> = {}): Pending {
  return {
    id: "ext-1",
    orderId: "order-1",
    status: "PENDING_APPROVAL",
    previousEndAt: "2026-11-03T00:00:00.000Z",
    requestedEndAt: "2026-11-04T00:00:00.000Z",
    amount: "100000",
    currency: "IDR",
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    order: { orderNumber: "ORD-1", status: "ACTIVE", customerName: "Budi" },
    ...overrides,
  } as Pending;
}

// Vitest tanpa `globals` tidak memicu auto-cleanup React Testing Library.
afterEach(cleanup);

describe("PendingExtensionsPanel", () => {
  beforeEach(() => {
    listTenant.mockReset();
    approve.mockReset();
    reject.mockReset();
    notify.mockReset();
    sessionRole = "MANAGER";
  });

  it("tidak dirender bagi peran tanpa permission rental.extension.approve", () => {
    sessionRole = "STAFF";
    const { container } = render(<PendingExtensionsPanel tenantId="tenant-1" />);
    expect(container).toBeEmptyDOMElement();
    expect(listTenant).not.toHaveBeenCalled();
  });

  it("memuat antrean tenant dan menampilkan aksi setujui/tolak", async () => {
    listTenant.mockResolvedValue([row()]);
    approve.mockResolvedValue({});

    render(<PendingExtensionsPanel tenantId="tenant-1" />);

    expect(await screen.findByText("ORD-1")).toBeInTheDocument();
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(screen.getByText(/menunggu persetujuan/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /setujui/i }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    const [tenantId, orderId, extensionId, body] = approve.mock.calls[0] as [
      string,
      string,
      string,
      object,
    ];
    expect(tenantId).toBe("tenant-1");
    expect(orderId).toBe("order-1");
    expect(extensionId).toBe("ext-1");
    expect(body).toEqual({});
    // Daftar dimuat ulang agar baris yang sudah diputuskan hilang.
    await waitFor(() => expect(listTenant).toHaveBeenCalledTimes(2));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("disetujui"), "success");
  });

  it("menolak lewat dialog ber-alasan dan tidak memuat ulang bila gagal", async () => {
    listTenant.mockResolvedValue([row()]);
    reject.mockRejectedValue(new Error("gagal"));

    render(<PendingExtensionsPanel tenantId="tenant-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^tolak$/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(dialog.querySelector("textarea")!, {
      target: { value: "Unit dipakai internal" },
    });
    fireEvent.click(screen.getByRole("button", { name: /tolak perpanjangan/i }));

    await waitFor(() => expect(reject).toHaveBeenCalledTimes(1));
    const [, orderId, extensionId, body] = reject.mock.calls[0] as [
      string,
      string,
      string,
      { reason: string },
    ];
    expect(orderId).toBe("order-1");
    expect(extensionId).toBe("ext-1");
    expect(body.reason).toBe("Unit dipakai internal");
    expect(listTenant).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("menampilkan empty state ketika tidak ada permintaan tertunda", async () => {
    listTenant.mockResolvedValue([]);

    render(<PendingExtensionsPanel tenantId="tenant-1" />);
    expect(
      await screen.findByText(/tidak ada permintaan yang menunggu keputusan/i),
    ).toBeInTheDocument();
  });
});

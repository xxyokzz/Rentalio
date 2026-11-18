import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/shared/auth/permissions";
import type { Schema } from "@/shared/api/endpoints";
import { PenaltiesPanel } from "./penalties-panel";

const session = vi.hoisted(() => ({ role: "MANAGER" as Role }));

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({ role: session.role, tenant: { timezone: "Asia/Jakarta" } }),
}));

vi.mock("@/shared/ui/overlays", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/overlays")>();
  return { ...actual, useToast: () => ({ notify: vi.fn() }) };
});

afterEach(cleanup);

function orderWithPenalties(): Schema<"OrderResponse"> {
  return {
    id: "order-1",
    orderNumber: "ORD-001",
    penalties: [
      {
        id: "penalty-1",
        orderId: "order-1",
        inspectionId: "inspection-1",
        amount: "90000",
        currency: "IDR",
        reason: "Bodi penyok",
        status: "RECORDED",
        createdAt: "2026-11-16T00:00:00.000Z",
      },
      {
        id: "penalty-2",
        orderId: "order-1",
        inspectionId: "inspection-2",
        amount: "25000",
        currency: "IDR",
        reason: "Salah unit",
        status: "VOIDED",
        voidedReason: "Sudah diganti pelanggan",
        createdAt: "2026-11-15T00:00:00.000Z",
      },
    ],
  } as unknown as Schema<"OrderResponse">;
}

function renderPanel() {
  render(<PenaltiesPanel tenantId="tenant-1" order={orderWithPenalties()} onChanged={() => {}} />);
}

describe("PenaltiesPanel", () => {
  it("menjumlahkan hanya denda aktif dan menampilkan alasan pembatalan", () => {
    session.role = "MANAGER";
    renderPanel();

    expect(screen.getByText(/Denda tercatat: Rp\s?90\.000/)).toBeInTheDocument();
    expect(screen.getByText("Dibatalkan")).toBeInTheDocument();
    expect(screen.getByText(/Dibatalkan: Sudah diganti pelanggan/)).toBeInTheDocument();
  });

  it("hanya menawarkan pembatalan untuk denda aktif dan peran berizin", () => {
    session.role = "MANAGER";
    renderPanel();

    expect(screen.getAllByRole("button", { name: "Batalkan" })).toHaveLength(1);
  });

  it("tidak menawarkan pembatalan untuk STAFF", () => {
    session.role = "STAFF";
    renderPanel();

    expect(screen.queryByRole("button", { name: "Batalkan" })).toBeNull();
  });
});

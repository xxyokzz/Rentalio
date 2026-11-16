import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/shared/auth/permissions";
import type { Schema } from "@/shared/api/endpoints";
import { ReturnsPanel } from "./returns-panel";

const session = vi.hoisted(() => ({ role: "OWNER" as Role }));

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({
    role: session.role,
    tenant: { timezone: "Asia/Jakarta" },
  }),
}));

vi.mock("@/shared/ui/overlays", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/overlays")>();
  return { ...actual, useToast: () => ({ notify: vi.fn() }) };
});

afterEach(cleanup);

function orderFixture(): Schema<"OrderResponse"> {
  return {
    id: "order-1",
    orderNumber: "ORD-001",
    status: "ACTIVE",
    items: [],
  } as unknown as Schema<"OrderResponse">;
}

function approvedInspection(): Schema<"InspectionResponse"> {
  return {
    id: "inspection-1",
    orderId: "order-1",
    status: "APPROVED",
    severity: "SEVERE",
    penaltyAmount: "150000",
    currency: "IDR",
    suggestedTotal: { damageFee: "150000", lateFee: "0", total: "150000" },
    items: [],
    attachments: [],
    createdAt: "2026-11-16T00:00:00.000Z",
  } as unknown as Schema<"InspectionResponse">;
}

function renderPanel() {
  render(
    <ReturnsPanel
      tenantId="tenant-1"
      order={orderFixture()}
      returns={[]}
      inspections={[approvedInspection()]}
      productNames={new Map()}
      onChanged={() => {}}
    />,
  );
}

describe("ReturnsPanel — tombol potong deposit", () => {
  it.each(["STAFF", "CASHIER"] as const)(
    "menyembunyikan tombol untuk peran %s tanpa izin deposit.deduct",
    (role) => {
      session.role = role;
      renderPanel();

      expect(screen.queryByRole("button", { name: "Potong deposit" })).toBeNull();
      // Aksi lain pada inspeksi APPROVED tetap tersedia.
      expect(screen.getByRole("button", { name: "Salin WhatsApp" })).toBeInTheDocument();
    },
  );

  it("menampilkan tombol untuk OWNER yang punya izin deposit.deduct", () => {
    session.role = "OWNER";
    renderPanel();

    expect(screen.getByRole("button", { name: "Potong deposit" })).toBeInTheDocument();
  });
});

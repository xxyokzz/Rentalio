import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { DamageFeeReportPage } from "./damage-fee-report";

const report = vi.hoisted(() => ({
  current: null as Schema<"DamageFeeReportResponse"> | null,
  calls: [] as Array<{ tenantId: string; params?: { from?: string; to?: string } }>,
}));

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({ tenantId: "tenant-1", tenant: { name: "Toko Uji", timezone: "Asia/Jakarta" } }),
}));

vi.mock("@/shared/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/endpoints")>();
  return {
    ...actual,
    reportApi: {
      damageFees: async (tenantId: string, params?: { from?: string; to?: string }) => {
        report.calls.push({ tenantId, params });
        return report.current;
      },
      receivableAging: async () => ({
        asOf: "2026-11-18T00:00:00.000Z",
        thresholds: { invoiceDays: 14, penaltyDays: 7 },
        outstanding: {
          orders: 2,
          amount: "1350000",
          overdueOrders: 1,
          overdueAmount: "1100000",
          oldestDays: 20,
        },
        penalties: {
          orders: 2,
          amount: "150000",
          agedOrders: 1,
          agedAmount: "100000",
          oldestDays: 10,
        },
        buckets: [
          { key: "0-7", orders: 1, amount: "250000" },
          { key: "8-14", orders: 0, amount: "0" },
          { key: "15-30", orders: 1, amount: "1100000" },
          { key: "31+", orders: 0, amount: "0" },
        ],
        alertCount: 2,
      }),
    },
  };
});

afterEach(cleanup);

function sample(): Schema<"DamageFeeReportResponse"> {
  return {
    range: { from: null, to: null },
    penalties: { count: 2, totalAmount: "250000", voidedCount: 1 },
    inspections: { DRAFT: 0, SUBMITTED: 0, APPROVED: 2, REJECTED: 0, DISPUTED: 1 },
    severity: {
      MINOR: { lines: 1, quantity: 1, suggestedAmount: "50000" },
      MODERATE: { lines: 0, quantity: 0, suggestedAmount: "0" },
      SEVERE: { lines: 1, quantity: 1, suggestedAmount: "200000" },
    },
    topProducts: [
      { productId: "p-1", productName: "Kamera Sony", lines: 2, quantity: 2, suggestedAmount: "200000" },
    ],
  };
}

describe("DamageFeeReportPage", () => {
  it("mengirim batas hari menurut zona waktu tenant, bukan UTC", async () => {
    report.current = sample();
    report.calls.length = 0;
    render(<DamageFeeReportPage />);
    await screen.findByText("Laporan denda kerusakan");

    fireEvent.change(screen.getByLabelText("Dari"), { target: { value: "2026-11-18" } });
    fireEvent.change(screen.getByLabelText("Sampai"), { target: { value: "2026-11-18" } });

    await waitFor(() =>
      expect(report.calls.at(-1)).toEqual({
        tenantId: "tenant-1",
        params: {
          from: "2026-11-17T17:00:00.000Z",
          to: "2026-11-18T16:59:59.999Z",
        },
      }),
    );
  });

  it("menampilkan total denda tercatat, pembatalan, sengketa, dan produk", async () => {
    report.current = sample();
    render(<DamageFeeReportPage />);

    expect(await screen.findByText("Denda dibatalkan")).toBeTruthy();
    expect(screen.getByText("Laporan denda kerusakan")).toBeTruthy();
    expect(screen.getAllByText(/Rp\s?250\.000/).length).toBeGreaterThan(0);
    expect(screen.getByText("Kamera Sony")).toBeTruthy();
    // Panel umur piutang memakai ambang dari server.
    expect(await screen.findByText(/Tagihan menua > 14 hari/)).toBeTruthy();
    expect(screen.getByText(/Denda menggantung > 7 hari/)).toBeTruthy();
    // Satu baris status DISPUTED dirender oleh peta status.
    expect(screen.getByText("Sengketa")).toBeTruthy();
  });

  it("mengekspor CSV dari data laporan, bukan baris tabel yang terlihat", async () => {
    report.current = sample();
    const createObjectURL = vi.fn((_blob: Blob) => "blob:laporan");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<DamageFeeReportPage />);
    // Tunggu data siap: tombol ekspor nonaktif selama laporan masih dimuat.
    const exportButton = await screen.findByRole("button", { name: "Ekspor CSV" });
    await waitFor(() => expect(exportButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(exportButton);

    expect(createObjectURL).toHaveBeenCalled();
    const blob = createObjectURL.mock.calls[0]![0];
    const text = await blob.text();
    expect(text).toContain('"denda","total_denda_tercatat_idr","250000"');
    expect(text).toContain('"denda","jumlah_dibatalkan","1"');
    expect(text).toContain('"inspeksi","status_DISPUTED","1"');
    expect(text).toContain('"produk","Kamera Sony usulan_idr","200000"');
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });
});

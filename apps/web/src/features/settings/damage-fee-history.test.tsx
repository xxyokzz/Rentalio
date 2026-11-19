import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { DamageFeeHistory } from "./damage-fee-history";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@/shared/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/endpoints")>();
  return {
    ...actual,
    tenantApi: {
      ...actual.tenantApi,
      listDamageFeeRevisions: api.list,
      restoreDamageFeeRevision: api.restore,
    },
  };
});

vi.mock("@/shared/ui/overlays", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/overlays")>();
  return { ...actual, useToast: () => ({ notify: vi.fn() }) };
});

afterEach(() => {
  cleanup();
  api.list.mockReset();
  api.restore.mockReset();
});

function revision(id: string, severe: string): Schema<"DamageFeeRevisionResponse"> {
  return {
    id,
    inspectionEnabled: true,
    feeEnabled: true,
    minorAmount: "25000",
    moderateAmount: "75000",
    severeAmount: severe,
    maxAmount: "500000",
    actorUserId: "11111111-2222-3333-4444-555555555555",
    createdAt: "2026-11-10T03:00:00.000Z",
  };
}

const current = {
  inspectionEnabled: true,
  feeEnabled: true,
  minorAmount: "25000",
  moderateAmount: "75000",
  severeAmount: "100000",
  maxAmount: "500000",
};

describe("DamageFeeHistory", () => {
  it("menandai field yang berbeda saat membandingkan revisi dengan pengaturan saat ini", async () => {
    api.list.mockResolvedValue([revision("rev-1", "300000")]);
    const onRestored = vi.fn();

    render(
      <DamageFeeHistory
        tenantId="tenant-1"
        timezone="Asia/Jakarta"
        current={current}
        canRestore
        onRestored={onRestored}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Bandingkan" }));
    expect(screen.getByText("1 beda")).toBeTruthy();
    expect(screen.getByText("Revisi ini")).toBeTruthy();
    // Nilai saat ini dan nilai revisi tampil berdampingan.
    expect(screen.getByText(/Rp\s?100\.000/)).toBeTruthy();
    expect(screen.getAllByText(/Rp\s?300\.000/).length).toBeGreaterThan(0);
  });

  it("memulihkan revisi setelah konfirmasi dan memuat ulang data", async () => {
    api.list.mockResolvedValue([revision("rev-1", "300000")]);
    api.restore.mockResolvedValue(revision("rev-2", "300000"));
    const onRestored = vi.fn();

    render(
      <DamageFeeHistory
        tenantId="tenant-1"
        timezone="Asia/Jakarta"
        current={current}
        canRestore
        onRestored={onRestored}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Pulihkan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pulihkan revisi" }));

    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(api.restore).toHaveBeenCalledWith("tenant-1", "rev-1");
    // Riwayat dimuat ulang agar revisi baru langsung terlihat. `reload()` baru
    // menjadwalkan fetch pada render berikutnya, jadi tunggu pemanggilan kedua.
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it("menyembunyikan aksi pemulihan untuk peran selain owner", async () => {
    api.list.mockResolvedValue([revision("rev-1", "300000")]);

    render(
      <DamageFeeHistory
        tenantId="tenant-1"
        timezone="Asia/Jakarta"
        current={current}
        canRestore={false}
        onRestored={() => {}}
      />,
    );

    expect(await screen.findByText(/Hanya owner/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pulihkan" })).toBeNull();
  });
});

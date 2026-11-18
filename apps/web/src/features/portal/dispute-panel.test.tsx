import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisputePanel } from "./dispute-panel";

const api = vi.hoisted(() => ({
  disputeInspection: vi.fn(async () => ({ status: "DISPUTED" as const })),
}));

vi.mock("@/shared/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/endpoints")>();
  return {
    ...actual,
    portalApi: { ...actual.portalApi, disputeInspection: api.disputeInspection },
  };
});

afterEach(() => {
  cleanup();
  api.disputeInspection.mockClear();
});

const approved = {
  id: "inspection-1",
  status: "APPROVED" as const,
  penaltyAmount: "90000",
  summary: "Bodi penyok",
  disputeReason: null,
  disputedAt: null,
  canDispute: true,
};

describe("DisputePanel", () => {
  it("menampilkan denda dan mengirim alasan sanggahan lewat portal", async () => {
    const onSubmitted = vi.fn();
    render(
      <DisputePanel token="token-panjang-sekali-123456" inspection={approved} onSubmitted={onSubmitted} />,
    );

    expect(screen.getByText(/Rp\s?90\.000/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Sanggah hasil inspeksi"), {
      target: { value: "Kerusakan sudah ada sebelumnya" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ajukan sanggahan" }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(api.disputeInspection).toHaveBeenCalledWith("token-panjang-sekali-123456", "inspection-1", {
      reason: "Kerusakan sudah ada sebelumnya",
    });
  });

  it("saat DISPUTED hanya menampilkan status dan alasan, tanpa formulir baru", () => {
    render(
      <DisputePanel
        token="token-panjang-sekali-123456"
        inspection={{ ...approved, status: "DISPUTED", canDispute: false, disputeReason: "Sudah ada sebelumnya" }}
        onSubmitted={() => {}}
      />,
    );

    expect(screen.getByText(/Sanggahan sudah tercatat/)).toBeTruthy();
    expect(screen.getByText(/Sudah ada sebelumnya/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ajukan sanggahan" })).toBeNull();
  });
});

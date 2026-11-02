import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { ExtensionPanel, extensionStatus } from "./extension-panel";

const requestExtension = vi.fn();

vi.mock("@/shared/api/endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/endpoints")>();
  return {
    ...actual,
    portalApi: {
      ...actual.portalApi,
      requestExtension: (...args: unknown[]) => requestExtension(...args),
    },
  };
});

type PortalOrder = Schema<"PortalOrderResponse">;

function order(overrides: Partial<PortalOrder> = {}): PortalOrder {
  return {
    tenant: { name: "Sewa Kamera Budi", timezone: "Asia/Jakarta" },
    guestName: "Budi",
    reservation: {
      reference: "res-1",
      status: "CONVERTED_TO_ORDER",
      bookingMode: "MANUAL",
      startAt: "2026-11-01T01:00:00.000Z",
      endAt: "2026-11-03T01:00:00.000Z",
    },
    order: {
      orderNumber: "ORD-1",
      status: "ACTIVE",
      totalAmount: "200000",
      paidAmount: "200000",
      outstandingAmount: "0",
      payments: [],
    },
    summary: { totalAmount: "200000", paidAmount: "200000", outstandingAmount: "0" },
    paymentMethods: [],
    extensionsEnabled: true,
    extensions: [],
    portalExpiresAt: "2026-11-30T00:00:00.000Z",
    ...overrides,
  } as PortalOrder;
}

// Vitest tanpa `globals` tidak memicu auto-cleanup React Testing Library.
afterEach(cleanup);

describe("ExtensionPanel", () => {
  beforeEach(() => {
    requestExtension.mockReset();
  });

  it("memetakan status permintaan ke label yang jelas", () => {
    expect(extensionStatus("PENDING_APPROVAL").label).toBe("Menunggu keputusan admin");
    expect(extensionStatus("APPROVED").tone).toBe("success");
    expect(extensionStatus("REJECTED").tone).toBe("danger");
  });

  it("menampilkan permintaan yang menunggu keputusan dan menyembunyikan formulir", () => {
    render(
      <ExtensionPanel
        token="tok"
        timezone="Asia/Jakarta"
        order={order({
          extensions: [
            {
              id: "ext-1",
              status: "PENDING_APPROVAL",
              requestedEndAt: "2026-11-04T01:00:00.000Z",
              previousEndAt: "2026-11-03T01:00:00.000Z",
              amount: "100000",
              currency: "IDR",
              createdAt: "2026-11-02T01:00:00.000Z",
              decidedAt: null,
              decisionReason: null,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(/sedang menunggu keputusan admin toko/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /kirim pengajuan/i })).not.toBeInTheDocument();
  });

  it("mengirim tanggal akhir baru sebagai ISO UTC lalu memuat ulang data", async () => {
    requestExtension.mockResolvedValue({
      extension: { amount: "100000", status: "PENDING_APPROVAL" },
      portalExpiresAt: "2026-11-30T00:00:00.000Z",
    });
    const onSubmitted = vi.fn();

    render(
      <ExtensionPanel token="tok" timezone="Asia/Jakarta" order={order()} onSubmitted={onSubmitted} />,
    );

    const input = screen.getByLabelText(/kembali sampai/i);
    fireEvent.change(input, { target: { value: "2026-11-05T08:00" } });
    fireEvent.click(screen.getByRole("button", { name: /kirim pengajuan/i }));

    await waitFor(() => expect(requestExtension).toHaveBeenCalledTimes(1));
    const [token, body] = requestExtension.mock.calls[0] as [
      string,
      { requestedEndAt: string; note?: string },
    ];
    expect(token).toBe("tok");
    expect(body.requestedEndAt).toBe("2026-11-05T01:00:00.000Z");
    expect(onSubmitted).toHaveBeenCalled();
    expect(screen.getByText(/pengajuan terkirim/i)).toBeInTheDocument();
  });

  it("menolak tanggal yang tidak melewati akhir sewa tanpa memanggil API", async () => {
    render(<ExtensionPanel token="tok" timezone="Asia/Jakarta" order={order()} />);

    const input = screen.getByLabelText(/kembali sampai/i);
    fireEvent.change(input, { target: { value: "2026-11-03T08:00" } });
    fireEvent.click(screen.getByRole("button", { name: /kirim pengajuan/i }));

    expect(await screen.findByText(/harus setelah tanggal akhir sewa saat ini/i)).toBeInTheDocument();
    expect(requestExtension).not.toHaveBeenCalled();
  });

  it("tidak menampilkan panel saat fitur nonaktif dan belum ada riwayat", () => {
    const { container } = render(
      <ExtensionPanel token="tok" timezone="Asia/Jakarta" order={order({ extensionsEnabled: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

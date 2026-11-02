import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { orderStatus, paymentStatus, reservationStatus } from "@/shared/format/status";
import { ApiRequestError } from "@/shared/api/errors";
import { StatusBadge } from "./surfaces";
import { ErrorState, QueryState } from "./states";

describe("StatusBadge", () => {
  it("menampilkan label teks, bukan hanya warna", () => {
    render(<StatusBadge status={reservationStatus("PENDING_APPROVAL")} />);
    expect(screen.getByText("Menunggu persetujuan")).toBeInTheDocument();
  });

  it("membedakan status pembayaran dari status lifecycle", () => {
    render(
      <>
        <StatusBadge status={orderStatus("ACTIVE")} />
        <StatusBadge status={paymentStatus("VOIDED")} />
      </>,
    );
    expect(screen.getByText("Sedang disewa")).toBeInTheDocument();
    expect(screen.getByText("Dibatalkan (void)")).toBeInTheDocument();
  });

  it("menampilkan kode tak dikenal apa adanya agar tidak menyesatkan", () => {
    render(<StatusBadge status={{ label: "BARU", tone: "neutral" }} />);
    expect(screen.getByText("BARU")).toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("menjelaskan akses ditolak dan menampilkan ID permintaan", () => {
    render(
      <ErrorState
        error={
          new ApiRequestError({
            status: 403,
            code: "PERMISSION_DENIED",
            message: "Akses tidak diizinkan.",
            requestId: "req-123",
          })
        }
      />,
    );
    expect(screen.getByText("Akses ditolak")).toBeInTheDocument();
    expect(screen.getByText(/req-123/)).toBeInTheDocument();
  });

  it("tidak menampilkan stack trace", () => {
    render(<ErrorState error={new Error("SQLSTATE 42P01 di tabel rahasia")} />);
    expect(screen.queryByText(/SQLSTATE/)).not.toBeInTheDocument();
  });
});

describe("QueryState", () => {
  it("menampilkan skeleton saat pemuatan awal", () => {
    render(
      <QueryState
        state={{ data: null, error: null, initialLoading: true, loading: true, reload: () => {} }}
        loadingRows={1}
      >
        {() => <p>konten</p>}
      </QueryState>,
    );
    expect(screen.queryByText("konten")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("menampilkan empty state ketika data kosong", () => {
    render(
      <QueryState
        state={{ data: [], error: null, initialLoading: false, loading: false, reload: () => {} }}
        empty={<p>Tidak ada data</p>}
        isEmpty={(data: unknown[]) => data.length === 0}
      >
        {() => <p>konten</p>}
      </QueryState>,
    );
    expect(screen.getByText("Tidak ada data")).toBeInTheDocument();
  });
});

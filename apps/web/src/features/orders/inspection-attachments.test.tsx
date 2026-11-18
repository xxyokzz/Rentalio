import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { InspectionAttachmentsDialog } from "./inspection-attachments";

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({ role: "STAFF", tenant: { timezone: "Asia/Jakarta" } }),
}));

vi.mock("@/shared/ui/overlays", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/ui/overlays")>();
  return { ...actual, useToast: () => ({ notify: vi.fn() }) };
});

vi.mock("@/shared/api/endpoints", () => ({
  storageApi: { uploadUrl: vi.fn(), downloadUrl: vi.fn() },
  inspectionApi: { addAttachment: vi.fn() },
}));

afterEach(cleanup);

function inspection(
  overrides: Partial<Schema<"InspectionResponse">> = {},
): Schema<"InspectionResponse"> {
  return {
    id: "inspection-1",
    status: "APPROVED",
    attachments: [
      {
        id: "attachment-1",
        objectKey: "tenants/tenant-1/inspections/foto.jpg",
        mimeType: "image/jpeg",
        fileSizeBytes: 2048,
        altText: "Bodi penyok",
        uploadedAt: "2026-11-16T00:00:00.000Z",
      },
    ],
    ...overrides,
  } as unknown as Schema<"InspectionResponse">;
}

function renderDialog(data: Schema<"InspectionResponse">) {
  render(
    <InspectionAttachmentsDialog
      open
      onClose={() => {}}
      tenantId="tenant-1"
      inspection={data}
      onChanged={() => {}}
    />,
  );
}

describe("InspectionAttachmentsDialog", () => {
  it("menampilkan lampiran dengan tautan unduh dan input upload", () => {
    renderDialog(inspection());

    expect(screen.getByText("Bodi penyok")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unduh" })).toBeInTheDocument();
    expect(screen.getByLabelText("Tambah lampiran")).toBeInTheDocument();
  });

  it("menyembunyikan upload dan memberi peringatan untuk inspeksi REJECTED", () => {
    renderDialog(inspection({ status: "REJECTED" }));

    expect(screen.queryByLabelText("Tambah lampiran")).toBeNull();
    expect(screen.getByText(/tidak menerima lampiran baru/i)).toBeInTheDocument();
  });

  it("menampilkan keadaan kosong tanpa lampiran", () => {
    renderDialog(inspection({ attachments: [] }));

    expect(screen.getByText("Belum ada lampiran")).toBeInTheDocument();
  });
});

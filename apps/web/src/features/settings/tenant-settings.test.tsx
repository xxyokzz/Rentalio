import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schema, SubscriptionInvoice } from "@/shared/api/endpoints";
import { TenantSettings } from "./tenant-settings";

const mocks = vi.hoisted(() => ({
  listInvoices: vi.fn(),
  createInvoice: vi.fn(),
  updateSettings: vi.fn(),
  listCategories: vi.fn(),
  listDamageFeeCategories: vi.fn(),
  upsertDamageFeeCategory: vi.fn(),
  refresh: vi.fn(),
  notify: vi.fn(),
}));

let tenant: Schema<"TenantResponse"> | null = null;

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({
    tenant,
    tenantLoading: false,
    tenantError: null,
    refresh: mocks.refresh,
    role: "OWNER",
  }),
}));

vi.mock("@/shared/ui/overlays", () => ({
  useToast: () => ({ notify: mocks.notify }),
}));

vi.mock("@/shared/api/endpoints", () => ({
  tenantApi: {
    updateSettings: mocks.updateSettings,
    listDamageFeeCategories: mocks.listDamageFeeCategories,
    upsertDamageFeeCategory: mocks.upsertDamageFeeCategory,
  },
  billingApi: { listInvoices: mocks.listInvoices, createInvoice: mocks.createInvoice },
  catalogApi: { listCategories: mocks.listCategories },
}));

afterEach(cleanup);

beforeEach(() => {
  mocks.listInvoices.mockReset().mockResolvedValue([]);
  mocks.createInvoice.mockReset();
  mocks.listCategories.mockReset().mockResolvedValue([]);
  mocks.listDamageFeeCategories.mockReset().mockResolvedValue([]);
  mocks.upsertDamageFeeCategory.mockReset();
});

function makeTenant(
  billing: NonNullable<Schema<"TenantResponse">["billing"]>,
): Schema<"TenantResponse"> {
  return {
    id: "tenant-1",
    slug: "demo-sewa",
    name: "Rental Kamera Bandung",
    timezone: "Asia/Jakarta",
    status: "ACTIVE",
    trialEndsAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
    subscription: {
      status: "TRIALING",
      restricted: false,
      reason: "TRIAL",
      periodEnd: null,
    },
    billing,
  };
}

function pendingInvoice(overrides: Partial<SubscriptionInvoice> = {}): SubscriptionInvoice {
  return {
    id: "invoice-1",
    status: "PENDING",
    provider: "qris",
    amount: "149000",
    currency: "IDR",
    qrPayload: "00020101021226670011ID.CO.QRIS.WWW6304ABCD",
    qrImageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
    paidAt: null,
    paidAmount: null,
    paymentMethod: null,
    paymentChannel: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("TenantSettings — plafon denda kerusakan", () => {
  it("memuat plafon tersimpan dan mengirim nilai baru sebagai integer rupiah", async () => {
    tenant = {
      ...makeTenant({ paymentEnabled: false, priceAmount: null, periodDays: 30 }),
      damageInspectionEnabled: true,
      damageFeeEnabled: true,
      damageFeeSevereAmount: "100000",
      damageFeeMaxAmount: "500000",
    };
    mocks.updateSettings.mockResolvedValue({});
    render(<TenantSettings supportWhatsApp="" />);

    const input = screen.getByLabelText("Plafon usulan denda (Rp)");
    expect(input).toHaveValue("500000");

    fireEvent.change(input, { target: { value: "750000" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan pengaturan" }));

    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith(
        "tenant-1",
        expect.objectContaining({ damageFeeMaxAmount: 750000 }),
      ),
    );
  });

  it("mengirim null saat plafon dikosongkan agar server menghapus batas", async () => {
    tenant = {
      ...makeTenant({ paymentEnabled: false, priceAmount: null, periodDays: 30 }),
      damageInspectionEnabled: true,
      damageFeeEnabled: true,
      damageFeeSevereAmount: "100000",
      damageFeeMaxAmount: "500000",
    };
    mocks.updateSettings.mockResolvedValue({});
    render(<TenantSettings supportWhatsApp="" />);

    fireEvent.change(screen.getByLabelText("Plafon usulan denda (Rp)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Simpan pengaturan" }));

    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith(
        "tenant-1",
        expect.objectContaining({ damageFeeMaxAmount: null }),
      ),
    );
  });
});

describe("TenantSettings — denda per kategori produk", () => {
  function damageTenant(): Schema<"TenantResponse"> {
    return {
      ...makeTenant({ paymentEnabled: false, priceAmount: null, periodDays: 30 }),
      damageInspectionEnabled: true,
      damageFeeEnabled: true,
      damageFeeSevereAmount: "100000",
    };
  }

  it("memuat nominal tersimpan lalu menyimpannya kembali sebagai integer rupiah", async () => {
    tenant = damageTenant();
    mocks.listCategories.mockResolvedValue([{ id: "cat-1", name: "Elektronik" }]);
    mocks.listDamageFeeCategories.mockResolvedValue([
      { categoryId: "cat-1", minorAmount: "10000", moderateAmount: "25000", severeAmount: "50000" },
    ]);
    mocks.upsertDamageFeeCategory.mockResolvedValue({
      categoryId: "cat-1",
      minorAmount: "10000",
      moderateAmount: "25000",
      severeAmount: "55000",
    });
    render(<TenantSettings supportWhatsApp="" />);

    const severe = await screen.findByLabelText("Elektronik — parah (Rp)");
    expect(severe).toHaveValue("50000");
    expect(screen.getByLabelText("Elektronik — ringan (Rp)")).toHaveValue("10000");

    fireEvent.change(severe, { target: { value: "55000" } });
    fireEvent.click(screen.getByRole("button", { name: "Simpan kategori" }));

    await waitFor(() =>
      expect(mocks.upsertDamageFeeCategory).toHaveBeenCalledWith("tenant-1", {
        categoryId: "cat-1",
        minorAmount: 10000,
        moderateAmount: 25000,
        severeAmount: 55000,
      }),
    );
    expect(mocks.notify).toHaveBeenCalledWith("Nominal kategori disimpan.", "success");
  });

  it("menampilkan keadaan kosong saat belum ada kategori", async () => {
    tenant = damageTenant();
    render(<TenantSettings supportWhatsApp="" />);

    expect(await screen.findByText("Belum ada kategori produk")).toBeInTheDocument();
  });

  it("menampilkan peringatan saat kategori atau nominalnya gagal dimuat", async () => {
    tenant = damageTenant();
    mocks.listDamageFeeCategories.mockRejectedValue(new Error("jaringan gagal"));
    render(<TenantSettings supportWhatsApp="" />);

    expect(await screen.findByText(/gagal dimuat/i)).toBeInTheDocument();
    // Jangan tampilkan keadaan kosong palsu saat datanya sebenarnya error.
    expect(screen.queryByText("Belum ada kategori produk")).toBeNull();
  });

  it("menonaktifkan input dan tombol simpan kategori saat denda kerusakan mati", async () => {
    tenant = { ...damageTenant(), damageFeeEnabled: false };
    mocks.listCategories.mockResolvedValue([{ id: "cat-1", name: "Elektronik" }]);
    render(<TenantSettings supportWhatsApp="" />);

    const minor = await screen.findByLabelText("Elektronik — ringan (Rp)");
    expect(minor).toBeDisabled();
    expect(screen.getByLabelText("Elektronik — parah (Rp)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Simpan kategori" })).toBeDisabled();
  });
});

describe("TenantSettings — pembayaran langganan", () => {
  it("menampilkan harga dan tombol QR saat pembayaran diaktifkan server", async () => {
    tenant = makeTenant({ paymentEnabled: true, priceAmount: "149000", periodDays: 30 });
    render(<TenantSettings supportWhatsApp="" />);

    expect(screen.getByText("Rp 149.000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tampilkan QR pembayaran" })).toBeInTheDocument();
    // Jalur manual WhatsApp tidak ditawarkan sebagai aksi utama saat QRIS aktif.
    expect(screen.queryByRole("link", { name: "Upgrade ke paket langganan" })).toBeNull();
  });

  it("menampilkan gambar QRIS bernominal untuk tagihan yang menunggu", async () => {
    tenant = makeTenant({ paymentEnabled: true, priceAmount: "149000", periodDays: 30 });
    mocks.listInvoices.mockResolvedValueOnce([pendingInvoice()]);
    render(<TenantSettings supportWhatsApp="" />);

    expect(await screen.findByText(/Pindai QR di bawah/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "QRIS pembayaran langganan Rentalio" })).toHaveAttribute(
      "src",
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(screen.getByRole("button", { name: "Salin kode QRIS" })).toBeInTheDocument();
    // Halaman tidak pernah menawarkan tautan checkout pihak ketiga.
    expect(screen.queryByRole("link", { name: "Buka tagihan" })).toBeNull();
  });

  it("kembali ke jalur manual WhatsApp bila pembayaran belum dikonfigurasi", () => {
    tenant = makeTenant({ paymentEnabled: false, priceAmount: null, periodDays: 30 });
    render(<TenantSettings supportWhatsApp="6281234567890" />);

    const link = screen.getByRole("link", { name: "Upgrade ke paket langganan" });
    expect(link.getAttribute("href")).toContain("wa.me/6281234567890");
    expect(screen.queryByRole("button", { name: "Tampilkan QR pembayaran" })).toBeNull();
    expect(mocks.listInvoices).not.toHaveBeenCalled();
  });
});

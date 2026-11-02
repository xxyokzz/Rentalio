import { describe, expect, it } from "vitest";
import { subscriptionRequest, subscriptionRequestMessage } from "./subscription-request";

describe("subscriptionRequest", () => {
  it("menyusun pesan berisi identitas toko dan status langganan", () => {
    const message = subscriptionRequestMessage({
      tenantName: "Rental Kamera Bandung",
      tenantSlug: "demo-sewa",
      statusLabel: "Masa coba habis",
      restricted: true,
    });
    expect(message).toContain("Toko: Rental Kamera Bandung (demo-sewa)");
    expect(message).toContain("Status langganan saat ini: Masa coba habis");
    expect(message).toContain("memperpanjang langganan");
  });

  it("melewatkan baris yang datanya belum ada", () => {
    const message = subscriptionRequestMessage({ restricted: true });
    expect(message).not.toContain("Toko:");
    expect(message).not.toContain("Status langganan saat ini:");
  });

  it("mengarahkan ke nomor tim Rentalio bila dikonfigurasi", () => {
    const result = subscriptionRequest(
      { tenantName: "Rental Kamera Bandung", restricted: true, statusLabel: "Dibatalkan" },
      "6281234567890",
    );
    expect(result.href.startsWith("https://wa.me/6281234567890?text=")).toBe(true);
    expect(result.label).toBe("Ajukan aktivasi langganan");
  });

  it("memakai pemilih kontak WhatsApp tanpa nomor (tidak mengarang nomor)", () => {
    const result = subscriptionRequest({ restricted: false, subscriptionStatus: "ACTIVE" }, "");
    expect(result.href.startsWith("https://wa.me/?text=")).toBe(true);
    expect(result.href).not.toMatch(/wa\.me\/\d/);
    expect(result.label).toBe("Ajukan perpanjangan");
  });

  it("menawarkan upgrade selama masa trial", () => {
    const result = subscriptionRequest(
      { restricted: false, subscriptionStatus: "TRIALING", statusLabel: "Trial" },
      "6281234567890",
    );
    expect(result.label).toBe("Upgrade ke paket langganan");
  });
});

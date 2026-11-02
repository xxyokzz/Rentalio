import { describe, expect, it } from "vitest";
import { canViewRoute, visibleNavGroups } from "./navigation";
import { can } from "@/shared/auth/permissions";

describe("canViewRoute", () => {
  it("mengizinkan OWNER membuka seluruh halaman aplikasi", () => {
    expect(canViewRoute("OWNER", "/app")).toBe(true);
    expect(canViewRoute("OWNER", "/app/settings")).toBe(true);
    expect(canViewRoute("OWNER", "/app/settings/staff")).toBe(true);
    expect(canViewRoute("OWNER", "/app/conflicts")).toBe(true);
  });

  it("menolak kasir membuka POS dan pengaturan", () => {
    expect(canViewRoute("CASHIER", "/app/pos")).toBe(false);
    expect(canViewRoute("CASHIER", "/app/settings")).toBe(false);
    expect(canViewRoute("CASHIER", "/app/orders")).toBe(false);
  });

  it("mengizinkan staf membuka POS tetapi tidak konflik/pengaturan", () => {
    expect(canViewRoute("STAFF", "/app/pos")).toBe(true);
    expect(canViewRoute("STAFF", "/app/conflicts")).toBe(false);
    expect(canViewRoute("STAFF", "/app/settings/payment-methods")).toBe(false);
  });

  it("menolak halaman staf untuk manager (backend OWNER-only)", () => {
    expect(canViewRoute("MANAGER", "/app/settings/staff")).toBe(false);
  });
});

describe("visibleNavGroups", () => {
  it("menyembunyikan grup pengaturan untuk staf", () => {
    const groups = visibleNavGroups("STAFF");
    expect(groups.some((group) => group.id === "pengaturan")).toBe(false);
    expect(groups.some((group) => group.id === "operasional")).toBe(true);
  });

  it("tidak menampilkan menu apa pun tanpa role", () => {
    expect(visibleNavGroups(undefined)).toEqual([]);
  });
});

describe("permission defaults", () => {
  it("mencerminkan default backend", () => {
    expect(can("OWNER", "settings.payment_methods.manage")).toBe(true);
    expect(can("MANAGER", "payment.record")).toBe(true);
    expect(can("CASHIER", "payment.record")).toBe(true);
    expect(can("CASHIER", "reservation.create")).toBe(false);
    expect(can("STAFF", "payment.void")).toBe(false);
  });

  it("tidak pernah memberi override konflik secara default", () => {
    expect(can("MANAGER", "rental.extension.override_conflict")).toBe(false);
    expect(can("OWNER", "rental.extension.override_conflict")).toBe(true);
  });
});

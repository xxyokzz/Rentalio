import { describe, expect, it } from "vitest";

import {
  blocksUnavailableBooking,
  canRequestUnavailableStock,
  DEFAULT_CATALOG_POLICY,
} from "./policy";

describe("kebijakan katalog A/B", () => {
  it("opsi A mengizinkan permintaan stok kosong tanpa alokasi", () => {
    expect(canRequestUnavailableStock("CHECK_AVAILABILITY")).toBe(true);
    expect(blocksUnavailableBooking("CHECK_AVAILABILITY")).toBe(false);
  });

  it("opsi B memblokir booking baru saat stok kosong", () => {
    expect(canRequestUnavailableStock("SKIP_AVAILABILITY")).toBe(false);
    expect(blocksUnavailableBooking("SKIP_AVAILABILITY")).toBe(true);
  });

  it("tenant tanpa policy tersimpan memakai baseline opsi A", () => {
    expect(DEFAULT_CATALOG_POLICY).toBe("CHECK_AVAILABILITY");
    expect(canRequestUnavailableStock(undefined)).toBe(true);
    expect(canRequestUnavailableStock(null)).toBe(true);
    expect(blocksUnavailableBooking(undefined)).toBe(false);
  });
});

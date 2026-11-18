import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateRange,
  isoToZonedDate,
  isoToZonedLocal,
  zonedDateEndIso,
  zonedDateStartIso,
  zonedLocalToIso,
} from "./date";

describe("batas hari laporan pada zona tenant", () => {
  it("memakai tengah malam waktu toko, bukan UTC", () => {
    // 18 Nov 2026 00:00 WIB = 17 Nov 17:00 UTC
    expect(zonedDateStartIso("2026-11-18", "Asia/Jakarta")).toBe("2026-11-17T17:00:00.000Z");
    // Akhir hari = awal 19 Nov WIB minus 1 ms
    expect(zonedDateEndIso("2026-11-18", "Asia/Jakarta")).toBe("2026-11-18T16:59:59.999Z");
  });

  it("menangani zona dengan offset berbeda dan input tidak valid", () => {
    expect(zonedDateStartIso("2026-11-18", "Asia/Makassar")).toBe("2026-11-17T16:00:00.000Z");
    expect(zonedDateStartIso("18/11/2026", "Asia/Jakarta")).toBeNull();
    expect(zonedDateEndIso("bukan-tanggal", "Asia/Jakarta")).toBeNull();
  });
});

describe("zonedLocalToIso", () => {
  it("menafsirkan waktu lokal sebagai zona waktu tenant", () => {
    // 20 Okt 2026 08:00 WIB (UTC+7) = 01:00 UTC
    expect(zonedLocalToIso("2026-10-20T08:00", "Asia/Jakarta")).toBe("2026-10-20T01:00:00.000Z");
    // 20 Okt 2026 08:00 WITA (UTC+8) = 00:00 UTC
    expect(zonedLocalToIso("2026-10-20T08:00", "Asia/Makassar")).toBe("2026-10-20T00:00:00.000Z");
  });

  it("menolak format yang tidak valid", () => {
    expect(zonedLocalToIso("20/10/2026 08:00", "Asia/Jakarta")).toBeNull();
    expect(zonedLocalToIso("", "Asia/Jakarta")).toBeNull();
  });
});

describe("isoToZonedLocal", () => {
  it("mengembalikan nilai input datetime-local pada zona tenant", () => {
    expect(isoToZonedLocal("2026-10-20T01:00:00.000Z", "Asia/Jakarta")).toBe("2026-10-20T08:00");
    expect(isoToZonedLocal("2026-10-20T00:00:00.000Z", "Asia/Makassar")).toBe("2026-10-20T08:00");
  });

  it("mengembalikan string kosong untuk nilai kosong", () => {
    expect(isoToZonedLocal(null)).toBe("");
    expect(isoToZonedLocal("bukan-tanggal")).toBe("");
  });
});

describe("isoToZonedDate", () => {
  it("memakai tanggal tenant, bukan tanggal UTC", () => {
    // 19 Okt 2026 20:00 UTC = 20 Okt 03:00 WIB
    expect(isoToZonedDate("2026-10-19T20:00:00.000Z", "Asia/Jakarta")).toBe("2026-10-20");
  });
});

describe("formatDateRange", () => {
  it("menampilkan satu hari secara ringkas", () => {
    const value = formatDateRange(
      "2026-10-20T01:00:00.000Z",
      "2026-10-20T09:00:00.000Z",
      "Asia/Jakarta",
    );
    expect(value).toContain("–");
    expect(value.split("–")).toHaveLength(2);
  });

  it("menampilkan tanda pisah bila tanggal kosong", () => {
    expect(formatDateRange(null, null)).toBe("—");
  });
});

describe("formatDate", () => {
  it("mengembalikan tanda pisah untuk input tidak valid", () => {
    expect(formatDate("tidak-valid")).toBe("—");
  });
});

import { describe, expect, it } from "vitest";
import { formatIDR, parseIDRInput, rentalDays, toIDRInput } from "./currency";

describe("formatIDR", () => {
  it("memformat IDR utuh tanpa pecahan", () => {
    expect(formatIDR("1250000")).toBe("Rp 1.250.000");
    expect(formatIDR(0)).toBe("Rp 0");
  });

  it("mengembalikan tanda pisah untuk nilai kosong/tidak valid", () => {
    expect(formatIDR(null)).toBe("—");
    expect(formatIDR(undefined)).toBe("—");
    expect(formatIDR("bukan-angka")).toBe("—");
  });

  it("tidak membulatkan nilai besar secara diam-diam", () => {
    expect(formatIDR("9007199254740991")).toContain("9.007.199.254.740.991");
  });
});

describe("parseIDRInput", () => {
  it("menerima pemisah ribuan dan prefix Rp", () => {
    expect(parseIDRInput("Rp 1.250.000")).toBe(1_250_000);
    expect(parseIDRInput("150000")).toBe(150_000);
  });

  it("menolak pecahan, negatif, dan input kosong", () => {
    expect(parseIDRInput("1500,50")).toBeNull();
    expect(parseIDRInput("-1500")).toBeNull();
    expect(parseIDRInput("")).toBeNull();
  });
});

describe("toIDRInput", () => {
  it("mengembalikan digit saja", () => {
    expect(toIDRInput("150000")).toBe("150000");
    expect(toIDRInput(null)).toBe("");
  });
});

describe("rentalDays", () => {
  it("membulatkan periode parsial ke atas", () => {
    expect(rentalDays("2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z")).toBe(1);
    expect(rentalDays("2026-10-20T00:00:00.000Z", "2026-10-21T06:00:00.000Z")).toBe(2);
  });

  it("mengembalikan 0 untuk periode tidak valid", () => {
    expect(rentalDays("2026-10-21T00:00:00.000Z", "2026-10-20T00:00:00.000Z")).toBe(0);
    expect(rentalDays("", "")).toBe(0);
  });
});

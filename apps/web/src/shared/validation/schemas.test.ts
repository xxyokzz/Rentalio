import { describe, expect, it } from "vitest";
import { emailSchema, isIntegerAmount, ownerNameSchema, slugSchema, suggestSlug } from "./schemas";

describe("emailSchema", () => {
  it("menormalisasi email ke huruf kecil dan trim", () => {
    const result = emailSchema.safeParse("  Budi@Contoh.COM ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("budi@contoh.com");
  });

  it("menolak email tanpa domain", () => {
    expect(emailSchema.safeParse("budi@").success).toBe(false);
  });
});

describe("slugSchema", () => {
  it("menerima slug valid dan menormalkan huruf besar", () => {
    const result = slugSchema.safeParse("Toko-Jaya");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("toko-jaya");
  });

  it("menolak tanda hubung di awal/akhir dan reserved word", () => {
    expect(slugSchema.safeParse("-toko").success).toBe(false);
    expect(slugSchema.safeParse("toko-").success).toBe(false);
    expect(slugSchema.safeParse("admin").success).toBe(false);
  });

  it("menolak spasi dan karakter khusus", () => {
    expect(slugSchema.safeParse("toko jaya").success).toBe(false);
    expect(slugSchema.safeParse("toko_jaya").success).toBe(false);
  });
});

describe("suggestSlug", () => {
  it("membuat slug dari nama usaha", () => {
    expect(suggestSlug("Toko Jaya Abadi!")).toBe("toko-jaya-abadi");
    expect(suggestSlug("  Rental 24 Jam ")).toBe("rental-24-jam");
  });
});

describe("ownerNameSchema", () => {
  it("trim dan menerima nama 2–120 karakter (mengikuti RegisterDto backend)", () => {
    const result = ownerNameSchema.safeParse("  Budi Santoso  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("Budi Santoso");
    expect(ownerNameSchema.safeParse("B".repeat(121)).success).toBe(false);
    expect(ownerNameSchema.safeParse(" B ").success).toBe(false);
  });
});

describe("isIntegerAmount", () => {
  it("menerima hanya digit tanpa pemisah", () => {
    expect(isIntegerAmount("150000")).toBe(true);
    expect(isIntegerAmount("150.000")).toBe(false);
    expect(isIntegerAmount("0")).toBe(true);
  });
});

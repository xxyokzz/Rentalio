import { describe, expect, it } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { buildProductNames, itemLabel } from "./item-label";

const UUID = "1c9f0f3e-8a4b-4c7d-9e2f-0a1b2c3d4e5f";

function product(overrides: Partial<Schema<"ProductResponse">> = {}): Schema<"ProductResponse"> {
  return { id: UUID, name: "Kamera Sony A7", ...overrides };
}

describe("buildProductNames", () => {
  it("memetakan id ke nama produk", () => {
    const names = buildProductNames([product()]);
    expect(names.get(UUID)).toBe("Kamera Sony A7");
  });

  it("melewati produk tanpa nama agar UUID tidak masuk peta", () => {
    const names = buildProductNames([
      product({ id: "produk-tanpa-nama", name: undefined }),
      product({ id: "produk-bernama", name: "Tripod" }),
    ]);
    expect(names.has("produk-tanpa-nama")).toBe(false);
    expect([...names.values()]).not.toContain("produk-tanpa-nama");
    expect(names.get("produk-bernama")).toBe("Tripod");
  });

  it("katalog kosong menghasilkan peta kosong", () => {
    expect(buildProductNames([]).size).toBe(0);
  });
});

describe("itemLabel", () => {
  it("memakai nama produk bila ada di peta", () => {
    const names = buildProductNames([product()]);
    expect(itemLabel({ productId: UUID }, names)).toBe("Kamera Sony A7");
  });

  it("jatuh ke \"Item\" saat katalog kosong atau produk tidak dikenal", () => {
    expect(itemLabel({ productId: UUID }, new Map())).toBe("Item");
    expect(itemLabel({ productId: "produk-lain" }, buildProductNames([product()]))).toBe("Item");
    expect(itemLabel({}, new Map())).toBe("Item");
  });

  it("menambahkan penanda unit dari 6 karakter terakhir kode aset", () => {
    const names = buildProductNames([product()]);
    expect(itemLabel({ productId: UUID, assetId: "asset-abcdef123456" }, names)).toBe(
      "Kamera Sony A7 · unit 123456",
    );
  });

  it("tanpa assetId tidak menambah penanda unit", () => {
    expect(itemLabel({ productId: UUID, assetId: null }, new Map())).toBe("Item");
  });

  it("tidak pernah memuat UUID di label, termasuk saat fallback", () => {
    const names = buildProductNames([product()]);
    const labels = [
      itemLabel({ productId: UUID, assetId: UUID }, names),
      itemLabel({ productId: UUID, assetId: UUID }, new Map()),
      itemLabel({ productId: UUID }, new Map()),
    ];
    for (const label of labels) {
      expect(label).not.toContain(UUID);
      expect(label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });
});

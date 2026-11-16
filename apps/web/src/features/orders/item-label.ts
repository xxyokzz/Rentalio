import type { Schema } from "@/shared/api/endpoints";

/** Peta id produk → nama, dibangun sekali dari katalog tenant. */
export function buildProductNames(
  products: Schema<"ProductResponse">[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const product of products) {
    // Jangan pernah memasukkan UUID ke peta: label harus selalu bisa dibaca.
    if (product.id && product.name) names.set(product.id, product.name);
  }
  return names;
}

/**
 * Label baris order/pengembalian: nama produk, plus penanda unit fisik berupa
 * 6 karakter terakhir kode aset. Fallback "Item" bila produk tidak ada di peta
 * (mis. katalog gagal dimuat) — UUID tidak pernah ditampilkan.
 */
export function itemLabel(
  item: { productId?: string | null; assetId?: string | null },
  productNames: Map<string, string>,
): string {
  const name = (item.productId && productNames.get(item.productId)) || "Item";
  return item.assetId ? `${name} · unit ${item.assetId.slice(-6)}` : name;
}

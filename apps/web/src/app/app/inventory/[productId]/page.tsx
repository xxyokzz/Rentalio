import type { Metadata } from "next";
import { ProductDetail } from "@/features/inventory/product-detail";

export const metadata: Metadata = { title: "Detail produk" };

export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  return <ProductDetail productId={productId} />;
}

import type { Metadata } from "next";
import { ProductsPage } from "@/features/inventory/products-page";

export const metadata: Metadata = { title: "Inventaris" };

export default function Page() {
  return <ProductsPage />;
}

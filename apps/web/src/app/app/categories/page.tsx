import type { Metadata } from "next";
import { CategoriesPage } from "@/features/inventory/categories-page";

export const metadata: Metadata = { title: "Kategori" };

export default function Page() {
  return <CategoriesPage />;
}

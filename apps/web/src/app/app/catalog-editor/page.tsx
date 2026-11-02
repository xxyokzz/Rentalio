import type { Metadata } from "next";
import { CatalogEditorPage } from "@/features/catalog-editor/catalog-editor-page";

export const metadata: Metadata = { title: "Kustom katalog" };

export default function Page() {
  return <CatalogEditorPage />;
}

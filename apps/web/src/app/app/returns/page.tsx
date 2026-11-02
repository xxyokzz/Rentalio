import type { Metadata } from "next";
import { ReturnsPage } from "@/features/returns/returns-page";

export const metadata: Metadata = { title: "Pengembalian & inspeksi" };

export default function Page() {
  return <ReturnsPage />;
}

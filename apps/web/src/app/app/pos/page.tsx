import type { Metadata } from "next";
import { PosPage } from "@/features/pos/pos-page";

export const metadata: Metadata = { title: "Kasir (POS)" };

export default function Page() {
  return <PosPage />;
}

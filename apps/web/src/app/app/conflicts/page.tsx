import type { Metadata } from "next";
import { ConflictsPage } from "@/features/conflicts/conflicts-page";

export const metadata: Metadata = { title: "Konflik perpanjangan" };

export default function Page() {
  return <ConflictsPage />;
}

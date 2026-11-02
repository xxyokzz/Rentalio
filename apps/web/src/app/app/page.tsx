import type { Metadata } from "next";
import { DashboardOverview } from "@/features/dashboard/overview";

export const metadata: Metadata = { title: "Ringkasan" };

export default function Page() {
  return <DashboardOverview />;
}

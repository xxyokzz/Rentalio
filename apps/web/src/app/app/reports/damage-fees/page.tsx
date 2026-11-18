import type { Metadata } from "next";
import { DamageFeeReportPage } from "@/features/reports/damage-fee-report";

export const metadata: Metadata = { title: "Laporan denda" };

export default function Page() {
  return <DamageFeeReportPage />;
}

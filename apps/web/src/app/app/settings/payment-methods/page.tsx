import type { Metadata } from "next";
import { PaymentMethodsPage } from "@/features/settings/payment-methods-page";

export const metadata: Metadata = { title: "Metode pembayaran" };

export default function Page() {
  return <PaymentMethodsPage />;
}

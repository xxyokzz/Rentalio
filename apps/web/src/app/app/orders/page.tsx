import type { Metadata } from "next";
import { OrdersPage } from "@/features/orders/orders-page";

export const metadata: Metadata = { title: "Pesanan" };

export default function Page() {
  return <OrdersPage />;
}

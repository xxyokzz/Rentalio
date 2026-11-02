import type { Metadata } from "next";
import { OrderDetail } from "@/features/orders/order-detail";

export const metadata: Metadata = { title: "Detail pesanan" };

export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <OrderDetail orderId={orderId} />;
}

import type { Metadata } from "next";
import { WhatsAppTemplatesPage } from "@/features/settings/whatsapp-templates-page";

export const metadata: Metadata = { title: "Template WhatsApp" };

export default function Page() {
  return <WhatsAppTemplatesPage />;
}

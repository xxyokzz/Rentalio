import type { Metadata } from "next";
import { PortalPage } from "@/features/portal/portal-page";
import { PublicShell } from "@/shared/layout/public-shell";

/**
 * Portal pesanan berisi token rahasia pada URL: jangan diindeks mesin pencari
 * dan jangan bocorkan URL sebagai referrer ke domain lain.
 */
export const metadata: Metadata = {
  title: "Portal pesanan",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <PublicShell>
      <PortalPage token={token} />
    </PublicShell>
  );
}

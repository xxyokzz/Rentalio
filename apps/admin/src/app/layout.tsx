import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "./globals.css";

const adminUrl = process.env.NEXT_PUBLIC_ADMIN_APP_URL ?? "http://localhost:3002";

export const metadata: Metadata = {
  metadataBase: new URL(adminUrl),
  title: {
    default: "Admin Platform · Rentalio",
    template: "%s · Admin Rentalio",
  },
  description:
    "Konsol operator Rentalio: direktori tenant, penugasan role Admin Platform, dan peninjauan audit.",
  applicationName: "Rentalio Admin",
  // Konsol operator tidak boleh diindeks mesin pencari.
  robots: { index: false, follow: false, nocache: true },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1c1915",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <a className="skip-link" href="#main-content">
          Lompat ke konten utama
        </a>
        {children}
      </body>
    </html>
  );
}

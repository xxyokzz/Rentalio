import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource/instrument-serif/400.css";
import "@/shared/styles/base.css";
import { Providers } from "./providers";

const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "Rentalio — manajemen penyewaan",
    template: "%s · Rentalio",
  },
  description:
    "Rentalio membantu bisnis penyewaan mengelola katalog, booking, serah-terima, pembayaran manual, deposit, dan pengembalian dalam satu tempat.",
  applicationName: "Rentalio",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/icon-192.svg", type: "image/svg+xml" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f1ede4",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <a className="skip-link" href="#main-content">
          Lompat ke konten utama
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

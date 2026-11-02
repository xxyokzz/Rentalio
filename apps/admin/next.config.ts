import type { NextConfig } from "next";

/**
 * Admin Platform Rentalio.
 *
 * Semua panggilan browser memakai path relatif `/api/v1/...` dan diproksikan
 * oleh Next ke backend. Ini bukan sekadar kenyamanan:
 * - Cookie sesi `rentalio_platform_admin` tetap host-only pada origin admin,
 *   sehingga tidak pernah terkirim ke origin tenant.
 * - Guard CSRF API membandingkan header `Origin` dengan
 *   `PLATFORM_ADMIN_BASE_URL`. Karena proxy meneruskan header asli dari
 *   browser, permintaan dari tab admin di port 3002 lolos tanpa perlu
 *   melemahkan validasi Origin di server.
 */
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiInternalUrl}/api/v1/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
      {
        // Data admin tidak boleh tersimpan di cache bersama maupun offline.
        source: "/tenants/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        source: "/admins/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        source: "/audit/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
    ];
  },
};

export default nextConfig;

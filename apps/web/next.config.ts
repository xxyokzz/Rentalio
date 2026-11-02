import type { NextConfig } from "next";

/**
 * Frontend Rentalio.
 *
 * Semua panggilan API browser memakai path relatif `/api/v1/...` dan diproksikan
 * oleh Next ke backend (default `http://localhost:3000`). Dengan begitu cookie
 * sesi HttpOnly `rentalio_session` tetap host-only pada origin aplikasi dan
 * tidak perlu CORS kredensial di sisi browser.
 */
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Indikator dev Next menutupi kartu akun di sudut kiri bawah sidebar.
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
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
      {
        // Respons tenant tidak boleh disimpan cache bersama/offline.
        source: "/app/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
    ];
  },
};

export default nextConfig;

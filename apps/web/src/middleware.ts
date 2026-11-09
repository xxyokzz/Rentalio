import { NextResponse, type NextRequest } from "next/server";
import { isPlatformApex, normalizeHostHeader } from "@/shared/config/hosts";

/**
 * Penjaga domain tingkat server.
 *
 * Aplikasi terautentikasi hanya disajikan di domain tenant
 * (`{slug}.rentalio.my.id`). Di domain platform, `/app` tidak pernah dirender:
 * pengunjung dikirim ke halaman masuk, dan setelah masuk form login mengalihkan
 * mereka ke subdomain tenant akun. Onboarding dikecualikan karena tenant (dan
 * subdomainnya) baru dibuat di sana.
 *
 * Pengembangan lokal tidak terpengaruh: `localhost` bukan apex platform.
 */
export function middleware(request: NextRequest) {
  const host = normalizeHostHeader(request.headers.get("host"));
  if (!host || !isPlatformApex(host)) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (pathname === "/app/onboarding" || pathname.startsWith("/app/onboarding/")) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(url, 307);
}

export const config = {
  matcher: ["/app", "/app/:path*"],
};

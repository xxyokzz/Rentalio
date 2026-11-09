"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useSession } from "@/shared/auth/session";
import { isPlatformApex } from "@/shared/config/hosts";
import { canViewRoute } from "@/shared/config/navigation";
import { tenantHostRedirect } from "@/shared/config/tenant-host";
import { DesktopShell } from "@/desktop/desktop-shell";
import { MobileShell } from "@/mobile/mobile-shell";
import { useIsMobile } from "@/shared/hooks/useMediaQuery";
import { EmptyState, ErrorState, LoadingBlock } from "@/shared/ui/states";
import { LinkButton } from "@/shared/ui/buttons";

function FullScreenLoading({ label }: { label: string }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <p className="text-sm text-muted">{label}</p>
        <LoadingBlock rows={3} />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isMobile = useIsMobile();
  const { status, tenants, role, tenant, tenantId, sessionError, refresh } = useSession();
  const isOnboarding = pathname === "/app/onboarding";

  useEffect(() => {
    if (status === "anonymous") {
      const next = `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [router, status]);

  useEffect(() => {
    if (status === "authenticated" && tenants.length === 0 && !isOnboarding) {
      router.replace("/app/onboarding");
    }
  }, [isOnboarding, router, status, tenants.length]);

  // Aplikasi hanya disajikan di domain tenant akun: `/app` di domain platform
  // (atau di subdomain tenant lain) dialihkan ke subdomain tenant yang benar.
  // Onboarding pendaftaran baru dikecualikan karena subdomainnya baru dibuat
  // di halaman itu.
  useEffect(() => {
    if (status !== "authenticated" || !tenantId || tenants.length === 0) return;
    const ownSlug = tenants.find((item) => item.id === tenantId)?.slug;
    if (!ownSlug) return;
    if (isOnboarding && isPlatformApex(window.location.hostname)) return;
    const target = tenantHostRedirect(ownSlug, pathname, window.location.search);
    if (target) window.location.replace(target);
  }, [isOnboarding, pathname, status, tenantId, tenants]);

  if (status === "loading") return <FullScreenLoading label="Memeriksa sesi Anda…" />;
  if (status === "anonymous") return <FullScreenLoading label="Mengalihkan ke halaman masuk…" />;

  if (status === "error") {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Server tidak dapat dijangkau</h1>
          <ErrorState error={sessionError} onRetry={() => void refresh()} />
          <p className="text-xs text-muted">
            Status sesi tidak diketahui. Aplikasi tidak menganggap Anda masuk maupun keluar sampai
            server merespons.
          </p>
        </div>
      </div>
    );
  }

  if (isOnboarding) {
    return (
      <div className="auth-shell" id="main-content">
        <div className="auth-card auth-wide">{children}</div>
      </div>
    );
  }

  if (tenants.length === 0) return <FullScreenLoading label="Menyiapkan tenant…" />;

  if (!role && !tenant) return <FullScreenLoading label="Memuat konteks tenant…" />;

  // Guard UX: backend tetap memeriksa otorisasi setiap request.
  if (role && !canViewRoute(role, pathname)) {
    const Shell = isMobile ? MobileShell : DesktopShell;
    return (
      <Shell>
        <div className="page">
          <div className="panel">
            <EmptyState
              title="Akses ditolak"
              description="Peran akun Anda tidak memiliki izin untuk membuka halaman ini. Hubungi owner tenant bila akses diperlukan."
              action={
                <LinkButton href="/app" variant="primary">
                  Kembali ke ringkasan
                </LinkButton>
              }
            />
          </div>
          <p className="text-xs text-muted">
            Menyembunyikan tombol bukan kontrol keamanan; server menolak permintaan tanpa izin.{" "}
            <Link href="/app">Ringkasan</Link>
          </p>
        </div>
      </Shell>
    );
  }

  const Shell = isMobile ? MobileShell : DesktopShell;
  return <Shell>{children}</Shell>;
}

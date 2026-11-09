import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Kerangka halaman publik (landing, legal, offline). Katalog tenant sengaja
 * tidak ditautkan dari sini: katalog publik dibuka lewat URL tenant
 * (`{slug}.rentalio.my.id/katalog`), bukan dari halaman marketing.
 */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="public-header">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-name">Rentalio</span>
        </Link>
        <span className="spacer" />
        <nav className="cluster" aria-label="Navigasi publik">
          <Link className="btn btn-sm btn-ghost" href="/login">
            Masuk
          </Link>
          <Link className="btn btn-sm btn-primary" href="/register">
            Daftar owner
          </Link>
        </nav>
      </header>
      <main id="main-content">{children}</main>
      <footer
        style={{
          borderTop: "1px solid var(--sw-border)",
          background: "var(--sw-white)",
          padding: "var(--sw-space-6)",
        }}
      >
        <div
          className="row-between"
          style={{ maxWidth: "1160px", margin: "0 auto", alignItems: "flex-start" }}
        >
          <div className="stack-sm">
            <span className="brand-name" style={{ color: "var(--sw-text)" }}>
              Rentalio
            </span>
            <span className="text-xs text-muted">
              Platform manajemen penyewaan untuk bisnis rental di Indonesia.
            </span>
          </div>
          <nav className="cluster" aria-label="Tautan legal">
            <Link className="text-sm" href="/legal/terms">
              Syarat Layanan
            </Link>
            <Link className="text-sm" href="/legal/privacy">
              Kebijakan Privasi
            </Link>
            <Link className="text-sm" href="/login">
              Masuk
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
}

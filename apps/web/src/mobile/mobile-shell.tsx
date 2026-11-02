"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/shared/auth/session";
import { visibleNavGroups } from "@/shared/config/navigation";
import { useOpenConflictCount } from "@/features/conflicts/open-conflict-count";
import { usePendingExtensionCount } from "@/features/orders/pending-extension-count";
import { NavCountBadge } from "@/shared/ui/nav-badge";
import { RestrictedBanner } from "@/features/subscription/restricted-banner";
import { Button } from "@/shared/ui/buttons";
import { Icon, type IconName } from "@/shared/ui/icons";
import { Select } from "@/shared/ui/select";

function isActive(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

interface Tab {
  href: string;
  label: string;
  glyph: IconName;
}

/**
 * Mobile punya komposisi/navigasi sendiri, bukan dashboard desktop yang
 * diperkecil (Notion 09 — keputusan UI/UX desktop vs mobile).
 */
const BASE_TABS: Tab[] = [
  { href: "/app", label: "Ringkasan", glyph: "grid" },
  { href: "/app/bookings", label: "Booking", glyph: "calendar" },
  { href: "/app/orders", label: "Pesanan", glyph: "receipt" },
  { href: "/app/pos", label: "Kasir", glyph: "register" },
];

export function MobileShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { email, role, tenant, signOut, tenants, tenantId, selectTenant } = useSession();
  // Menu ditutup otomatis saat route berubah: status "terbuka" diikat ke path
  // tempat menu dibuka, bukan direset lewat effect.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null);
  const menuOpen = menuOpenAt === pathname;
  const setMenuOpen = (next: boolean) => setMenuOpenAt(next ? pathname : null);
  const [busy, setBusy] = useState(false);
  const groups = visibleNavGroups(role);
  const pendingExtensionCount = usePendingExtensionCount();
  const openConflictCount = useOpenConflictCount();

  useEffect(() => {
    document.body.style.overflow = menuOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  const allowedTabs = BASE_TABS.filter((tab) =>
    groups.some((group) => group.items.some((item) => item.href === tab.href)),
  );

  return (
    <div className="mobile-shell">
      <header className="mobile-topbar">
        <Link href="/app" className="brand" style={{ padding: 0, border: 0 }}>
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-name">{tenant?.name ?? "Rentalio"}</span>
        </Link>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ color: "#ffffff" }}
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          Menu
        </button>
      </header>

      <main className="mobile-content" id="main-content">
        <RestrictedBanner />
        {children}
      </main>

      <nav className="mobile-tabbar" aria-label="Navigasi utama">
        {allowedTabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="mobile-tab"
            aria-current={isActive(pathname, tab.href) ? "page" : undefined}
          >
            <span className="nav-icon" aria-hidden="true">
              <Icon name={tab.glyph} size={19} />
            </span>
            <span className="tab-label-row">
              {tab.label}
              {tab.href === "/app/orders" ? (
                <NavCountBadge
                  count={pendingExtensionCount}
                  label="permintaan perpanjangan menunggu keputusan"
                  inline
                />
              ) : null}
            </span>
          </Link>
        ))}
        <button
          type="button"
          className="mobile-tab"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          onClick={() => setMenuOpen(true)}
        >
          <span className="nav-icon" aria-hidden="true">
            <Icon name="menu" size={19} />
          </span>
          Menu
        </button>
      </nav>

      {menuOpen ? (
        <>
          <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <div className="drawer" id="mobile-menu" data-open={menuOpen} role="dialog" aria-modal="true" aria-label="Menu aplikasi">
            <div className="row-between" style={{ marginBottom: "var(--sw-space-3)" }}>
              <span className="brand-name">Menu</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ color: "#ffffff" }}
                onClick={() => setMenuOpen(false)}
              >
                Tutup
              </button>
            </div>

            {tenants.length > 1 ? (
              <label className="field" style={{ marginBottom: "var(--sw-space-4)" }}>
                <span className="label" style={{ color: "#dcd4c6" }}>
                  Tenant aktif
                </span>
                <Select
                  className="select"
                  value={tenantId ?? ""}
                  onChange={(event) => selectTenant(event.target.value)}
                >
                  {tenants.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name ?? item.slug}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}

            {groups.map((group) => (
              <div key={group.id} style={{ marginBottom: "var(--sw-space-3)" }}>
                <p className="nav-group-label">{group.label}</p>
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="nav-link"
                    aria-current={isActive(pathname, item.href) ? "page" : undefined}
                  >
                    <span className="nav-icon" aria-hidden="true">
                      <Icon name={item.glyph} size={17} />
                    </span>
                    {item.label}
                    {item.href === "/app/orders" ? (
                      <NavCountBadge
                        count={pendingExtensionCount}
                        label="permintaan perpanjangan menunggu keputusan"
                        inline
                      />
                    ) : null}
                    {item.href === "/app/conflicts" ? (
                      <NavCountBadge
                        count={openConflictCount}
                        tone="danger"
                        label="konflik perpanjangan belum diselesaikan"
                        inline
                      />
                    ) : null}
                  </Link>
                ))}
              </div>
            ))}

            <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "var(--sw-space-3)" }}>
              <p className="text-xs" style={{ color: "#98907f", marginBottom: "var(--sw-space-2)" }}>
                {email ?? "Sesi aktif"} · {role ?? "—"}
              </p>
              <Button
                size="sm"
                variant="ghost"
                style={{ color: "#dcd4c6" }}
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  void signOut().finally(() => setBusy(false));
                }}
              >
                Keluar
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

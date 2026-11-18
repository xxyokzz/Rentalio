"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useSession } from "@/shared/auth/session";
import { canManageMembers, type Role } from "@/shared/auth/permissions";
import { visibleNavGroups } from "@/shared/config/navigation";
import { useOpenConflictCount } from "@/features/conflicts/open-conflict-count";
import { usePendingExtensionCount } from "@/features/orders/pending-extension-count";
import { useReceivableAlertCount } from "@/features/reports/receivable-alert-count";
import { NavCountBadge } from "@/shared/ui/nav-badge";
import { RestrictedBanner, useTenantStatusBadge } from "@/features/subscription/restricted-banner";
import { TenantSwitcher } from "@/shared/layout/tenant-switcher";
import { BrandMark, Icon } from "@/shared/ui/icons";

function isActive(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function initials(value: string | null | undefined): string {
  if (!value) return "SW";
  const words = value
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "SW";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function DesktopShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { email, role, tenant, signOut, status, tenants } = useSession();
  const [busy, setBusy] = useState(false);
  const groups = visibleNavGroups(role as Role | undefined);
  const pendingExtensionCount = usePendingExtensionCount();
  const openConflictCount = useOpenConflictCount();
  const receivableAlertCount = useReceivableAlertCount();

  const activeGroup = groups.find((group) =>
    group.items.some((item) => isActive(pathname, item.href)),
  );
  const activeItem = activeGroup?.items.find((item) => isActive(pathname, item.href));

  // Label status mengikuti `tenant.subscription` dari server (trial, aktif,
  // grace, atau dibatasi). `tenantLoading`/`tenantError` tetap dipakai hook itu.
  const tenantState = useTenantStatusBadge();

  return (
    <div className="shell">
      <aside className="shell-sidebar" aria-label="Navigasi utama">
        <div className="sidebar-brand">
          <Link href="/app" className="brand">
            <span className="brand-mark" aria-hidden="true">
              <BrandMark />
            </span>
            <span className="brand-word">rentalio</span>
          </Link>
        </div>

        <div className="sidebar-tenant">
          <div className="tenant-card">
            <span className="tenant-avatar" aria-hidden="true">
              {initials(tenant?.name ?? tenants[0]?.name)}
            </span>
            <div className="tenant-copy">
              <span className="tenant-name" title={tenant?.name ?? tenants[0]?.name ?? "Tenant"}>
                {tenant?.name ?? tenants[0]?.name ?? "Memuat tenant…"}
              </span>
              <span className="tenant-meta">
                {role ?? "—"}
                {tenant?.timezone ? ` · ${tenant.timezone.replace("Asia/", "")}` : ""}
              </span>
            </div>
          </div>
          <div className="tenant-state" data-tone={tenantState.tone}>
            <span className="tenant-state-dot" aria-hidden="true" />
            {tenantState.label}
          </div>
          {tenants.length > 1 ? (
            <div className="tenant-switch">
              <TenantSwitcher compact />
            </div>
          ) : null}
        </div>

        <nav className="sidebar-nav" aria-label="Menu aplikasi">
          {groups.map((group) => (
            <div className="nav-group" key={group.id}>
              <p className="nav-group-label">{group.label}</p>
              {group.items.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="nav-link"
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="nav-icon" aria-hidden="true">
                      <Icon name={item.glyph} size={18} />
                    </span>
                    <span className="nav-label">{item.label}</span>
                    {item.href === "/app/orders" ? (
                      <NavCountBadge
                        count={pendingExtensionCount}
                        label="permintaan perpanjangan menunggu keputusan"
                      />
                    ) : null}
                    {item.href === "/app/conflicts" ? (
                      <NavCountBadge
                        count={openConflictCount}
                        tone="danger"
                        label="konflik perpanjangan belum diselesaikan"
                      />
                    ) : null}
                    {item.href === "/app/reports/damage-fees" ? (
                      <NavCountBadge
                        count={receivableAlertCount}
                        label="tagihan menua atau denda menggantung"
                      />
                    ) : null}
                    {active ? <span className="nav-active-dot" aria-hidden="true" /> : null}
                  </Link>
                );
              })}
            </div>
          ))}

          <div className="sidebar-nav-foot">
            <Link className="nav-link nav-link-quiet" href="/katalog">
              <span className="nav-icon" aria-hidden="true">
                <Icon name="store" size={18} />
              </span>
              <span className="nav-label">Katalog publik</span>
              <Icon name="external" size={14} className="nav-trailing" />
            </Link>
            {canManageMembers(role) ? null : (
              <p className="sidebar-note">
                Beberapa menu disesuaikan dengan peran kamu.
              </p>
            )}
          </div>
        </nav>

        <div className="sidebar-foot">
          <div className="account">
            <span className="avatar" aria-hidden="true">
              {initials(email?.split("@")[0])}
            </span>
            <span className="account-copy">
              <span className="account-email" title={email ?? undefined}>
                {email ?? "Sesi aktif"}
              </span>
              <span className="account-role">
                {role ?? "—"} · {status === "authenticated" ? "online" : "offline"}
              </span>
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Keluar dari akun"
              title="Keluar"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => {
                setBusy(true);
                void signOut().finally(() => setBusy(false));
              }}
            >
              <Icon name="logout" size={18} />
            </button>
          </div>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <div className="topbar-crumb">
            {activeGroup && activeItem && !activeItem.label.startsWith(activeGroup.label) ? (
              <>
                <span>{activeGroup.label}</span>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
              </>
            ) : null}
            <strong>{activeItem?.label ?? "Workspace"}</strong>
          </div>
          <div className="topbar-spacer" />
          {tenant ? (
            <span className="topbar-mode">
              <Icon name={tenant.bookingMode === "MANUAL" ? "clock" : "check"} size={14} />
              Booking {tenant.bookingMode === "MANUAL" ? "manual" : "otomatis"}
            </span>
          ) : null}
          <Link className="btn btn-sm btn-secondary topbar-cta" href="/katalog">
            <Icon name="external" size={15} />
            Lihat katalog
          </Link>
          <div className="topbar-user">
            <span className="avatar" aria-hidden="true">
              {initials(email?.split("@")[0])}
            </span>
            <span className="sr-only">
              {email ?? "Sesi aktif"}, peran {role ?? "tidak diketahui"}
            </span>
          </div>
        </header>
        <main className="shell-content" id="main-content">
          <RestrictedBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/tenants", label: "Tenant", permission: "platform.tenants.list" },
  { href: "/admins", label: "Admin & role", permission: "platform.roles.read" },
  { href: "/audit", label: "Audit", permission: "platform.audit.read" },
] as const;

/** Menu hanya menampilkan halaman yang permission-nya dimiliki sesi ini. */
export function ConsoleNav({ permissions }: { permissions: string[] }) {
  const pathname = usePathname();
  const items = ITEMS.filter((item) => permissions.includes(item.permission));

  if (items.length === 0) {
    return (
      <p className="sidebar__roles">
        Role Anda tidak memiliki akses ke halaman konsol mana pun. Hubungi Super Admin.
      </p>
    );
  }

  return (
    <nav className="nav" aria-label="Navigasi konsol">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={active ? "nav__link nav__link--active" : "nav__link"}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

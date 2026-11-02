import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AdminApiError, getAdminSession } from "@/shared/api/server";
import { ConsoleNav } from "@/shared/ui/console-nav";
import { LogoutButton } from "@/shared/ui/logout-button";

export const dynamic = "force-dynamic";

/**
 * Kerangka konsol: sesi diverifikasi di server sebelum halaman mana pun
 * dirender, sehingga tidak ada data tenant yang sempat dikirim ke browser
 * tanpa sesi admin yang sah.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  let session = null;
  let failure: string | null = null;

  try {
    session = await getAdminSession();
  } catch (error) {
    failure =
      error instanceof AdminApiError
        ? `API menolak permintaan (${error.status}): ${error.message}`
        : "API Rentalio tidak dapat dihubungi dari server admin.";
  }

  if (failure) {
    return (
      <main className="main" id="main-content">
        <div className="page">
          <div className="panel">
            <div className="panel__head">
              <h1 className="panel__title">Konsol tidak dapat dimuat</h1>
            </div>
            <div className="panel__body">
              <p className="alert alert--error">{failure}</p>
              <p className="subtle" style={{ marginTop: "0.6rem" }}>
                Pastikan backend berjalan di API_INTERNAL_URL lalu muat ulang halaman.
              </p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!session) redirect("/login?expired=1");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__name">Rentalio</span>
          <span className="brand__tag">Admin Platform</span>
        </div>
        <ConsoleNav permissions={session.permissions} />
        <div className="sidebar__foot">
          <div>
            <p className="sidebar__email">{session.email}</p>
            <p className="sidebar__roles">{session.roles.join(" · ") || "Tanpa role aktif"}</p>
          </div>
          <LogoutButton />
        </div>
      </aside>
      <main className="main" id="main-content">
        {children}
      </main>
    </div>
  );
}

"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SessionProvider } from "@/shared/auth/session";
import { ToastProvider } from "@/shared/ui/overlays";

function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV !== "production") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Service worker gagal: aplikasi tetap berfungsi online tanpa offline shell.
    });
  });
}

/** Indikator online/offline — tidak pernah mengklaim transaksi berhasil offline. */
function ConnectionStatus() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="inline-alert inline-alert-warning" role="status" style={{ borderRadius: 0 }}>
      Anda sedang offline. Data yang tampil mungkin sudah kedaluwarsa; tindakan yang mengubah
      transaksi tidak akan dianggap berhasil sampai server mengonfirmasi.
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    registerServiceWorker();
  }, []);

  return (
    <ToastProvider>
      <SessionProvider>
        <ConnectionStatus />
        {children}
      </SessionProvider>
    </ToastProvider>
  );
}

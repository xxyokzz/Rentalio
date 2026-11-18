"use client";

import { usePathname } from "next/navigation";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { useApi } from "@/shared/hooks/useApi";
import { loadReceivableAging } from "./receivable-aging-cache";

/**
 * Jumlah pesanan dengan tagihan atau denda yang sudah menua — badge pada menu
 * "Laporan denda".
 *
 * Angka berasal dari `alertCount` server agar aturan umur (14 hari tagihan,
 * 7 hari denda) tidak dihitung ulang dan bisa berbeda antar klien. Hanya
 * dimuat untuk peran dengan `report.read`; `null` berarti tidak ada badge,
 * termasuk saat memuat, supaya angka 0 sementara tidak muncul.
 *
 * Dimuat ulang setiap pindah halaman: pencatatan pembayaran atau pembatalan
 * denda mengubah angka begitu pengguna berpindah layar.
 */
export function useReceivableAlertCount(): number | null {
  const pathname = usePathname();
  const { role, tenantId } = useSession();
  const canRead = can(role as Role | undefined, "report.read");

  const state = useApi(
    canRead && tenantId ? () => loadReceivableAging(tenantId) : null,
    [tenantId, canRead, pathname],
  );

  if (!canRead) return null;
  const count = state.data?.alertCount ?? 0;
  return count > 0 ? count : null;
}

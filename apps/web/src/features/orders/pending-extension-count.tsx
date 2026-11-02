"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { extensionApi } from "@/shared/api/endpoints";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { subscribeExtensionActivity } from "@/shared/events/extension-activity";
import { useApi } from "@/shared/hooks/useApi";

/**
 * Jumlah permintaan perpanjangan yang menunggu keputusan — dipakai sebagai
 * badge pada menu Pesanan.
 *
 * Hanya dihitung bagi peran dengan `rental.extension.approve` (peran lain
 * tidak melihat panel antrean, jadi badge tidak relevan). `null` berarti
 * tidak ada badge yang boleh ditampilkan, termasuk saat masih memuat, agar
 * angka 0 sementara tidak pernah muncul.
 *
 * Dimuat ulang setiap pindah halaman **dan** setiap sinyal aktivitas
 * perpanjangan, sehingga keputusan setujui/tolak di halaman yang sedang
 * dibuka langsung mengubah angka tanpa navigasi.
 */
export function usePendingExtensionCount(): number | null {
  const pathname = usePathname();
  const { role, tenantId } = useSession();
  const canApprove = can(role as Role | undefined, "rental.extension.approve");
  const [activity, setActivity] = useState(0);

  useEffect(() => subscribeExtensionActivity(() => setActivity((value) => value + 1)), []);

  const state = useApi(
    canApprove && tenantId ? () => extensionApi.listTenant(tenantId) : null,
    [tenantId, canApprove, pathname, activity],
  );

  if (!canApprove) return null;
  const count = state.data?.length ?? 0;
  return count > 0 ? count : null;
}

"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { subscribeExtensionActivity } from "@/shared/events/extension-activity";
import { useApi } from "@/shared/hooks/useApi";
import { loadConflictOverview } from "./conflict-overview-cache";

/**
 * Jumlah konflik perpanjangan berstatus OPEN — badge pada menu "Konflik
 * perpanjangan".
 *
 * Hanya dihitung bagi peran dengan `rental.extension.resolve_conflict` (peran
 * yang memang bisa menindaklanjuti). Angka diambil dari `summary.openConflicts`
 * pada ringkasan operasional, bukan dari memotong daftar, sehingga dedupe
 * konflik yang muncul pada dua order tetap dihitung sekali oleh server.
 *
 * Dimuat ulang saat pindah halaman dan saat ada keputusan/penyelesaian
 * perpanjangan (sinyal aktivitas), sehingga badge turun segera setelah konflik
 * ditandai selesai — tanpa menunggu navigasi.
 *
 * Membaca lewat cache singkat (`conflict-overview-cache`) yang dipakai halaman
 * konflik juga, jadi membuka `/app/conflicts` tidak memicu dua request identik.
 */
export function useOpenConflictCount(): number | null {
  const pathname = usePathname();
  const { role, tenantId } = useSession();
  const canResolve = can(role as Role | undefined, "rental.extension.resolve_conflict");
  const [activity, setActivity] = useState(0);

  useEffect(() => subscribeExtensionActivity(() => setActivity((value) => value + 1)), []);

  const state = useApi(
    canResolve && tenantId ? () => loadConflictOverview(tenantId, "OPEN") : null,
    [tenantId, canResolve, pathname, activity],
  );

  if (!canResolve) return null;
  const count = state.data?.summary?.openConflicts ?? 0;
  return count > 0 ? count : null;
}

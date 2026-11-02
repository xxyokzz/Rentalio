"use client";

import Link from "next/link";
import { useSession } from "@/shared/auth/session";
import { formatDateTime } from "@/shared/format/date";
import { trialDaysLeft } from "@/shared/format/status";
import type { Schema } from "@/shared/api/endpoints";

type TenantSubscription = Schema<"TenantSubscription">;

/** Sisa kalimat yang dipakai semua alasan mode terbatas non-trial. */
const RESTRICTED_CONSEQUENCE =
  "Kamu masih bisa lihat data dan selesaikan pesanan berjalan. Untuk buat pesanan baru dan tambah produk, yuk aktifkan paket langganan tokomu.";

/**
 * Status langganan untuk UI.
 *
 * `restricted` diambil apa adanya dari server (`tenant.subscription`), yang
 * dihitung `SubscriptionPolicyService` — policy yang sama dengan guard
 * `403 TENANT_RESTRICTED`. Klien **tidak** menghitung ulang dari tanggal trial:
 * dulu banner tetap muncul setelah langganan aktif karena tanggal trial tenant
 * sudah lewat, padahal server mengizinkan command.
 *
 * Fallback (tanpa payload `subscription`, mis. kontrak lama) mempertahankan
 * heuristik lama agar banner tidak hilang total.
 */
export function useSubscriptionState() {
  const { tenant } = useSession();
  const subscription: TenantSubscription | null = tenant?.subscription ?? null;
  const trialEndsAt = subscription?.trialEndsAt ?? tenant?.trialEndsAt ?? null;
  const days = trialDaysLeft(trialEndsAt);
  const status = tenant?.status;
  const restricted = subscription
    ? subscription.restricted
    : status === "SUSPENDED" || (days !== null && days <= 0 && status === "ACTIVE");
  return { tenant, days, status, restricted, subscription, trialEndsAt };
}

function restrictedMessage(subscription: TenantSubscription | null, trialEndsAt: string | null, timezone: string): string {
  switch (subscription?.reason) {
    case "TRIAL_EXPIRED": {
      const endedAt = subscription.trialEndsAt ?? trialEndsAt;
      return `Masa coba gratis sudah berakhir${endedAt ? ` pada ${formatDateTime(endedAt, timezone)}` : ""}. ${RESTRICTED_CONSEQUENCE}`;
    }
    case "GRACE_EXPIRED": {
      const graceEndsAt = subscription.graceEndsAt;
      return `Masa tenggang langganan sudah berakhir${graceEndsAt ? ` pada ${formatDateTime(graceEndsAt, timezone)}` : ""}. ${RESTRICTED_CONSEQUENCE}`;
    }
    case "SUBSCRIPTION_CANCELLED":
      return `Langganan tokomu sudah dibatalkan. ${RESTRICTED_CONSEQUENCE}`;
    case "SUBSCRIPTION_EXPIRED":
      return `Masa langganan tokomu sudah berakhir. ${RESTRICTED_CONSEQUENCE}`;
    default:
      return `Langganan tokomu belum aktif. ${RESTRICTED_CONSEQUENCE}`;
  }
}

export type TenantBadgeTone = "muted" | "success" | "warning" | "danger";

export interface TenantStatusBadge {
  label: string;
  tone: TenantBadgeTone;
}

/**
 * Label status tenant pada sidebar.
 *
 * Urutannya sama dengan banner: penangguhan toko lebih dulu, lalu status
 * langganan dari server, baru fallback tanggal trial untuk payload lama.
 * Sebelumnya label hanya melihat `trialEndsAt`, sehingga tenant yang
 * langganannya dibatalkan tetapi trial-nya belum lewat tetap berbunyi
 * "Coba gratis N hari lagi".
 */
export function useTenantStatusBadge(): TenantStatusBadge {
  const { tenantLoading, tenantError } = useSession();
  const { tenant, subscription, restricted, status, days } = useSubscriptionState();

  if (tenantLoading) return { label: "Memuat…", tone: "muted" };
  if (tenantError) return { label: "Gagal memuat detail", tone: "danger" };
  if (status === "SUSPENDED") return { label: "Toko ditangguhkan", tone: "danger" };

  if (subscription) {
    if (restricted) {
      switch (subscription.reason) {
        case "TRIAL_EXPIRED":
          return { label: "Masa coba habis", tone: "warning" };
        case "GRACE_EXPIRED":
          return { label: "Masa tenggang habis", tone: "warning" };
        case "SUBSCRIPTION_CANCELLED":
          return { label: "Langganan dibatalkan", tone: "danger" };
        case "SUBSCRIPTION_EXPIRED":
          return { label: "Langganan berakhir", tone: "danger" };
        default:
          return { label: "Langganan tidak aktif", tone: "danger" };
      }
    }
    if (subscription.status === "TRIALING" && days !== null && days >= 0) {
      return {
        label: days === 0 ? "Masa coba habis hari ini" : `Coba gratis ${days} hari lagi`,
        tone: days <= 3 ? "warning" : "muted",
      };
    }
    if (subscription.status === "PAST_DUE") {
      return { label: "Masa tenggang", tone: "warning" };
    }
    return { label: "Paket aktif", tone: "success" };
  }

  // Payload lama tanpa `subscription`: pertahankan perilaku berbasis trial.
  if (days !== null && days >= 0) {
    return {
      label: days === 0 ? "Masa coba habis hari ini" : `Coba gratis ${days} hari lagi`,
      tone: days <= 3 ? "warning" : "muted",
    };
  }
  if (tenant?.status === "ACTIVE") return { label: "Paket aktif", tone: "success" };
  return { label: tenant?.status ?? "Status toko", tone: "muted" };
}

export function RestrictedBanner() {
  const { tenant, days, status, restricted, subscription, trialEndsAt } = useSubscriptionState();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";

  if (!tenant) return null;

  if (status === "SUSPENDED") {
    return (
      <div className="inline-alert inline-alert-danger" role="status" style={{ borderRadius: 0 }}>
        Akun toko kamu sedang ditangguhkan. Pembuatan pesanan baru dan ubah katalog dibatasi sementara.
        Hubungi tim bantuan Rentalio ya untuk mengaktifkan kembali.
      </div>
    );
  }

  if (restricted) {
    return (
      <div className="inline-alert inline-alert-warning" role="status" style={{ borderRadius: 0 }}>
        {restrictedMessage(subscription, trialEndsAt, timezone)}
      </div>
    );
  }

  // Peringatan menjelang berakhir hanya relevan selama masa trial. Subscription
  // berbayar yang aktif tidak boleh diberi pengingat "aktifkan paket".
  const trialEnding = days !== null && days >= 0 && days <= 3;
  const onTrial = subscription ? subscription.status === "TRIALING" : true;
  if (trialEnding && onTrial) {
    return (
      <div className="inline-alert inline-alert-warning" role="status" style={{ borderRadius: 0 }}>
        Masa coba gratis tersisa {Math.max(0, days)} hari lagi (berakhir{" "}
        {trialEndsAt ? formatDateTime(trialEndsAt, timezone) : "—"}).
        Yuk upgrade ke paket langganan biar transaksi tokomu tetap jalan lancar.
      </div>
    );
  }

  return null;
}

export function TrialNote() {
  const { tenant, days, subscription } = useSubscriptionState();
  const onTrial = subscription ? subscription.status === "TRIALING" : true;
  if (!tenant || days === null || !onTrial) return null;
  return (
    <p className="text-xs text-muted">
      Trial tersisa {Math.max(0, days)} hari · status tenant{" "}
      <Link href="/app/settings">pengaturan usaha</Link>
    </p>
  );
}

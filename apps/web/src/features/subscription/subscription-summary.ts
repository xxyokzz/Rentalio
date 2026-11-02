import type { Schema } from "@/shared/api/endpoints";
import { formatDate, formatDateTime } from "@/shared/format/date";
import { trialDaysLeft, type StatusDescriptor } from "@/shared/format/status";

/**
 * Ringkasan langganan untuk halaman Pengaturan usaha.
 *
 * Sumber datanya `tenant.subscription` dari server (policy yang sama dengan
 * guard `403 TENANT_RESTRICTED`), bukan hitungan tanggal trial di browser.
 * Alasan (`reason`) yang dipakai sebagai penentu, karena satu alasan bisa
 * muncul pada status yang sama (mis. `GRACE_PERIOD` untuk ACTIVE maupun
 * PAST_DUE).
 */
export interface SubscriptionSummary {
  badge: StatusDescriptor;
  detail: string;
}

const RESTRICTED_CONSEQUENCE =
  "Transaksi baru dan perubahan katalog ditahan sampai langganan aktif.";

export function subscriptionSummary(
  subscription: Schema<"TenantSubscription"> | null | undefined,
  timezone: string = "Asia/Jakarta",
): SubscriptionSummary | null {
  if (!subscription) return null;

  switch (subscription.reason) {
    case "TRIAL": {
      const days = trialDaysLeft(subscription.trialEndsAt);
      return {
        badge: { label: "Trial", tone: "info" },
        detail:
          days !== null && days >= 0
            ? `Sisa ${Math.max(0, days)} hari (berakhir ${formatDateTime(subscription.trialEndsAt, timezone)}).`
            : "Trial sedang berjalan.",
      };
    }

    case "ACTIVE_SUBSCRIPTION":
      return {
        badge: { label: "Aktif", tone: "success" },
        detail: subscription.periodEnd
          ? `Periode berjalan sampai ${formatDate(subscription.periodEnd, timezone)}.`
          : "Langganan aktif.",
      };

    case "GRACE_PERIOD":
      return {
        badge: { label: "Masa tenggang", tone: "warning" },
        detail: subscription.graceEndsAt
          ? `Pembayaran perpanjangan belum diterima. Masa tenggang berakhir ${formatDateTime(subscription.graceEndsAt, timezone)}.`
          : "Pembayaran perpanjangan belum diterima; masih dalam masa tenggang.",
      };

    case "TRIAL_EXPIRED":
      return {
        badge: { label: "Masa coba habis", tone: "warning" },
        detail: `Trial berakhir ${formatDateTime(subscription.trialEndsAt, timezone)}. ${RESTRICTED_CONSEQUENCE}`,
      };

    case "GRACE_EXPIRED":
      return {
        badge: { label: "Masa tenggang habis", tone: "danger" },
        detail: `Masa tenggang berakhir ${formatDateTime(subscription.graceEndsAt ?? subscription.periodEnd, timezone)}. ${RESTRICTED_CONSEQUENCE}`,
      };

    case "SUBSCRIPTION_CANCELLED":
      return {
        badge: { label: "Dibatalkan", tone: "danger" },
        detail: `Langganan sudah dibatalkan. ${RESTRICTED_CONSEQUENCE}`,
      };

    case "SUBSCRIPTION_EXPIRED":
      return {
        badge: { label: "Berakhir", tone: "danger" },
        detail: subscription.periodEnd
          ? `Masa langganan berakhir ${formatDate(subscription.periodEnd, timezone)}. ${RESTRICTED_CONSEQUENCE}`
          : `Masa langganan sudah berakhir. ${RESTRICTED_CONSEQUENCE}`,
      };

    case "SUBSCRIPTION_RESTRICTED":
      return {
        badge: { label: "Dibatasi", tone: "danger" },
        detail: `Langganan sedang dibatasi. ${RESTRICTED_CONSEQUENCE}`,
      };

    case "NO_ENTITLEMENT":
      return {
        badge: { label: "Belum aktif", tone: "danger" },
        detail: `Tenant belum punya langganan aktif. ${RESTRICTED_CONSEQUENCE}`,
      };

    default:
      return null;
  }
}

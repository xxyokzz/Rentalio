import { describe, expect, it } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { subscriptionSummary } from "./subscription-summary";

type Subscription = Schema<"TenantSubscription">;

function make(overrides: Partial<Subscription>): Subscription {
  return {
    status: "TRIALING",
    restricted: false,
    reason: "TRIAL",
    trialEndsAt: null,
    graceEndsAt: null,
    periodEnd: null,
    ...overrides,
  };
}

const daysFromNow = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

describe("subscriptionSummary (Pengaturan usaha)", () => {
  it("tidak menampilkan apa pun tanpa data subscription", () => {
    expect(subscriptionSummary(null)).toBeNull();
    expect(subscriptionSummary(undefined)).toBeNull();
  });

  it("menampilkan sisa hari selama trial", () => {
    const summary = subscriptionSummary(
      make({ trialEndsAt: daysFromNow(2) }),
      "Asia/Jakarta",
    );
    expect(summary?.badge).toEqual({ label: "Trial", tone: "info" });
    expect(summary?.detail).toMatch(/Sisa 2 hari/);
  });

  it("menampilkan langganan aktif beserta akhir periode", () => {
    const summary = subscriptionSummary(
      make({
        status: "ACTIVE",
        reason: "ACTIVE_SUBSCRIPTION",
        periodEnd: "2027-10-30T23:42:55.653Z",
      }),
      "Asia/Jakarta",
    );
    expect(summary?.badge).toEqual({ label: "Aktif", tone: "success" });
    expect(summary?.detail).toMatch(/sampai 30 Okt 2027|sampai 31 Okt 2027/);
  });

  it("membedakan masa tenggang dari langganan yang sudah dibatasi", () => {
    const grace = subscriptionSummary(
      make({
        status: "PAST_DUE",
        reason: "GRACE_PERIOD",
        graceEndsAt: "2026-11-02T00:00:00.000Z",
      }),
      "Asia/Jakarta",
    );
    expect(grace?.badge.label).toBe("Masa tenggang");
    expect(grace?.detail).toMatch(/Masa tenggang berakhir/);

    const expired = subscriptionSummary(
      make({
        status: "RESTRICTED",
        restricted: true,
        reason: "GRACE_EXPIRED",
        graceEndsAt: "2026-11-02T00:00:00.000Z",
      }),
      "Asia/Jakarta",
    );
    expect(expired?.badge).toEqual({ label: "Masa tenggang habis", tone: "danger" });
    expect(expired?.detail).toMatch(/ditahan sampai langganan aktif/);
  });

  it("menyebut trial habis tanpa mengklaim langganan aktif", () => {
    const summary = subscriptionSummary(
      make({
        status: "RESTRICTED",
        restricted: true,
        reason: "TRIAL_EXPIRED",
        trialEndsAt: "2026-10-25T02:52:16.464Z",
      }),
      "Asia/Jakarta",
    );
    expect(summary?.badge).toEqual({ label: "Masa coba habis", tone: "warning" });
    expect(summary?.detail).toMatch(/Trial berakhir/);
    // Tidak boleh mengklaim periode berbayar yang sedang berjalan.
    expect(summary?.detail).not.toMatch(/Periode berjalan/);
  });

  it("membedakan langganan dibatalkan, berakhir, dan dibatasi", () => {
    const cancelled = subscriptionSummary(
      make({ status: "CANCELLED", restricted: true, reason: "SUBSCRIPTION_CANCELLED" }),
    );
    expect(cancelled?.badge.label).toBe("Dibatalkan");

    const expired = subscriptionSummary(
      make({ status: "EXPIRED", restricted: true, reason: "SUBSCRIPTION_EXPIRED" }),
    );
    expect(expired?.badge.label).toBe("Berakhir");

    const restricted = subscriptionSummary(
      make({ status: "RESTRICTED", restricted: true, reason: "SUBSCRIPTION_RESTRICTED" }),
    );
    expect(restricted?.badge.label).toBe("Dibatasi");
  });

  it("menandai tenant tanpa entitlement", () => {
    const summary = subscriptionSummary(
      make({ status: "NONE", restricted: true, reason: "NO_ENTITLEMENT" }),
    );
    expect(summary?.badge).toEqual({ label: "Belum aktif", tone: "danger" });
  });
});

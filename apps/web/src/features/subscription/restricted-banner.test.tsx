import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schema } from "@/shared/api/endpoints";
import { RestrictedBanner, useTenantStatusBadge } from "./restricted-banner";

type Tenant = Schema<"TenantResponse">;
type Subscription = Schema<"TenantSubscription">;

let tenant: Tenant | null = null;
let tenantLoading = false;
let tenantError: unknown = null;

vi.mock("@/shared/auth/session", () => ({
  useSession: () => ({ tenant, tenantLoading, tenantError }),
}));

// Vitest tanpa `globals` tidak memicu auto-cleanup React Testing Library.
afterEach(cleanup);

const daysFromNow = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();

function makeTenant(
  status: Tenant["status"],
  trialEndsAt: string | null,
  subscription?: Subscription,
): Tenant {
  return {
    id: "tenant-1",
    slug: "demo-sewa",
    name: "Rental Kamera Bandung",
    timezone: "Asia/Jakarta",
    status,
    trialEndsAt,
    subscription,
  };
}

function activeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    status: "ACTIVE",
    restricted: false,
    reason: "ACTIVE_SUBSCRIPTION",
    trialEndsAt: null,
    graceEndsAt: null,
    periodEnd: daysFromNow(365),
    ...overrides,
  };
}

describe("RestrictedBanner", () => {
  beforeEach(() => {
    tenant = null;
    tenantLoading = false;
    tenantError = null;
  });

  it("menampilkan penangguhan toko apa pun status langganannya", () => {
    tenant = makeTenant("SUSPENDED", null, activeSubscription());
    render(<RestrictedBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/sedang ditangguhkan/i);
  });

  it("tidak menampilkan banner saat langganan aktif meski trial sudah lewat", () => {
    // Regresi: banner lama dihitung dari tanggal trial tenant sehingga tetap
    // muncul ("aktifkan paket langganan") padahal server mengizinkan command.
    tenant = makeTenant("ACTIVE", daysFromNow(-30), activeSubscription());
    const { container } = render(<RestrictedBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("memakai alasan TRIAL_EXPIRED dari server", () => {
    tenant = makeTenant(
      "ACTIVE",
      daysFromNow(-1),
      activeSubscription({
        status: "RESTRICTED",
        restricted: true,
        reason: "TRIAL_EXPIRED",
        trialEndsAt: "2026-10-25T02:52:16.464Z",
      }),
    );
    render(<RestrictedBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/Masa coba gratis sudah berakhir/i);
    expect(screen.getByRole("status")).toHaveTextContent(/aktifkan paket langganan/i);
  });

  it("memakai alasan GRACE_EXPIRED dan menyebut akhir masa tenggang", () => {
    tenant = makeTenant(
      "ACTIVE",
      daysFromNow(-40),
      activeSubscription({
        status: "RESTRICTED",
        restricted: true,
        reason: "GRACE_EXPIRED",
        periodEnd: "2026-10-20T00:00:00.000Z",
        graceEndsAt: "2026-10-23T00:00:00.000Z",
      }),
    );
    render(<RestrictedBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/Masa tenggang langganan sudah berakhir/i);
  });

  it("membedakan langganan yang dibatalkan dari trial habis", () => {
    tenant = makeTenant(
      "ACTIVE",
      daysFromNow(-10),
      activeSubscription({
        status: "CANCELLED",
        restricted: true,
        reason: "SUBSCRIPTION_CANCELLED",
      }),
    );
    render(<RestrictedBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/sudah dibatalkan/i);
    expect(screen.getByRole("status")).not.toHaveTextContent(/Masa coba gratis sudah berakhir/i);
  });

  it("memberi peringatan hanya selama masa trial yang hampir habis", () => {
    tenant = makeTenant("ACTIVE", daysFromNow(2), {
      status: "TRIALING",
      restricted: false,
      reason: "TRIAL",
      trialEndsAt: daysFromNow(2),
      graceEndsAt: null,
      periodEnd: null,
    });
    render(<RestrictedBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/Masa coba gratis tersisa 2 hari lagi/i);
  });

  it("tetap fail-closed bila payload lama belum membawa `subscription`", () => {
    // Tanpa data server, alasan spesifik tidak diketahui: tampilkan peringatan
    // umum, tetapi jangan diam saja saat trial sudah lewat.
    tenant = makeTenant("ACTIVE", daysFromNow(-5));
    render(<RestrictedBanner />);
    expect(screen.getByRole("status")).toHaveTextContent(/Langganan tokomu belum aktif/i);
  });
});

describe("useTenantStatusBadge (label sidebar)", () => {
  beforeEach(() => {
    tenant = null;
    tenantLoading = false;
    tenantError = null;
  });

  it("menampilkan state memuat dan gagal memuat detail", () => {
    tenantLoading = true;
    expect(renderHook(() => useTenantStatusBadge()).result.current).toEqual({
      label: "…",
      tone: "muted",
    });
    cleanup();

    tenantLoading = false;
    tenantError = new Error("jaringan putus");
    expect(renderHook(() => useTenantStatusBadge()).result.current).toEqual({
      label: "Gagal memuat detail",
      tone: "danger",
    });
  });

  it("menampilkan penangguhan toko", () => {
    tenant = makeTenant("SUSPENDED", null, activeSubscription());
    expect(renderHook(() => useTenantStatusBadge()).result.current).toEqual({
      label: "Toko ditangguhkan",
      tone: "danger",
    });
  });

  it("memakai subscription, bukan tanggal trial, saat langganan dibatalkan", () => {
    // Regresi: trial masih beberapa hari lagi, tetapi langganan sudah dibatalkan.
    tenant = makeTenant(
      "ACTIVE",
      daysFromNow(5),
      activeSubscription({ status: "CANCELLED", restricted: true, reason: "SUBSCRIPTION_CANCELLED" }),
    );
    expect(renderHook(() => useTenantStatusBadge()).result.current).toEqual({
      label: "Langganan dibatalkan",
      tone: "danger",
    });
  });

  it("menampilkan langganan aktif meski trial sudah lewat", () => {
    tenant = makeTenant("ACTIVE", daysFromNow(-30), activeSubscription());
    expect(renderHook(() => useTenantStatusBadge()).result.current).toEqual({
      label: "Paket aktif",
      tone: "success",
    });
  });

  it("menampilkan sisa hari trial dari tanggal efektif subscription", () => {
    tenant = makeTenant("ACTIVE", daysFromNow(2), {
      status: "TRIALING",
      restricted: false,
      reason: "TRIAL",
      trialEndsAt: daysFromNow(2),
      graceEndsAt: null,
      periodEnd: null,
    });
    expect(renderHook(() => useTenantStatusBadge()).result.current).toEqual({
      label: "Coba gratis 2 hari lagi",
      tone: "warning",
    });
  });

  it("membedakan trial habis dari langganan berakhir", () => {
    tenant = makeTenant(
      "ACTIVE",
      daysFromNow(-3),
      activeSubscription({ status: "RESTRICTED", restricted: true, reason: "TRIAL_EXPIRED" }),
    );
    expect(renderHook(() => useTenantStatusBadge()).result.current.label).toBe("Masa coba habis");
    cleanup();

    tenant = makeTenant(
      "ACTIVE",
      daysFromNow(-90),
      activeSubscription({ status: "EXPIRED", restricted: true, reason: "SUBSCRIPTION_EXPIRED" }),
    );
    expect(renderHook(() => useTenantStatusBadge()).result.current.label).toBe("Langganan berakhir");
  });

  it("menandai masa tenggang renewal gagal", () => {
    tenant = makeTenant(
      "ACTIVE",
      daysFromNow(-60),
      activeSubscription({ status: "PAST_DUE", restricted: false, reason: "GRACE_PERIOD" }),
    );
    expect(renderHook(() => useTenantStatusBadge()).result.current).toEqual({
      label: "Masa tenggang",
      tone: "warning",
    });
  });

  it("mempertahankan label trial untuk payload lama tanpa `subscription`", () => {
    tenant = makeTenant("ACTIVE", daysFromNow(-5));
    expect(renderHook(() => useTenantStatusBadge()).result.current).toEqual({
      label: "Paket aktif",
      tone: "success",
    });
  });
});

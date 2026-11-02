"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isUnauthenticated } from "@/shared/api/errors";
import { setCsrfToken } from "@/shared/api/client";
import { authApi, tenantApi, type Schema, type TenantSummary } from "@/shared/api/endpoints";
import type { Role } from "./permissions";

const TENANT_COOKIE = "sw_tenant";

type SessionStatus = "loading" | "authenticated" | "anonymous" | "error";

interface SessionContextValue {
  status: SessionStatus;
  email: string | null;
  /** Profil pendaftaran (ownerName/tenantName/tenantSlug) — prefill onboarding; null sebelum sesi terbaca. */
  profile: Schema<"SessionResponse">["user"] | null;
  tenants: TenantSummary[];
  tenantId: string | null;
  tenant: Schema<"TenantResponse"> | null;
  role: Role | undefined;
  tenantLoading: boolean;
  tenantError: unknown;
  sessionError: unknown;
  selectTenant: (tenantId: string) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Dipakai pada alur yang mengubah session/role (mis. terima undangan). */
  markAnonymous: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function readTenantCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${TENANT_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(TENANT_COOKIE.length + 1)) : null;
}

function writeTenantCookie(tenantId: string | null): void {
  if (typeof document === "undefined") return;
  // Pilihan tenant bukan data sensitif dan tidak dipakai sebagai otorisasi:
  // backend selalu memeriksa membership berdasarkan sesi.
  document.cookie =
    tenantId === null
      ? `${TENANT_COOKIE}=; path=/; max-age=0; samesite=lax`
      : `${TENANT_COOKIE}=${encodeURIComponent(tenantId)}; path=/; max-age=2592000; samesite=lax`;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<Schema<"SessionResponse">["user"] | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenantDetail, setTenantDetail] = useState<{
    id: string;
    detail: Schema<"TenantResponse">;
  } | null>(null);
  const [tenantFailure, setTenantFailure] = useState<{ id: string; error: unknown } | null>(null);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadTenants = useCallback(async () => {
    const list = await tenantApi.listMine();
    if (!mounted.current) return [];
    setTenants(list);
    const stored = readTenantCookie();
    const valid = list.find((item) => item.id === stored)?.id ?? list[0]?.id ?? null;
    setTenantId(valid);
    writeTenantCookie(valid);
    return list;
  }, []);

  // State hanya diubah di dalam callback promise, bukan di badan effect.
  const loadSession = useCallback(
    (): Promise<void> =>
      authApi
        .currentSession()
        .then(async (session) => {
          if (!mounted.current) return;
          setSessionError(null);
          setEmail(session.user?.email ?? null);
          setProfile(session.user ?? null);
          // Tunggu daftar tenant sebelum menandai sesi siap: bila status
          // "authenticated" lebih dulu, AppShell sempat melihat tenants kosong
          // dan mengalihkan pengguna ke onboarding padahal tenant sudah ada.
          await loadTenants();
          if (!mounted.current) return;
          setStatus("authenticated");
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          if (isUnauthenticated(error)) {
            setSessionError(null);
            setStatus("anonymous");
            setEmail(null);
            setProfile(null);
            setTenants([]);
            setTenantId(null);
            setTenantDetail(null);
            return;
          }
          // Gangguan jaringan/server saat cek sesi: jangan klaim login ATAU anonim.
          // Pengguna melihat state error dengan tombol coba lagi.
          setSessionError(error);
          setStatus("error");
        }),
    [loadTenants],
  );

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Muat detail tenant terpilih (status, trial, pengaturan). Detail dan error
  // disimpan bersama id-nya sehingga tenant lama tidak tampil saat berganti.
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    tenantApi
      .get(tenantId)
      .then((detail) => {
        if (!cancelled) setTenantDetail({ id: tenantId, detail });
      })
      .catch((error: unknown) => {
        if (!cancelled) setTenantFailure({ id: tenantId, error });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const tenant = tenantId && tenantDetail?.id === tenantId ? tenantDetail.detail : null;
  const tenantError = tenantId && tenantFailure?.id === tenantId ? tenantFailure.error : null;
  const tenantLoading = Boolean(tenantId) && tenant === null && tenantError === null;

  const selectTenant = useCallback((nextId: string) => {
    setTenantId(nextId);
    writeTenantCookie(nextId);
  }, []);

  const signIn = useCallback(
    async (loginEmail: string, password: string) => {
      const result = await authApi.login({ email: loginEmail, password });
      if (result.csrfToken) setCsrfToken(result.csrfToken);
      setEmail(result.user?.email ?? loginEmail);
      setProfile(result.user ?? null);
      await loadTenants();
      if (!mounted.current) return;
      setStatus("authenticated");
    },
    [loadTenants],
  );

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setCsrfToken(null);
      setStatus("anonymous");
      setEmail(null);
      setProfile(null);
      setTenants([]);
      setTenantId(null);
      setTenantDetail(null);
      writeTenantCookie(null);
      router.push("/login");
    }
  }, [router]);

  const markAnonymous = useCallback(() => {
    setCsrfToken(null);
    setStatus("anonymous");
    setEmail(null);
    setProfile(null);
    setTenants([]);
    setTenantId(null);
    setTenantDetail(null);
    writeTenantCookie(null);
  }, []);

  // Sesi dicabut/kedaluwarsa dari request mana pun: kembali ke login dengan
  // tujuan semula, tanpa membocorkan data sensitif.
  useEffect(() => {
    const onUnauthenticated = () => {
      if (!mounted.current) return;
      markAnonymous();
      const next = `${window.location.pathname}${window.location.search}`;
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    };
    window.addEventListener("rentalio:unauthenticated", onUnauthenticated);
    return () => window.removeEventListener("rentalio:unauthenticated", onUnauthenticated);
  }, [markAnonymous, router]);

  const role = useMemo<Role | undefined>(() => {
    const match = tenants.find((item) => item.id === tenantId);
    return match?.role;
  }, [tenants, tenantId]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      email,
      profile,
      tenants,
      tenantId,
      tenant,
      role,
      tenantLoading,
      tenantError,
      sessionError,
      selectTenant,
      signIn,
      signOut,
      refresh: loadSession,
      markAnonymous,
    }),
    [
      status,
      email,
      profile,
      tenants,
      tenantId,
      tenant,
      role,
      tenantLoading,
      tenantError,
      sessionError,
      selectTenant,
      signIn,
      signOut,
      loadSession,
      markAnonymous,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession harus dipakai di dalam SessionProvider");
  return context;
}

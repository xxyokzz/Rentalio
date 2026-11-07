"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { CronRunStatus } from "@/shared/api/types";
import { CRON_RUN_STATUS_LABELS } from "@/shared/labels";
import { EmptyState } from "@/shared/ui/states";

/** Jeda cek ulang otomatis selama riwayat masih kosong. */
export const CRON_EMPTY_REFRESH_SECONDS = 30;

export function CronEmptyState({ status }: { status?: CronRunStatus }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const remaining = useRef(CRON_EMPTY_REFRESH_SECONDS);
  const [seconds, setSeconds] = useState(CRON_EMPTY_REFRESH_SECONDS);

  const reload = useCallback(() => {
    remaining.current = CRON_EMPTY_REFRESH_SECONDS;
    setSeconds(CRON_EMPTY_REFRESH_SECONDS);
    startTransition(() => router.refresh());
  }, [router, startTransition]);

  useEffect(() => {
    const timer = setInterval(() => {
      remaining.current -= 1;
      if (remaining.current > 0) {
        setSeconds(remaining.current);
        return;
      }
      remaining.current = CRON_EMPTY_REFRESH_SECONDS;
      setSeconds(CRON_EMPTY_REFRESH_SECONDS);
      startTransition(() => router.refresh());
    }, 1000);
    return () => clearInterval(timer);
  }, [router, startTransition]);

  return (
    <EmptyState
      title={
        status
          ? `Tidak ada run berstatus “${CRON_RUN_STATUS_LABELS[status]}”`
          : "Belum ada run cron tercatat"
      }
    >
      <p className="subtle">
        {status
          ? "Filter status ini tidak cocok dengan run mana pun dalam 14 hari terakhir."
          : "Endpoint cron Vercel dipanggil tiap menit, tetapi belum ada eksekusi yang tercatat."}
      </p>
      {status ? (
        <p className="subtle">
          <Link className="btn btn--ghost btn--sm" href="/cron">
            Reset filter
          </Link>
        </p>
      ) : (
        <p className="subtle">
          Riwayat hanya menyimpan 14 hari terakhir. Bila daftar tetap kosong, periksa jadwal cron di
          Vercel dan variabel <span className="mono">CRON_SECRET</span> pada API.
        </p>
      )}
      <div className="empty__actions">
        <button
          className="btn btn--primary btn--sm"
          type="button"
          onClick={reload}
          disabled={pending}
        >
          {pending ? "Memeriksa…" : "Muat ulang sekarang"}
        </button>
        <span className="subtle">
          {pending ? "Memuat data terbaru…" : `Cek ulang otomatis dalam ${seconds} dtk.`}
        </span>
      </div>
    </EmptyState>
  );
}

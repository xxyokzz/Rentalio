"use client";

import { reportApi, type Schema } from "@/shared/api/endpoints";

type Aging = Schema<"ReceivableAgingResponse">;

/**
 * Cache singkat ringkasan umur piutang.
 *
 * Badge menu dan Ringkasan memakai loader yang sama, jadi keduanya tidak
 * memicu pemindaian pesanan berulang setiap navigasi. TTL pendek (30 detik)
 * membuat pembayaran/pembatalan denda tetap terlihat cepat, dan permintaan
 * yang berjalan bersamaan digabung agar tidak ada dua request identik.
 */
const TTL_MS = 30_000;

const entries = new Map<string, { value: Aging; at: number }>();
const inflight = new Map<string, Promise<Aging>>();

export function loadReceivableAging(tenantId: string): Promise<Aging> {
  const cached = entries.get(tenantId);
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value);

  const pending = inflight.get(tenantId);
  if (pending) return pending;

  const request = reportApi
    .receivableAging(tenantId)
    .then((value) => {
      entries.set(tenantId, { value, at: Date.now() });
      return value;
    })
    .finally(() => {
      inflight.delete(tenantId);
    });
  inflight.set(tenantId, request);
  return request;
}

/** Buang cache satu tenant (atau semuanya) setelah aksi yang mengubah tagihan. */
export function invalidateReceivableAging(tenantId?: string): void {
  if (tenantId) {
    entries.delete(tenantId);
    inflight.delete(tenantId);
    return;
  }
  entries.clear();
  inflight.clear();
}

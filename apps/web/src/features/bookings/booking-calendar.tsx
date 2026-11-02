"use client";

import { useMemo } from "react";
import type { Schema } from "@/shared/api/endpoints";
import { formatDate, isoToZonedDate, zonedLocalToIso } from "@/shared/format/date";

interface DayCell {
  iso: string;
  label: string;
  used: number;
  capacity: number;
  pending: number;
  conflict: boolean;
}

/**
 * Kalender ketersediaan memakai alokasi yang dikirim server, bukan estimasi
 * lokal. Angka "terpakai" adalah jumlah alokasi ACTIVE yang beririsan dengan
 * hari tersebut (unit untuk INDIVIDUAL_UNITS, kuantitas untuk QUANTITY).
 */
export function BookingCalendar({
  days,
  products,
  reservations,
  timezone,
}: {
  days: Date[];
  products: Array<Schema<"ProductResponse">>;
  reservations: Array<Schema<"ReservationResponse">>;
  timezone: string;
}) {
  const grid = useMemo(() => {
    return products.map((product) => {
      const cells: DayCell[] = days.map((day) => {
        // Batas hari mengikuti zona waktu tenant, bukan UTC perangkat.
        const localDate = isoToZonedDate(day.toISOString(), timezone);
        const dayStartIso = zonedLocalToIso(`${localDate}T00:00`, timezone);
        const dayStart = dayStartIso ? new Date(dayStartIso).getTime() : 0;
        const dayEnd = dayStart + 24 * 60 * 60 * 1000;
        let used = 0;
        let pending = 0;
        let conflict = false;

        for (const reservation of reservations) {
          if (reservation.status === "PENDING_APPROVAL") {
            const overlaps = (reservation.items ?? []).some(
              (item) =>
                item.productId === product.id &&
                new Date(item.startAt ?? 0).getTime() < dayEnd &&
                new Date(item.endAt ?? 0).getTime() > dayStart,
            );
            if (overlaps) pending += 1;
            continue;
          }
          if (reservation.status !== "CONFIRMED" && reservation.status !== "CONVERTED_TO_ORDER") continue;
          for (const allocation of reservation.allocations ?? []) {
            if (allocation.productId !== product.id || allocation.status !== "ACTIVE") continue;
            const start = new Date(allocation.startAt ?? 0).getTime();
            const end = new Date(allocation.endAt ?? 0).getTime();
            if (start < dayEnd && end > dayStart) {
              used += allocation.quantity ?? 0;
              if (reservation.hasOpenConflict) conflict = true;
            }
          }
        }

        return {
          iso: dayStartIso ?? new Date(dayStart).toISOString(),
          label: formatDate(new Date(dayStart).toISOString(), timezone),
          used,
          capacity: product.capacity ?? 0,
          pending,
          conflict,
        };
      });
      return { product, cells };
    });
  }, [days, products, reservations, timezone]);

  if (products.length === 0) {
    return <p className="text-sm text-muted">Belum ada produk untuk ditampilkan pada kalender.</p>;
  }

  return (
    <div className="calendar">
      <div className="calendar-scroll">
        <div
          className="calendar-grid"
          style={{ ["--sw-days" as string]: String(days.length) }}
          role="table"
          aria-label="Ketersediaan produk per hari"
        >
          <div className="calendar-cell calendar-head calendar-row-label" role="columnheader">
            Produk
          </div>
          {days.map((day) => (
            <div key={`head-${day.toISOString()}`} className="calendar-cell calendar-head" role="columnheader">
              {formatDate(day.toISOString(), timezone).replace(/\s\d{4}$/, "")}
            </div>
          ))}

          {grid.map(({ product, cells }) => (
            <div key={product.id} style={{ display: "contents" }}>
              <div className="calendar-cell calendar-row-label" role="rowheader">
                <span>{product.name}</span>
                <span className="text-xs text-muted">
                  {product.stockMode === "INDIVIDUAL_UNITS" ? "unit" : "stok"} · kapasitas{" "}
                  {product.capacity ?? 0}
                </span>
              </div>
              {cells.map((cell) => {
                const full = cell.capacity > 0 && cell.used >= cell.capacity;
                const free = Math.max(0, cell.capacity - cell.used);
                return (
                  <div
                    key={`${product.id}-${cell.iso}`}
                    className="calendar-cell"
                    role="cell"
                    aria-label={`${product.name}, ${cell.label}: ${cell.used} dari ${cell.capacity} terpakai${cell.pending ? `, ${cell.pending} menunggu persetujuan` : ""}`}
                  >
                    <div
                      className="calendar-bar"
                      data-conflict={cell.conflict ? "true" : undefined}
                      data-status={full && cell.used > 0 ? "PENDING_APPROVAL" : undefined}
                      title={`${cell.used}/${cell.capacity} terpakai${cell.pending ? `, ${cell.pending} menunggu` : ""}`}
                    >
                      {cell.capacity === 0 ? "—" : `${cell.used}/${cell.capacity}`}
                      {cell.pending > 0 ? ` (+${cell.pending})` : ""}
                      {cell.conflict ? " ⚠" : ""}
                      <span className="sr-only">{full ? " penuh" : ` sisa ${free}`}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">
        Angka menunjukkan alokasi aktif per hari. Tanda (+) adalah booking menunggu persetujuan tanpa
        alokasi. ⚠ menandai booking terdampak konflik perpanjangan. Ketersediaan final selalu dihitung
        ulang server saat submit.
      </p>
    </div>
  );
}

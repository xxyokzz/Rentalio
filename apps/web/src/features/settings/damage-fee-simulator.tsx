"use client";

import { useState } from "react";
import { formatIDR } from "@/shared/format/currency";
import { SelectInput, TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";
import {
  DAMAGE_SIMULATION_SEVERITIES,
  DAMAGE_SIMULATION_SEVERITY_LABEL,
  simulateDamageFee,
  type DamageFeeAmounts,
  type DamageSimulationSeverity,
} from "./damage-fee-simulation";

/**
 * Simulator nominal denda di layar pengaturan: memakai nilai formulir yang
 * sedang diisi (belum tentu tersimpan) sehingga owner bisa mencoba nominal,
 * override kategori, dan plafon sebelum menekan "Simpan pengaturan".
 */
export function DamageFeeSimulator({
  enabled,
  amounts,
  maxAmount,
  categories,
  categoryAmounts,
}: {
  enabled: boolean;
  amounts: DamageFeeAmounts;
  maxAmount: string;
  categories: { id: string; name: string }[];
  categoryAmounts: Record<string, DamageFeeAmounts>;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [severity, setSeverity] = useState<DamageSimulationSeverity>("MINOR");
  const [quantity, setQuantity] = useState("1");

  const simulation = simulateDamageFee({
    enabled,
    severity,
    quantity: Number.parseInt(quantity || "0", 10),
    categoryId,
    amounts,
    maxAmount,
    categoryAmounts,
  });

  return (
    <div className="stack-sm">
      <div>
        <p className="text-sm">
          <strong>Simulator nominal denda</strong>
        </p>
        <p className="text-xs text-muted">
          Perkiraan dari nilai formulir di atas, termasuk perubahan yang belum disimpan. Server tetap
          menghitung ulang usulan saat inspeksi dibuat.
        </p>
      </div>

      <div className="form-grid">
        <SelectInput
          label="Kategori simulator"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          hint="Pilih kategori untuk melihat pengaruh nominal khususnya."
        >
          <option value="">Umum (tanpa override kategori)</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Tingkat kondisi simulator"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as DamageSimulationSeverity)}
        >
          {DAMAGE_SIMULATION_SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {DAMAGE_SIMULATION_SEVERITY_LABEL[value]}
            </option>
          ))}
        </SelectInput>
        <TextInput
          label="Jumlah item simulator"
          inputMode="numeric"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ""))}
          hint="Jumlah barang dengan kondisi yang sama pada satu inspeksi."
        />
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Tingkat kondisi</th>
              <th scope="col">Nominal berlaku</th>
            </tr>
          </thead>
          <tbody>
            {DAMAGE_SIMULATION_SEVERITIES.map((value) => (
              <tr key={value}>
                <th scope="row">{DAMAGE_SIMULATION_SEVERITY_LABEL[value]}</th>
                <td className="money">{formatIDR(simulation.amounts[value])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {simulation.notice === "DISABLED" ? (
        <InlineAlert tone="info">
          Denda kerusakan nonaktif pada formulir, jadi usulan selalu Rp0. Aktifkan saklar denda untuk
          mencoba nominal.
        </InlineAlert>
      ) : null}
      {simulation.notice === "NO_QUANTITY" ? (
        <InlineAlert tone="info">
          Jumlah item belum diisi, jadi belum ada usulan denda.
        </InlineAlert>
      ) : null}
      {simulation.notice === "ZERO" ? (
        <InlineAlert tone="info">
          {simulation.source === "CATEGORY"
            ? `Nominal kategori ini Rp0 untuk tingkat ${DAMAGE_SIMULATION_SEVERITY_LABEL[severity]}. Override kategori berlaku penuh, jadi server tidak membuat usulan untuk kategori ini — bukan kembali ke nominal umum.`
            : `Nominal umum untuk tingkat ${DAMAGE_SIMULATION_SEVERITY_LABEL[severity]} Rp0, jadi tidak ada usulan denda.`}
        </InlineAlert>
      ) : null}

      <dl className="definition-list">
        <div>
          <dt>Nominal per item ({DAMAGE_SIMULATION_SEVERITY_LABEL[severity]})</dt>
          <dd className="money">{formatIDR(simulation.rate)}</dd>
        </div>
        <div>
          <dt>Usulan sebelum plafon</dt>
          <dd className="money">{formatIDR(simulation.rawAmount)}</dd>
        </div>
        <div>
          <dt>Usulan setelah plafon</dt>
          <dd className="money">{formatIDR(simulation.amount)}</dd>
        </div>
      </dl>

      <p className="text-xs text-muted">
        {simulation.source === "CATEGORY"
          ? "Nominal kategori menggantikan nominal umum sepenuhnya untuk kategori ini, termasuk bila satu tingkat diisi Rp0."
          : "Memakai nominal umum karena kategori ini belum punya nominal tersimpan. Setelah nominal kategori disimpan, nominal itu berlaku penuh — Rp0 berarti tanpa usulan."}
      </p>

      {simulation.capped ? (
        <InlineAlert tone="warning">
          Usulan dipotong ke plafon {formatIDR(simulation.maxAmount)}. Server menandai inspeksi sebagai
          terkena plafon, bukan menagih nominal penuh.
        </InlineAlert>
      ) : null}
    </div>
  );
}

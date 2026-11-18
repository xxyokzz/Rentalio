"use client";

import { useRef, useState } from "react";
import { inspectionApi, storageApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { formatDateTime } from "@/shared/format/date";
import { useSession } from "@/shared/auth/session";
import { Button } from "@/shared/ui/buttons";
import { Dialog, useToast } from "@/shared/ui/overlays";
import { EmptyState, InlineAlert } from "@/shared/ui/states";

type Inspection = Schema<"InspectionResponse">;
type Attachment = NonNullable<Schema<"InspectionResponse">["attachments"]>[number];

export const MAX_INSPECTION_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_INSPECTION_ATTACHMENTS = 10;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/**
 * Validasi klien sebelum upload: jenis file dan ukuran. Server tetap memeriksa
 * ulang saat metadata didaftarkan, jadi aturan ini hanya mencegah upload sia-sia.
 */
export function validateInspectionFile(file: {
  type: string;
  size: number;
}): string | null {
  if (!ALLOWED_MIME.includes(file.type)) return "Hanya JPEG, PNG, WebP, atau PDF.";
  if (file.size <= 0) return "File kosong tidak bisa diunggah.";
  if (file.size > MAX_INSPECTION_ATTACHMENT_BYTES) return "Ukuran maksimal 10 MB.";
  return null;
}

function fileSizeLabel(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lampiran bukti inspeksi: upload lewat presigned URL (browser → R2) lalu
 * daftarkan metadata ke inspeksi; unduh lewat URL bertanda tangan 5 menit.
 * Tidak ada URL publik permanen untuk bukti kerusakan.
 */
export function InspectionAttachmentsDialog({
  open,
  onClose,
  tenantId,
  inspection,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  inspection: Inspection | null;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const { tenant } = useSession();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const attachments = inspection?.attachments ?? [];
  const rejected = inspection?.status === "REJECTED";
  const full = attachments.length >= MAX_INSPECTION_ATTACHMENTS;

  const upload = async (file: File) => {
    if (!inspection?.id) return;
    const problem = validateInspectionFile(file);
    if (problem) {
      notify(problem, "error");
      return;
    }
    if (full) {
      notify(`Maksimal ${MAX_INSPECTION_ATTACHMENTS} lampiran per inspeksi.`, "error");
      return;
    }
    setBusy(true);
    try {
      const target = await storageApi.uploadUrl(tenantId, {
        category: "inspections",
        filename: file.name,
        contentType: file.type,
      });
      if (!target.uploadUrl || !target.objectKey) {
        throw new Error("Server tidak mengembalikan URL upload.");
      }
      const put = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) {
        throw new Error("Upload ke penyimpanan gagal. Coba lagi.");
      }
      await inspectionApi.addAttachment(tenantId, inspection.id, {
        objectKey: target.objectKey,
        mimeType: file.type,
        altText: file.name,
        sortOrder: 0,
        fileSizeBytes: file.size,
      });
      notify("Lampiran ditambahkan.", "success");
      onChanged();
    } catch (caught) {
      notify(
        caught instanceof Error && caught.message
          ? caught.message
          : describeApiError(caught),
        "error",
      );
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const download = async (objectKey: string | undefined) => {
    if (!objectKey) return;
    setBusy(true);
    try {
      const signed = await storageApi.downloadUrl(tenantId, objectKey);
      if (signed.downloadUrl) {
        window.open(signed.downloadUrl, "_blank", "noopener,noreferrer");
      }
    } catch (caught) {
      notify(describeApiError(caught), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Lampiran inspeksi"
      description="Foto/dokumen bukti kerusakan. Tautan unduh berlaku 5 menit dan hanya untuk anggota tenant."
      wide
      footer={
        <Button onClick={onClose} disabled={busy}>
          Tutup
        </Button>
      }
    >
      <div className="stack">
        {rejected ? (
          <InlineAlert tone="warning">
            Inspeksi yang ditolak tidak menerima lampiran baru.
          </InlineAlert>
        ) : (
          <div className="field">
            <label className="label" htmlFor="inspection-attachment-input">
              Tambah lampiran
            </label>
            <input
              id="inspection-attachment-input"
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              disabled={busy || full}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <p className="text-xs text-muted">
              JPEG/PNG/WebP/PDF, maksimal 10 MB, maksimal {MAX_INSPECTION_ATTACHMENTS} lampiran.
            </p>
          </div>
        )}

        {attachments.length === 0 ? (
          <EmptyState
            title="Belum ada lampiran"
            description="Unggah foto kondisi barang agar keputusan denda punya bukti."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Nama</th>
                  <th scope="col">Ukuran</th>
                  <th scope="col">Diunggah</th>
                  <th scope="col" className="text-right">
                    Aksi
                  </th>
                </tr>
              </thead>
              <tbody>
                {attachments.map((attachment) => (
                  <tr key={attachment.id}>
                    <td className="text-sm">
                      {attachment.altText ?? attachment.objectKey?.split("/").pop() ?? "Lampiran"}
                    </td>
                    <td className="text-sm">{fileSizeLabel(attachment.fileSizeBytes)}</td>
                    <td className="text-sm">
                      {attachment.uploadedAt
                        ? formatDateTime(attachment.uploadedAt, timezone)
                        : "—"}
                    </td>
                    <td>
                      <div className="table-actions">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void download(attachment.objectKey)}
                        >
                          Unduh
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Dialog>
  );
}

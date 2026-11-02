"use client";

import { useState } from "react";
import type { Schema } from "@/shared/api/endpoints";
import { contextLabel, methodLabel } from "@/shared/format/status";
import { copyToClipboard, whatsappShareUrl } from "@/shared/whatsapp";
import { Badge } from "./surfaces";
import { Button } from "./buttons";

/**
 * Snapshot pesan WhatsApp dari server. Ini hanya click-to-chat: tidak ada
 * pengiriman otomatis dan tidak mengubah status pembayaran.
 */
export function WhatsAppMessageCard({ message }: { message: Schema<"WhatsAppMessageResponse"> }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="panel" style={{ boxShadow: "none" }}>
      <div className="panel-body stack-sm">
        <div className="row-between">
          <div className="cluster">
            <Badge tone="info">{methodLabel(message.paymentMethod).label}</Badge>
            <Badge tone="neutral" plain>
              {contextLabel(message.context).label}
            </Badge>
            <Badge tone="neutral" plain>
              v{message.templateVersion ?? 1}
            </Badge>
          </div>
          <div className="cluster">
            <Button
              size="sm"
              onClick={async () => {
                const ok = await copyToClipboard(message.body ?? "");
                setCopied(ok);
                window.setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Tersalin" : "Salin pesan"}
            </Button>
            <a
              className="btn btn-sm btn-primary"
              href={whatsappShareUrl(message.body)}
              target="_blank"
              rel="noreferrer noopener"
            >
              Buka WhatsApp
            </a>
          </div>
        </div>
        <pre
          className="text-sm"
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
            padding: "var(--sw-space-3)",
            background: "var(--sw-panel-muted)",
            borderRadius: "var(--sw-radius-sm)",
            border: "1px solid var(--sw-border)",
            fontFamily: "var(--sw-font-sans)",
          }}
        >
          {message.body}
        </pre>
        <p className="text-xs text-muted">
          Nomor WhatsApp bisnis belum tersedia dari API; tautan membuka pemilih kontak WhatsApp tanpa
          nomor tujuan. Jangan menganggap pesan ini sebagai verifikasi pembayaran.
        </p>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { billingApi, tenantApi, type SubscriptionInvoice } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { useSession } from "@/shared/auth/session";
import { tenantCatalogUrl } from "@/shared/config/hosts";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime } from "@/shared/format/date";
import { tenantStatus, trialDaysLeft } from "@/shared/format/status";
import { Button } from "@/shared/ui/buttons";
import { CheckboxField, SelectInput, TextArea, TextInput } from "@/shared/ui/form";
import { useToast } from "@/shared/ui/overlays";
import { DefinitionList, Panel, PageHeader, PanelBody, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { subscriptionSummary } from "@/features/subscription/subscription-summary";
import { subscriptionRequest } from "@/features/subscription/subscription-request";
import { InlineAlert, LoadingBlock } from "@/shared/ui/states";

export function TenantSettings({ supportWhatsApp }: { supportWhatsApp: string }) {
  const { tenant, tenantLoading, tenantError, refresh, role } = useSession();
  const { notify } = useToast();
  // Tagihan langganan dibaca dari server. QRIS tidak punya callback, jadi
  // status lunas tidak pernah diubah optimistis oleh halaman ini.
  const [invoices, setInvoices] = useState<SubscriptionInvoice[]>([]);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const tenantId = tenant?.id;
  const isOwner = role === "OWNER";
  const billing = tenant?.billing;
  const billingEnabled = billing?.paymentEnabled === true;
  // Form diturunkan dari tenant di server; draft hanya menyimpan field yang
  // benar-benar diubah pengguna sehingga data server baru langsung terpakai.
  const [draft, setDraft] = useState<{
    bookingMode?: "MANUAL" | "AUTOMATIC";
    catalogPolicy?: "CHECK_AVAILABILITY" | "SKIP_AVAILABILITY";
    extensionEnabled?: boolean;
    whatsappNumber?: string;
    bankTransferInstructions?: string;
    qrisImageUrl?: string;
    lateFeeEnabled?: boolean;
    lateFeeUnit?: "DAY" | "HOUR";
    lateFeeRateAmount?: string;
    damageInspectionEnabled?: boolean;
    damageFeeEnabled?: boolean;
    damageFeeMinorAmount?: string;
    damageFeeModerateAmount?: string;
    damageFeeSevereAmount?: string;
    damageFeeMaxAmount?: string;
  }>({});
  const [busy, setBusy] = useState(false);

  const bookingMode =
    draft.bookingMode ?? (tenant?.bookingMode === "MANUAL" ? "MANUAL" : "AUTOMATIC");
  const catalogPolicy =
    draft.catalogPolicy ??
    (tenant?.catalogPolicy === "SKIP_AVAILABILITY" ? "SKIP_AVAILABILITY" : "CHECK_AVAILABILITY");
  const extensionEnabled = draft.extensionEnabled ?? tenant?.rentalExtensionEnabled !== false;
  const whatsappNumber = draft.whatsappNumber ?? tenant?.whatsappNumber ?? "";
  const bankTransferInstructions =
    draft.bankTransferInstructions ?? tenant?.bankTransferInstructions ?? "";
  const qrisImageUrl = draft.qrisImageUrl ?? tenant?.qrisImageUrl ?? "";
  const lateFeeEnabled = draft.lateFeeEnabled ?? tenant?.lateFeeEnabled === true;
  const lateFeeUnit = draft.lateFeeUnit ?? (tenant?.lateFeeUnit === "HOUR" ? "HOUR" : "DAY");
  const lateFeeRateAmount = draft.lateFeeRateAmount ?? tenant?.lateFeeRateAmount ?? "";
  const lateFeeRateInvalid = lateFeeEnabled && !(Number.parseInt(lateFeeRateAmount || "0", 10) > 0);
  const damageInspectionEnabled =
    draft.damageInspectionEnabled ?? tenant?.damageInspectionEnabled !== false;
  const damageFeeEnabled = draft.damageFeeEnabled ?? tenant?.damageFeeEnabled === true;
  const damageFeeMinorAmount = draft.damageFeeMinorAmount ?? tenant?.damageFeeMinorAmount ?? "";
  const damageFeeModerateAmount =
    draft.damageFeeModerateAmount ?? tenant?.damageFeeModerateAmount ?? "";
  const damageFeeSevereAmount = draft.damageFeeSevereAmount ?? tenant?.damageFeeSevereAmount ?? "";
  const damageFeeMaxAmount = draft.damageFeeMaxAmount ?? tenant?.damageFeeMaxAmount ?? "";
  // Server menolak denda aktif tanpa nominal; UI hanya memberi peringatan awal.
  const damageFeeAmounts = [
    damageFeeMinorAmount,
    damageFeeModerateAmount,
    damageFeeSevereAmount,
  ].map((value) => Number.parseInt(value || "0", 10));
  const damageFeeInvalid =
    damageFeeEnabled && (!damageInspectionEnabled || damageFeeAmounts.every((amount) => amount <= 0));

  const setBookingMode = (next: "MANUAL" | "AUTOMATIC") =>
    setDraft((current) => ({ ...current, bookingMode: next }));
  const setCatalogPolicy = (next: "CHECK_AVAILABILITY" | "SKIP_AVAILABILITY") =>
    setDraft((current) => ({ ...current, catalogPolicy: next }));
  const setExtensionEnabled = (next: boolean) =>
    setDraft((current) => ({ ...current, extensionEnabled: next }));

  const loadInvoices = async (id: string): Promise<void> => {
    try {
      setInvoices(await billingApi.listInvoices(id));
    } catch {
      // Riwayat tagihan bersifat pelengkap: kegagalan baca tidak memblokir
      // halaman pengaturan, tetapi jangan tampilkan data lama sebagai valid.
      setInvoices([]);
    }
  };

  useEffect(() => {
    // Tanpa pembayaran aktif tidak ada tagihan untuk ditampilkan; hindari
    // request yang pasti 403/404 pada tenant yang memakai jalur manual.
    if (!tenantId || !isOwner || !billingEnabled) return;
    let cancelled = false;
    void billingApi
      .listInvoices(tenantId)
      .then((rows) => {
        if (!cancelled) setInvoices(rows);
      })
      .catch(() => {
        if (!cancelled) setInvoices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, isOwner, billingEnabled]);

  const save = async () => {
    if (!tenant?.id) return;
    setBusy(true);
    try {
      await tenantApi.updateSettings(tenant.id, {
        bookingMode,
        catalogPolicy,
        rentalExtensionEnabled: extensionEnabled,
        whatsappNumber,
        bankTransferInstructions,
        qrisImageUrl,
        lateFeeEnabled,
        lateFeeUnit,
        // Server menolak tarif 0 saat denda aktif; klien tidak mengarang nilai.
        lateFeeRateAmount: Number.parseInt(lateFeeRateAmount || "0", 10),
        damageInspectionEnabled,
        damageFeeEnabled,
        damageFeeMinorAmount: Number.parseInt(damageFeeMinorAmount || "0", 10),
        damageFeeModerateAmount: Number.parseInt(damageFeeModerateAmount || "0", 10),
        damageFeeSevereAmount: Number.parseInt(damageFeeSevereAmount || "0", 10),
        // Kosong berarti tanpa plafon; server menyimpannya sebagai null.
        damageFeeMaxAmount: damageFeeMaxAmount
          ? Number.parseInt(damageFeeMaxAmount, 10)
          : null,
      });
      await refresh();
      setDraft({});
      notify("Pengaturan usaha disimpan.", "success");
    } catch (caught) {
      notify(describeApiError(caught), "error");
    } finally {
      setBusy(false);
    }
  };

  const days = trialDaysLeft(tenant?.trialEndsAt);
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  // Status langganan dari server: trial, aktif, masa tenggang, atau dibatasi.
  const subscription = subscriptionSummary(tenant?.subscription, timezone);
  // Perpanjangan/upgrade diproses manual oleh tim Rentalio (belum ada endpoint
  // billing); tautannya hanya menyiapkan pesan WhatsApp, tidak mengirim apa pun.
  const renewal = subscriptionRequest(
    {
      tenantName: tenant?.name,
      tenantSlug: tenant?.slug,
      statusLabel: subscription?.badge.label,
      subscriptionStatus: tenant?.subscription?.status,
      restricted: tenant?.subscription?.restricted ?? false,
    },
    supportWhatsApp,
  );
  const pendingInvoice = isOwner
    ? (invoices.find((invoice) => invoice.status === "PENDING" && invoice.qrPayload) ?? null)
    : null;

  // Membuat tagihan berarti menyiapkan QRIS dinamis bernominal. Status lunas
  // ditetapkan operator platform setelah dana terverifikasi, bukan oleh respons
  // ini (Notion 09/14).
  const startPayment = async (): Promise<void> => {
    if (!tenant?.id) return;
    setInvoiceBusy(true);
    setInvoiceError(null);
    try {
      const invoice = await billingApi.createInvoice(tenant.id);
      if (!invoice.qrPayload) {
        setInvoiceError("Tagihan dibuat tetapi kode QRIS tidak tersedia. Coba lagi.");
        return;
      }
      setInvoices((current) => [
        invoice,
        ...current.filter((row) => row.id !== invoice.id),
      ]);
    } catch (caught) {
      setInvoiceError(describeApiError(caught));
      await loadInvoices(tenant.id);
    } finally {
      setInvoiceBusy(false);
    }
  };

  const copyQrPayload = async (payload: string | null | undefined): Promise<void> => {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      notify("Kode QRIS disalin.", "success");
    } catch {
      notify("Gagal menyalin. Salin manual dari gambar QR.", "error");
    }
  };

  const checkPaymentStatus = async (): Promise<void> => {
    if (!tenant?.id) return;
    await refresh();
    await loadInvoices(tenant.id);
    notify("Status langganan dimuat ulang.", "success");
  };

  return (
    <div className="page">
      <PageHeader
        title="Pengaturan usaha"
        subtitle="Atur profil tokomu, cara konfirmasi booking, dan kontak WhatsApp toko di sini."
      />

      {tenantLoading ? <LoadingBlock rows={3} /> : null}
      {tenantError ? (
        <InlineAlert tone="danger">{describeApiError(tenantError)}</InlineAlert>
      ) : null}

      {tenant ? (
        <>
          <Panel>
            <PanelHead title="Informasi toko" description="Tautan katalog publik tokomu untuk disebar ke calon pelanggan." />
            <PanelBody>
              <DefinitionList
                items={[
                  { term: "Nama toko", value: tenant.name ?? "—" },
                  { term: "Slug", value: <span className="mono">{tenant.slug ?? "—"}</span> },
                  {
                    term: "Link katalog",
                    value: tenant.slug ? (
                      <Link href={tenantCatalogUrl(tenant.slug)}>
                        {tenant.slug}.rentalio.my.id/katalog
                      </Link>
                    ) : (
                      "—"
                    ),
                  },
                  { term: "Zona waktu", value: tenant.timezone ?? "Asia/Jakarta" },
                  { term: "Status toko", value: <StatusBadge status={tenantStatus(tenant.status)} /> },
                  { term: "Mulai aktif", value: formatDateTime(tenant.activatedAt, timezone) },
                  {
                    term: "Akhir masa coba",
                    // Sisa hari hanya relevan sebelum trial berakhir; "0 hari lagi"
                    // pada tenant berlangganan menyesatkan.
                    value: `${formatDateTime(tenant.trialEndsAt, timezone)}${
                      days !== null && days >= 0 ? ` (${days} hari lagi)` : ""
                    }`,
                  },
                ]}
              />
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="Langganan"
              description="Perpanjang atau aktifkan paket langganan Rentalio. Pembayaran lewat QRIS."
            />
            <PanelBody>
              <div className="stack">
                {subscription ? (
                  <p className="text-sm">
                    <StatusBadge status={subscription.badge} />{" "}
                    <span className="text-xs text-muted">{subscription.detail}</span>
                  </p>
                ) : (
                  <p className="text-sm text-muted">Status langganan belum tersedia.</p>
                )}

                {billingEnabled && billing ? (
                  <>
                    <p className="text-sm">
                      Harga paket: <strong>{formatIDR(billing.priceAmount)}</strong> /{" "}
                      {billing.periodDays} hari.
                    </p>
                    {invoiceError ? <InlineAlert tone="danger">{invoiceError}</InlineAlert> : null}
                    {!isOwner ? (
                      <p className="text-xs text-muted">
                        Hanya owner yang dapat membayar langganan.
                      </p>
                    ) : pendingInvoice ? (
                      <div className="stack">
                        <InlineAlert tone="info">
                          Pindai QR di bawah dengan aplikasi bank atau e-wallet apa pun yang
                          mendukung QRIS. Nominal <strong>{formatIDR(pendingInvoice.amount)}</strong>{" "}
                          sudah terisi otomatis. Tagihan berlaku sampai{" "}
                          {formatDateTime(pendingInvoice.expiresAt, timezone)}.
                        </InlineAlert>
                        {pendingInvoice.qrImageDataUrl ? (
                          <Image
                            src={pendingInvoice.qrImageDataUrl}
                            alt="QRIS pembayaran langganan Rentalio"
                            width={256}
                            height={256}
                            unoptimized
                            style={{ borderRadius: 8, background: "#fff", maxWidth: "100%" }}
                          />
                        ) : null}
                        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                          <Button
                            variant="secondary"
                            onClick={() => void copyQrPayload(pendingInvoice.qrPayload)}
                          >
                            Salin kode QRIS
                          </Button>
                          <Button variant="secondary" onClick={() => void checkPaymentStatus()}>
                            Cek status pembayaran
                          </Button>
                        </div>
                        <p className="text-xs text-muted">
                          Setelah membayar, kirim bukti ke tim Rentalio. Status lunas diperbarui
                          operator setelah dana terverifikasi — QRIS tidak mengabarkan pembayaran
                          secara otomatis.
                        </p>
                      </div>
                    ) : (
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        <Button
                          variant="primary"
                          loading={invoiceBusy}
                          onClick={() => void startPayment()}
                        >
                          Tampilkan QR pembayaran
                        </Button>
                        <Button variant="secondary" onClick={() => void checkPaymentStatus()}>
                          Cek status pembayaran
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div>
                      <a
                        className="btn btn-primary"
                        href={renewal.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {renewal.label}
                      </a>
                    </div>
                    <p className="text-xs text-muted">
                      Pembayaran online belum aktif. Tautan membuka WhatsApp berisi ringkasan tokomu —
                      pesan tetap kamu kirim sendiri. Paket diaktifkan setelah pembayaran dikonfirmasi
                      tim Rentalio.
                    </p>
                  </>
                )}
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Cara konfirmasi booking" description="Berlaku untuk booking baru yang masuk dari katalog." />
            <PanelBody>
              <div className="stack">
                <SelectInput
                  label="Mode booking"
                  value={bookingMode}
                  onChange={(event) => setBookingMode(event.target.value as "MANUAL" | "AUTOMATIC")}
                  hint="Otomatis: langsung terkonfirmasi kalau stok ada. Manual: kamu perlu menyetujui dulu baru pesanan diproses."
                >
                  <option value="AUTOMATIC">Otomatis (Langsung konfirmasi jika stok ada)</option>
                  <option value="MANUAL">Manual (Perlu persetujuan kamu dulu)</option>
                </SelectInput>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="Kebijakan katalog & perpanjangan"
              description="Satu policy tersimpan untuk katalog dan perpanjangan."
            />
            <PanelBody>
              <div className="stack">
                <CheckboxField
                  label="Aktifkan pengajuan perpanjangan sewa"
                  checked={extensionEnabled}
                  onChange={setExtensionEnabled}
                  hint="Bila nonaktif, portal/API menolak pengajuan perpanjangan; return dan inspeksi tetap berjalan."
                />
                <SelectInput
                  label="Policy ketersediaan"
                  value={catalogPolicy}
                  onChange={(event) =>
                    setCatalogPolicy(event.target.value as "CHECK_AVAILABILITY" | "SKIP_AVAILABILITY")
                  }
                >
                  <option value="CHECK_AVAILABILITY">A — Periksa ketersediaan periode tambahan</option>
                  <option value="SKIP_AVAILABILITY">
                    B — Tanpa pemeriksaan awal untuk perpanjangan
                  </option>
                </SelectInput>
                {catalogPolicy === "SKIP_AVAILABILITY" ? (
                  <InlineAlert tone="warning">
                    Opsi B memungkinkan overlap pada perpanjangan. Approval konflik hanya melalui override
                    khusus dengan permission <code>rental.extension.override_conflict</code>, alasan wajib,
                    konfirmasi risiko, audit, dan tugas penyelesaian. Untuk booking baru, Opsi B menolak
                    permintaan saat stok tidak tersedia.
                  </InlineAlert>
                ) : null}
                <p className="text-xs text-muted">
                  Perilaku item kosong di katalog mengikuti policy yang sama: A mengizinkan permintaan
                  PENDING_APPROVAL tanpa alokasi; B memblokir booking dan menampilkan “Tanyakan via
                  WhatsApp”.
                </p>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="Denda keterlambatan"
              description="Dihitung server dari waktu terima barang dibanding batas waktu sewa."
            />
            <PanelBody>
              <div className="stack">
                <CheckboxField
                  label="Aktifkan denda keterlambatan"
                  checked={lateFeeEnabled}
                  onChange={(next) => setDraft((current) => ({ ...current, lateFeeEnabled: next }))}
                  hint="Bila nonaktif, pengembalian yang telat tetap tercatat tetapi denda selalu Rp0."
                />
                <SelectInput
                  label="Satuan denda"
                  value={lateFeeUnit}
                  disabled={!lateFeeEnabled}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      lateFeeUnit: event.target.value as "DAY" | "HOUR",
                    }))
                  }
                  hint="Pilih per hari untuk sewa harian, per jam untuk sewa jam-jaman."
                >
                  <option value="DAY">Per hari</option>
                  <option value="HOUR">Per jam</option>
                </SelectInput>
                <TextInput
                  label={lateFeeUnit === "HOUR" ? "Tarif denda per jam (Rp)" : "Tarif denda per hari (Rp)"}
                  inputMode="numeric"
                  value={lateFeeRateAmount}
                  disabled={!lateFeeEnabled}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      lateFeeRateAmount: event.target.value.replace(/\D/g, ""),
                    }))
                  }
                  hint="IDR rupiah utuh tanpa desimal. Keterlambatan dibulatkan ke atas per satuan."
                />
                {lateFeeRateInvalid ? (
                  <InlineAlert tone="warning">
                    Tarif harus lebih dari Rp0 agar denda bisa disimpan.
                  </InlineAlert>
                ) : null}
                <p className="text-xs text-muted">
                  Denda yang dihitung server menjadi usulan pada inspeksi pengembalian; nominal akhirnya
                  tetap diputuskan petugas berizin dan tidak otomatis menambah tagihan pesanan.
                </p>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="Inspeksi & denda kerusakan"
              description="Nominal per tingkat kondisi dipakai sebagai usulan otomatis saat inspeksi dibuat."
            />
            <PanelBody>
              <div className="stack">
                <CheckboxField
                  label="Aktifkan inspeksi kerusakan"
                  checked={damageInspectionEnabled}
                  onChange={(next) =>
                    setDraft((current) => ({ ...current, damageInspectionEnabled: next }))
                  }
                  hint="Bila nonaktif, pencatatan pengembalian tetap berjalan tetapi inspeksi baru ditolak."
                />
                <CheckboxField
                  label="Aktifkan denda kerusakan"
                  checked={damageFeeEnabled}
                  disabled={!damageInspectionEnabled}
                  onChange={(next) =>
                    setDraft((current) => ({ ...current, damageFeeEnabled: next }))
                  }
                  hint="Bila nonaktif, usulan denda kondisi selalu kosong tetapi nominal tersimpan tidak dihapus."
                />
                <div className="form-grid">
                  <TextInput
                    label="Denda kondisi ringan (Rp)"
                    inputMode="numeric"
                    value={damageFeeMinorAmount}
                    disabled={!damageFeeEnabled}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        damageFeeMinorAmount: event.target.value.replace(/\D/g, ""),
                      }))
                    }
                  />
                  <TextInput
                    label="Denda kondisi sedang (Rp)"
                    inputMode="numeric"
                    value={damageFeeModerateAmount}
                    disabled={!damageFeeEnabled}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        damageFeeModerateAmount: event.target.value.replace(/\D/g, ""),
                      }))
                    }
                  />
                  <TextInput
                    label="Denda kondisi parah (Rp)"
                    inputMode="numeric"
                    value={damageFeeSevereAmount}
                    disabled={!damageFeeEnabled}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        damageFeeSevereAmount: event.target.value.replace(/\D/g, ""),
                      }))
                    }
                  />
                </div>
                <TextInput
                  label="Plafon usulan denda (Rp)"
                  inputMode="numeric"
                  value={damageFeeMaxAmount}
                  disabled={!damageFeeEnabled}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      damageFeeMaxAmount: event.target.value.replace(/\D/g, ""),
                    }))
                  }
                  hint="Opsional. Usulan di atas plafon dipotong otomatis dan ditandai di inspeksi. Kosongkan bila tanpa plafon."
                />
                {damageFeeInvalid ? (
                  <InlineAlert tone="warning">
                    Isi minimal satu nominal lebih dari Rp0 dan aktifkan inspeksi sebelum denda kondisi
                    dapat disimpan.
                  </InlineAlert>
                ) : null}
                <p className="text-xs text-muted">
                  Nominal disalin ke snapshot inspeksi saat inspeksi dibuat, sehingga perubahan setelahnya
                  tidak mengubah usulan inspeksi yang sedang berjalan. Usulan tidak otomatis menagih atau
                  memotong deposit.
                </p>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead
              title="Kontak & pembayaran publik"
              description="Dipakai pada tautan WhatsApp katalog dan portal pesanan penyewa."
            />
            <PanelBody>
              <div className="stack">
                <TextInput
                  label="Nomor WhatsApp bisnis"
                  inputMode="tel"
                  placeholder="+62 812 3456 7890"
                  value={whatsappNumber}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, whatsappNumber: event.target.value }))
                  }
                  hint="Kosongkan untuk menghapus. Penyewa memakai tautan click-to-chat, bukan pesan otomatis."
                />
                <TextArea
                  label="Instruksi transfer bank"
                  rows={4}
                  placeholder="Contoh: Transfer ke BCA 1234567890 a.n. Nama Usaha. Cantumkan referensi booking."
                  value={bankTransferInstructions}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      bankTransferInstructions: event.target.value,
                    }))
                  }
                  hint="Jangan mengarang nomor rekening. Kosongkan bila pembayaran dilakukan di tempat."
                />
                <TextInput
                  label="URL gambar QRIS"
                  type="url"
                  placeholder="https://…/qris.png"
                  value={qrisImageUrl}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, qrisImageUrl: event.target.value }))
                  }
                  hint="URL https yang dapat diakses publik. Kosongkan bila tidak memakai QRIS."
                />
              </div>
            </PanelBody>
          </Panel>

          <div className="form-actions">
            <Link className="btn btn-secondary" href="/app/settings/payment-methods">
              Metode pembayaran
            </Link>
            <Link className="btn btn-secondary" href="/app/settings/whatsapp-templates">
              Template WhatsApp
            </Link>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Simpan pengaturan
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

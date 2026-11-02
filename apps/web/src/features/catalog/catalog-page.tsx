"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { publicApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError, isConflict } from "@/shared/api/errors";
import { formatIDR, rentalDays } from "@/shared/format/currency";
import { formatDateRange, isoToZonedLocal, zonedLocalToIso } from "@/shared/format/date";
import { reservationStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { whatsappShareUrl } from "@/shared/whatsapp";
import { Button } from "@/shared/ui/buttons";
import { CheckboxField, TextInput } from "@/shared/ui/form";
import { Dialog } from "@/shared/ui/overlays";
import { Select } from "@/shared/ui/select";
import { Badge, PageHeader, Panel, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";
import {
  blocksUnavailableBooking,
  canRequestUnavailableStock,
  DEFAULT_CATALOG_POLICY,
} from "./policy";
import {
  PublicCatalogBlocks,
  catalogBlockList,
  catalogThemeStyle,
  isGlassTheme,
} from "./public-catalog-blocks";

/**
 * Versi syarat sewa yang dikirim bersama booking tamu dan disimpan pada
 * reservasi. Naikkan versi ini bila teks /legal/terms berubah material.
 */
export const RENTAL_TERMS_VERSION = "2026-10-21";

type PublicTenant = Schema<"PublicTenantResponse">;
type PublicProduct = Schema<"PublicProductResponse">;
type Availability = Schema<"AvailabilityResponse">;
type BookingResult = Schema<"PublicBookingResponse">;

function rentQuestion(
  product: PublicProduct,
  tenantName: string,
  period: { start: string; end: string },
  qty: number,
) {
  const lines = [
    `Halo Admin ${tenantName}, saya ingin menanyakan ketersediaan barang sewa.`,
    "",
    `Produk/unit: ${product.name ?? "—"}`,
    `Jumlah yang dibutuhkan: ${qty}`,
    period.start && period.end ? `Periode sewa: ${period.start} – ${period.end}` : "",
    "",
    "Apakah barang tersebut tersedia untuk periode di atas? Jika tidak tersedia, apakah ada unit alternatif atau jadwal lain yang bisa dipilih?",
    "",
    "Terima kasih.",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * Periode sewa awal untuk sheet pemesanan: mulai 1 jam dari sekarang, durasi
 * 1 hari, ditampilkan pada zona waktu tenant (Notion 09 §6).
 */
function defaultRentalRange(timezone: string): { start: string; end: string } {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: isoToZonedLocal(start.toISOString(), timezone),
    end: isoToZonedLocal(end.toISOString(), timezone),
  };
}

export function CatalogPage({ slug }: { slug: string }) {
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [selected, setSelected] = useState<PublicProduct | null>(null);

  const catalogState = useApi(() => publicApi.getCatalog(slug), [slug]);
  // Konfigurasi presentasi hasil publish editor (Notion 06 WEB-07). Kegagalan
  // memuat konfigurasi tidak memblokir katalog: halaman memakai tata letak
  // default dan tetap bisa dipakai untuk booking.
  const configState = useApi(() => publicApi.getCatalogConfig(slug), [slug]);
  const blocks = useMemo(
    () => catalogBlockList(configState.data?.config),
    [configState.data],
  );
  const theme = configState.data?.config?.theme as Record<string, unknown> | undefined;
  const catalog = catalogState.data;
  const tenant: PublicTenant | undefined = catalog?.tenant;
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const products = useMemo(() => catalog?.products ?? [], [catalog]);
  const categories = useMemo(() => catalog?.categories ?? [], [catalog]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((product) => {
      if (term && !(product.name ?? "").toLowerCase().includes(term)) return false;
      if (categoryId && product.categoryId !== categoryId) return false;
      return true;
    });
  }, [products, search, categoryId]);

  if (catalogState.initialLoading) {
    return (
      <div className="public-main">
        <EmptyState title="Memuat katalog…" description="Mengambil produk dan tarif dari server." />
      </div>
    );
  }

  if (catalogState.error) {
    return (
      <div className="public-main">
        <PageHeader title="Katalog tidak ditemukan" subtitle="Periksa kembali tautan katalog tenant." />
        <InlineAlert tone="danger">{describeApiError(catalogState.error)}</InlineAlert>
        <p className="text-sm text-muted">
          Katalog hanya tersedia untuk tenant aktif. Tautan yang salah, tenant yang belum aktif, atau
          koneksi yang gagal tidak menampilkan data lama sebagai pengganti.
        </p>
        <div className="cluster">
          <Button onClick={() => catalogState.reload()}>Coba lagi</Button>
          <Link className="btn btn-ghost" href="/">
            Kembali ke beranda
          </Link>
        </div>
      </div>
    );
  }

  const productSlot = (config: Record<string, unknown>) => {
    const columns = Number(config.columns);
    const layout = Number.isFinite(columns) && columns >= 2 && columns <= 4 ? columns : null;
    const showPrice = config.showPrice !== false;
    const showCategory = config.showCategory !== false;
    if (filtered.length === 0) {
      return (
        <EmptyState
          title="Tidak ada produk yang cocok"
          description="Ubah kata kunci atau kategori, atau hubungi admin tenant."
        />
      );
    }
    return (
      <div
        className="catalog-grid"
        style={layout ? { gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(1120 / layout)}px, 1fr))` } : undefined}>
        {filtered.map((product) => {
          const categoryName = categories.find((category) => category.id === product.categoryId)?.name;
          return (
            <button
              key={product.id}
              type="button"
              className="product-card"
              onClick={() => setSelected(product)}
              aria-label={`Lihat dan pesan ${product.name ?? "produk"}`}>
              <span className="product-thumb" aria-hidden="true">
                Foto belum tersedia
              </span>
              <h3>{product.name}</h3>
              {showCategory && categoryName ? (
                <span className="text-xs text-muted">{categoryName}</span>
              ) : null}
              {product.description ? (
                <span className="product-description">{product.description}</span>
              ) : null}
              {showPrice ? (
                <span className="product-price">
                  {product.rate?.perDayAmount
                    ? `${formatIDR(product.rate.perDayAmount)} / hari`
                    : "Tarif belum diatur"}
                </span>
              ) : null}
              <span className="text-xs text-muted">
                {product.stockMode === "INDIVIDUAL_UNITS"
                  ? "Unit individual"
                  : `Stok ${product.capacity ?? 0}`}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  const categorySlot = (config: Record<string, unknown>) => {
    if (categories.length === 0) return null;
    const showCount = config.showCount === true;
    const chip = config.style !== "grid" && config.style !== "list";
    return (
      <div className={chip ? "cluster pcat-chips" : "pcat-cards pcat-cards--grid"}>
        <button
          type="button"
          className={`pcat-chip ${categoryId === "" ? "pcat-chip--active" : ""}`}
          onClick={() => setCategoryId("")}>
          Semua kategori
        </button>
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            className={`pcat-chip ${categoryId === category.id ? "pcat-chip--active" : ""}`}
            onClick={() => setCategoryId(category.id ?? "")}>
            {category.name}
            {showCount
              ? ` (${products.filter((product) => product.categoryId === category.id).length})`
              : ""}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div
      className={`public-main ${isGlassTheme(theme) ? "public-main--glass" : ""}`}
      style={catalogThemeStyle(theme)}>
      <PageHeader
        breadcrumb={<span>Katalog toko</span>}
        title={tenant?.name ?? "Katalog"}
        subtitle={
          tenant
            ? `Pilih barang sewaan, periksa tanggal yang pas, lalu booking online dengan mudah.`
            : undefined
        }
      />

      <div className="toolbar">
        <TextInput
          label="Cari barang"
          placeholder="Nama produk"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          wrapperClassName="field-grow"
        />
        <label className="field">
          <span className="label">Kategori</span>
          <Select
            className="select"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            <option value="">Semua kategori</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {/* Susunan blok mengikuti konfigurasi yang dipublikasikan tenant. Bila
          konfigurasi belum termuat, komponen ini tetap menampilkan grid produk. */}
      <PublicCatalogBlocks
        blocks={blocks}
        tenantName={tenant?.name ?? "Toko"}
        theme={theme}
        whatsappNumber={tenant?.whatsappNumber ?? null}
        renderCategories={categorySlot}
        renderProducts={productSlot}
      />

      {selected && tenant ? (
        <ProductSheet
          key={selected.id}
          slug={slug}
          tenant={tenant}
          initialProduct={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {/* Langkah booking disediakan blok `how_to_book`; panel statis hanya
          dipakai bila tenant mematikan blok tersebut. */}
      {!blocks.some((block) => block.type === "how_to_book") ? (
        <Panel>
          <div className="panel-body stack-sm">
            <h2 className="panel-title">Cara booking sewa</h2>
            <ol className="ordered-list">
              <li>Pilih barang yang ingin kamu sewa dan tentukan tanggalnya.</li>
              <li>Cek ketersediaan unit untuk periode sewa yang kamu pilih.</li>
              <li>Isi data kontakmu, setujui syarat sewa, lalu klik ajukan booking.</li>
              <li>
                Simpan link pesanan yang muncul setelah booking untuk pantau status dan cara pembayaran.
              </li>
            </ol>
            <p className="text-xs text-muted">
              Pembayaran akan dicek dan diverifikasi oleh admin toko. Hubungi admin via WhatsApp jika butuh bantuan lebih lanjut.
            </p>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function ProductSheet({
  slug,
  tenant,
  initialProduct,
  onClose,
}: {
  slug: string;
  tenant: PublicTenant;
  initialProduct: PublicProduct;
  onClose: () => void;
}) {
  // Detail produk diambil ulang dari server agar deskripsi/tarif yang dipakai
  // untuk booking bukan salinan daftar yang mungkin sudah berubah.
  const detailState = useApi<Schema<"PublicProductDetailResponse">>(
    () => publicApi.getProduct(slug, initialProduct.id ?? ""),
    [slug, initialProduct.id],
  );
  const product: PublicProduct = detailState.data?.product ?? initialProduct;

  const timezone = tenant.timezone ?? "Asia/Jakarta";
  const policy = tenant.catalogPolicy ?? DEFAULT_CATALOG_POLICY;
  const bookingMode = tenant.bookingMode ?? "MANUAL";

  const [defaultRange] = useState(() => defaultRentalRange(timezone));
  const [startLocal, setStartLocal] = useState(defaultRange.start);
  const [endLocal, setEndLocal] = useState(defaultRange.end);
  const [quantity, setQuantity] = useState(1);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [guestName, setGuestName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [result, setResult] = useState<BookingResult | null>(null);
  // Kunci idempotensi dipertahankan selama payload identik sehingga percobaan
  // ulang setelah error jaringan tidak membuat booking ganda. Payload yang
  // berubah (periode, jumlah, kontak) memakai kunci baru agar server tidak
  // menolaknya sebagai IDEMPOTENCY_KEY_REUSED.
  const [idempotency, setIdempotency] = useState<{ signature: string; key: string } | null>(
    null,
  );

  const startIso = zonedLocalToIso(startLocal, timezone);
  const endIso = zonedLocalToIso(endLocal, timezone);
  const days = startIso && endIso ? rentalDays(startIso, endIso) : 0;
  const estimate =
    Number.parseInt(product.rate?.perDayAmount ?? "0", 10) * Math.max(0, days) * quantity;
  const unavailable = availability ? (availability.available ?? 0) < quantity : false;
  const blockedByPolicy = unavailable && blocksUnavailableBooking(policy);

  const check = async () => {
    setError(null);
    if (!startIso || !endIso || new Date(endIso) <= new Date(startIso)) {
      setError("Periode sewa tidak valid.");
      return;
    }
    setChecking(true);
    try {
      const snapshot = await publicApi.checkAvailability(slug, {
        productId: product.id ?? "",
        startAt: startIso,
        endAt: endIso,
      });
      setAvailability(snapshot);
    } catch (caught) {
      setAvailability(null);
      setError(describeApiError(caught));
    } finally {
      setChecking(false);
    }
  };

  const book = async () => {
    setError(null);
    if (!startIso || !endIso || new Date(endIso) <= new Date(startIso)) {
      setError("Periode sewa tidak valid.");
      return;
    }
    if (guestName.trim().length < 2) {
      setError("Isi nama lengkap minimal 2 karakter.");
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError("Isi nomor WhatsApp atau email agar admin dapat menghubungi Anda.");
      return;
    }
    if (!termsAccepted) {
      setError("Anda harus menyetujui syarat sewa sebelum mengajukan booking.");
      return;
    }
    if (blockedByPolicy) {
      setError(
        "Barang tidak tersedia pada periode ini dan tenant memakai Opsi B, sehingga booking tidak dapat diajukan. Gunakan Tanya via WhatsApp atau ubah periode.",
      );
      return;
    }

    const payload: Schema<"CreatePublicBookingRequest"> = {
      startAt: startIso,
      endAt: endIso,
      items: [{ productId: product.id ?? "", quantity }],
      guest: {
        name: guestName.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      },
      terms: { accepted: true, version: RENTAL_TERMS_VERSION },
    };
    const signature = JSON.stringify(payload);
    const idempotencyKey =
      idempotency?.signature === signature
        ? idempotency.key
        : typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    setIdempotency({ signature, key: idempotencyKey });

    setBusy(true);
    try {
      const booking = await publicApi.createBooking(slug, payload, idempotencyKey);
      setResult(booking);
    } catch (caught) {
      setError(
        isConflict(caught)
          ? "Stok berubah atau permintaan bentrok. Periksa ketersediaan lalu coba lagi."
          : describeApiError(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return <BookingResultSheet result={result} onClose={onClose} />;
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={product.name ?? "Produk"}
      description={product.description ?? undefined}
      wide
      footer={
        <>
          <Button onClick={onClose}>Tutup</Button>
          <Button onClick={() => void check()} loading={checking}>
            Periksa ketersediaan
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void book()}
            disabled={blockedByPolicy}
          >
            {blockedByPolicy
              ? "Tidak tersedia — hubungi admin"
              : unavailable && canRequestUnavailableStock(policy)
                ? "Ajukan permintaan stok"
                : "Ajukan booking"}
          </Button>
        </>
      }
    >
      <div className="stack">
        {error ? (
          <InlineAlert tone="danger">
            <span role="alert">{error}</span>
          </InlineAlert>
        ) : null}
        {detailState.error ? (
          <InlineAlert tone="warning">
            Detail terbaru gagal dimuat; data dari daftar katalog tetap ditampilkan.
          </InlineAlert>
        ) : null}

        <div className="cluster">
          <Badge tone="info">
            {product.rate?.perDayAmount
              ? `${formatIDR(product.rate.perDayAmount)} / hari`
              : "Tarif belum diatur"}
          </Badge>
          <Badge tone="neutral">
            {product.stockMode === "INDIVIDUAL_UNITS"
              ? "Unit individual"
              : `Stok ${product.capacity ?? 0}`}
          </Badge>
          <Badge tone="neutral">
            Mode booking: {bookingMode === "MANUAL" ? "perlu persetujuan" : "otomatis"}
          </Badge>
        </div>

        <div className="form-grid">
          <TextInput
            label={`Mulai (${timezone})`}
            type="datetime-local"
            value={startLocal}
            onChange={(event) => {
              setStartLocal(event.target.value);
              setAvailability(null);
            }}
          />
          <TextInput
            label={`Selesai (${timezone})`}
            type="datetime-local"
            value={endLocal}
            onChange={(event) => {
              setEndLocal(event.target.value);
              setAvailability(null);
            }}
          />
          <TextInput
            label="Jumlah"
            inputMode="numeric"
            value={String(quantity)}
            onChange={(event) =>
              setQuantity(
                Math.max(1, Number.parseInt(event.target.value.replace(/\D/g, "") || "1", 10)),
              )
            }
          />
        </div>

        <div className="total-row">
          <span>Estimasi biaya</span>
          <span className="money">{formatIDR(estimate)}</span>
        </div>
        <p className="text-xs text-muted">
          Estimasi lokal dari tarif harian × {Math.max(0, days)} hari × {quantity}. Total final
          dihitung server dari tarif tersimpan.
        </p>

        {availability ? (
          <InlineAlert tone={unavailable ? "warning" : "info"}>
            Ketersediaan server: {availability.available ?? 0} dari kapasitas{" "}
            {availability.capacity ?? 0}
            {availability.maintenanceBlocked
              ? ` · ${availability.maintenanceBlocked} unit maintenance`
              : ""}
            .{" "}
            {unavailable
              ? blocksUnavailableBooking(policy)
                ? "Tenant memakai Opsi B: booking baru ditolak saat stok kosong; gunakan Tanya via WhatsApp."
                : "Tenant memakai Opsi A: permintaan tetap dapat dikirim sebagai PENDING_APPROVAL tanpa alokasi, termasuk bila mode booking otomatis. Admin memvalidasi ulang sebelum mengalokasikan."
              : "Hasil awal bukan jaminan alokasi."}
          </InlineAlert>
        ) : null}

        <div className="cluster">
          <a
            className="btn btn-secondary btn-sm"
            href={whatsappShareUrl(
              rentQuestion(product, tenant.name ?? "tenant", { start: startLocal, end: endLocal }, quantity),
              tenant.whatsappNumber,
            )}
            target="_blank"
            rel="noreferrer noopener"
          >
            Tanyakan via WhatsApp
          </a>
          <span className="text-xs text-muted">
            {tenant.whatsappNumber
              ? "Pesan berisi produk, jumlah, dan periode; Anda tetap harus menekan Kirim."
              : "Tenant belum mengatur nomor WhatsApp; pesan akan membuka pemilih kontak."}
          </span>
        </div>

        {availability && !unavailable && startIso && endIso ? (
          <p className="text-sm">{formatDateRange(startIso, endIso, timezone)}</p>
        ) : null}

        <details>
          <summary className="text-sm">Lihat tarif lain</summary>
          <div className="stack-sm" style={{ marginTop: "var(--sw-space-2)" }}>
            <div className="total-row">
              <span>Mingguan</span>
              <span className="money">{formatIDR(product.rate?.perWeekAmount ?? null)}</span>
            </div>
            <div className="total-row">
              <span>Bulanan</span>
              <span className="money">{formatIDR(product.rate?.perMonthAmount ?? null)}</span>
            </div>
          </div>
        </details>

        <fieldset className="stack-sm booking-contact">
          <legend className="panel-title">Kontak kamu</legend>
          <p className="text-xs text-muted">
            Data ini hanya digunakan oleh toko untuk memproses pesanan dan tidak perlu registrasi akun.
          </p>
          <TextInput
            label="Nama lengkap"
            required
            autoComplete="name"
            value={guestName}
            onChange={(event) => setGuestName(event.target.value)}
          />
          <div className="form-grid">
            <TextInput
              label="Nomor WhatsApp"
              inputMode="tel"
              autoComplete="tel"
              hint="Minimal isi salah satu: WhatsApp atau email."
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
            <TextInput
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <CheckboxField
            checked={termsAccepted}
            onChange={setTermsAccepted}
            label={
              <>
                Saya menyetujui{" "}
                <Link href="/legal/terms" target="_blank">
                  Syarat Layanan
                </Link>{" "}
                dan{" "}
                <Link href="/legal/privacy" target="_blank">
                  Kebijakan Privasi
                </Link>{" "}
                (versi {RENTAL_TERMS_VERSION}).
              </>
            }
          />
        </fieldset>
      </div>
    </Dialog>
  );
}

function BookingResultSheet({
  result,
  onClose,
}: {
  result: BookingResult;
  onClose: () => void;
}) {
  const reservation = result.reservation;
  const portalPath = result.portal?.path ?? (result.portal?.token ? `/portal/${result.portal.token}` : null);
  const status = reservationStatus(reservation?.status);

  return (
    <Dialog
      open
      onClose={onClose}
      title="Booking berhasil dikirim!"
      description="Simpan link pesanan di bawah ini untuk pantau status dan cara pembayarannya ya."
      footer={
        <>
          <Button onClick={onClose}>Tutup</Button>
          {portalPath ? (
            <Link className="btn btn-primary" href={portalPath}>
              Buka link pesanan
            </Link>
          ) : null}
        </>
      }
    >
      <div className="stack">
        <div className="cluster">
          <StatusBadge status={status} />
          <Badge tone="neutral">
            {reservation?.bookingMode === "AUTOMATIC" ? "Booking otomatis" : "Booking manual"}
          </Badge>
        </div>

        {reservation?.status === "CONFIRMED" ? (
          <InlineAlert tone="info">
            Booking sudah dikonfirmasi toko dan unit sewa sudah diamankan untuk jadwal kamu!
          </InlineAlert>
        ) : (
          <InlineAlert tone="warning">
            Pesanan booking sudah masuk dan menunggu konfirmasi dari admin toko.
          </InlineAlert>
        )}

        <dl className="definition-list">
          <dt>Nomor referensi</dt>
          <dd className="mono text-sm">{reservation?.reference ?? "—"}</dd>
          <dt>Total sewa</dt>
          <dd className="money">{formatIDR(reservation?.totalAmount ?? null)}</dd>
        </dl>

        {reservation?.startAt && reservation.endAt ? (
          <p className="text-sm">
            Jadwal: {formatDateRange(reservation.startAt, reservation.endAt, result.tenant?.timezone ?? "Asia/Jakarta")}
          </p>
        ) : null}

        {portalPath ? (
          <div className="stack-sm">
            <TextInput label="Link pesanan kamu" readOnly value={portalPath} />
            <p className="text-xs text-muted">
              Simpan link ini baik-baik ya, kamu bisa buka kapan saja untuk melihat update pesanan dan konfirmasi pembayaran.
            </p>
          </div>
        ) : (
          <InlineAlert tone="warning">
            Link pesanan belum tersedia. Silakan hubungi admin toko via WhatsApp untuk informasi pesananmu.
          </InlineAlert>
        )}
      </div>
    </Dialog>
  );
}

"use client";

import type { CSSProperties, ReactNode } from "react";
import type { Schema } from "@/shared/api/endpoints";

/**
 * Renderer katalog publik untuk konfigurasi yang sudah dipublikasikan
 * (Notion 06 WEB-07).
 *
 * Batas tanggung jawab:
 * - Hanya PRESENTASI. Harga, stok, ketersediaan, dan pembayaran tetap berasal
 *   dari endpoint katalog/booking — blok tidak pernah menentukan angka.
 * - Teks dirender sebagai text node (React meng-escape), tidak ada
 *   dangerouslySetInnerHTML; tag/skema berbahaya sudah ditolak server saat
 *   konfigurasi disimpan.
 * - Blok `categories` dan `featured` memakai data katalog asli yang diambil
 *   server lewat prop slot, bukan data yang ditulis di editor.
 */
export type PublicCatalogConfig = Schema<"PublicCatalogConfigResponse">;

export interface CatalogBlock {
  id: string;
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface CatalogBlockListProps {
  blocks: CatalogBlock[];
  tenantName: string;
  /** Tema tenant (warna aksen dipakai tombol & banner). */
  theme?: Record<string, unknown>;
  whatsappNumber?: string | null;
  /** Slot kartu kategori (data asli dari server). */
  renderCategories?: (config: Record<string, unknown>) => ReactNode;
  /** Slot grid produk (data asli dari server). */
  renderProducts?: (config: Record<string, unknown>) => ReactNode;
}

/* ───────────────────────────────────────────── nilai aman ── */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

/** Opasitas editor dikirim 0-100 (%). */
function alpha(value: unknown, fallbackPct: number): number {
  return Math.min(100, Math.max(0, num(value, fallbackPct))) / 100;
}

function blur(value: unknown, fallback = 0): string {
  const px = num(value, fallback);
  return px > 0 ? `blur(${px}px)` : "none";
}

/** Latar blok: warna/rgba apa adanya dari konfigurasi (bukan input pengguna akhir). */
function background(value: unknown, fallback: string): string {
  const color = str(value);
  return color || fallback;
}

/** Hanya tautan yang aman ditampilkan; sisanya diabaikan. */
function safeHref(value: unknown): string | null {
  const href = str(value).trim();
  if (!href) return null;
  if (/^(https:\/\/|\/|#|mailto:|tel:)/i.test(href)) return href;
  return null;
}

function glassStyle(config: Record<string, unknown>, enabled: boolean): CSSProperties {
  if (!enabled) return {};
  return {
    backgroundColor: `rgba(255,255,255,${alpha(config.bgOpacity, 85)})`,
    backdropFilter: blur(config.backdropBlur, 10),
    WebkitBackdropFilter: blur(config.backdropBlur, 10),
    border: "1px solid rgba(255,255,255,0.35)",
  };
}

/* ───────────────────────────────────────────── tema tenant ── */

const CARD_RADIUS: Record<string, string> = { none: "0", sm: "4px", md: "8px", lg: "14px" };
const BUTTON_RADIUS: Record<string, string> = { rounded: "6px", pill: "999px", square: "0" };
const GLASS_BORDER: Record<string, string> = {
  subtle: "rgba(255,255,255,0.35)",
  bold: "rgba(255,255,255,0.55)",
  glow: "rgba(255,255,255,0.6)",
  none: "rgba(255,255,255,0)",
};

/** Hanya warna hex/rgba yang dipakai; nilai lain diabaikan. */
function safeColor(value: unknown): string {
  const color = str(value);
  return /^#[0-9a-f]{3,8}$/i.test(color) || /^rgba?\(/i.test(color) ? color : "";
}

/** Warna primer tenant; dipakai sebagai latar fallback blok hero. */
export function catalogPrimary(theme?: Record<string, unknown>): string {
  return safeColor(theme?.primaryColor) || "#2f2a24";
}

/**
 * Variabel CSS dari panel "Tema & Efek Visual" editor.
 *
 * Dipasang pada pembungkus katalog publik supaya kendali yang sama dengan
 * pratinjau editor (radius kartu & tombol, kaca, warna primer) juga berlaku
 * di halaman live — CSS publik membaca var ini dengan fallback defaultnya.
 */
export function catalogThemeVars(theme?: Record<string, unknown>): CSSProperties {
  if (!theme) return {};
  const vars: Record<string, string> = {
    "--pcat-card-radius": CARD_RADIUS[str(theme.cardRadius, "md")] ?? "8px",
    "--pcat-btn-radius": BUTTON_RADIUS[str(theme.buttonStyle, "rounded")] ?? "6px",
    "--pcat-primary": catalogPrimary(theme),
  };
  // Opasitas/blur/border kaca hanya relevan saat tenant menyalakan glassmorphism.
  if (isGlassTheme(theme)) {
    const border = str(theme.glassBorder, "subtle");
    const px = num(theme.backdropBlur, 12);
    vars["--pcat-card-bg"] = `rgba(255,255,255,${alpha(theme.cardOpacity, 85)})`;
    vars["--pcat-card-blur"] = px > 0 ? `blur(${px}px)` : "none";
    vars["--pcat-card-border-color"] = GLASS_BORDER[border] ?? "rgba(255,255,255,0.35)";
    vars["--pcat-card-shadow"] =
      border === "glow"
        ? "0 4px 20px rgba(0,0,0,0.08), 0 0 12px rgba(255,255,255,0.5)"
        : "0 4px 16px rgba(0,0,0,0.06)";
  }
  return vars as unknown as CSSProperties;
}

const HEIGHT: Record<string, number> = { sm: 180, md: 300, lg: 420 };
const SPACER: Record<string, number> = { xs: 8, sm: 16, md: 28, lg: 44, xl: 64 };
const MAX_WIDTH: Record<string, string> = { narrow: "48ch", normal: "68ch", wide: "84ch" };

function Ctas({
  label,
  href,
  accent,
  align,
}: {
  label: string;
  href: string | null;
  accent: string;
  align: CSSProperties["textAlign"];
}) {
  if (!label || !href) return null;
  const external = href.startsWith("http");
  return (
    <p style={{ textAlign: align, marginTop: 12 }}>
      <a
        className="btn btn-primary"
        href={href}
        style={{ backgroundColor: accent, borderColor: accent, color: "#fffdf9" }}
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
        {label}
      </a>
    </p>
  );
}

/* ───────────────────────────────────────────── blok ── */

function HeroBlock({
  config,
  accent,
  primary,
}: {
  config: Record<string, unknown>;
  accent: string;
  primary: string;
}) {
  const align = (str(config.textAlign, "center") as CSSProperties["textAlign"]) ?? "center";
  const image = safeHref(config.bgImageUrl);
  const height = HEIGHT[str(config.heightSize, "md")] ?? HEIGHT.md;
  return (
    <section
      className="pcat-hero"
      style={{
        minHeight: height,
        background: image
          ? `linear-gradient(rgba(0,0,0,${alpha(config.overlayOpacity, 55)}), rgba(0,0,0,${alpha(
              config.overlayOpacity,
              55,
            )})), url(${image}) center/cover no-repeat`
          : background(config.bgColor, primary),
        color: "#fffdf9",
        filter: blur(config.bgBlur, 0) === "none" ? undefined : blur(config.bgBlur, 0),
      }}>
      <div
        className="pcat-hero-inner"
        style={{
          textAlign: align,
          ...glassStyle(config, bool(config.glassCard, false)),
        }}>
        <h1>{str(config.heading, "Katalog sewa")}</h1>
        {str(config.subheading) ? <p>{str(config.subheading)}</p> : null}
        {bool(config.showCta, true) ? (
          <Ctas
            label={str(config.ctaLabel)}
            href={safeHref(config.ctaLink)}
            accent={accent}
            align={align}
          />
        ) : null}
      </div>
    </section>
  );
}

function PromoBlock({ config, accent }: { config: Record<string, unknown>; accent: string }) {
  const align = (str(config.textAlign, "center") as CSSProperties["textAlign"]) ?? "center";
  return (
    <section
      className="pcat-promo"
      style={{
        background: background(config.bgColor, accent),
        color: background(config.textColor, "#fffdf9"),
        textAlign: align,
        ...glassStyle(config, bool(config.glassEffect, false)),
      }}>
      <p className="pcat-promo-title">
        {str(config.emoji) ? <span aria-hidden="true">{str(config.emoji)} </span> : null}
        {str(config.title)}
      </p>
      {str(config.body) ? <p className="pcat-promo-body">{str(config.body)}</p> : null}
      {bool(config.showCta, false) ? (
        <Ctas
          label={str(config.ctaLabel)}
          href={safeHref(config.ctaLink)}
          accent={accent}
          align={align}
        />
      ) : null}
    </section>
  );
}

function RichTextBlock({ config }: { config: Record<string, unknown> }) {
  return (
    <section
      className="pcat-text"
      style={{
        background: background(config.bgColor, "transparent"),
        color: str(config.textColor) || undefined,
        textAlign: (str(config.textAlign, "left") as CSSProperties["textAlign"]) ?? "left",
        maxWidth: MAX_WIDTH[str(config.maxWidth, "normal")] ?? MAX_WIDTH.normal,
        ...glassStyle(config, bool(config.glassCard, false)),
      }}>
      <p>{str(config.content)}</p>
    </section>
  );
}

function FaqBlock({ config }: { config: Record<string, unknown> }) {
  const items = rows(config.items);
  if (items.length === 0) return null;
  const accordion = str(config.style, "accordion") === "accordion";
  return (
    <section
      className="pcat-faq"
      style={{
        background: background(config.bgColor, "transparent"),
        ...glassStyle(config, bool(config.glassEffect, false)),
      }}>
      <h2 className="pcat-title">Pertanyaan yang sering diajukan</h2>
      {items.map((item, index) =>
        accordion ? (
          <details key={index} className="pcat-faq-item">
            <summary>{str(item.q)}</summary>
            <p>{str(item.a)}</p>
          </details>
        ) : (
          <div key={index} className="pcat-faq-item pcat-faq-item--flat">
            <p className="pcat-faq-q">{str(item.q)}</p>
            <p>{str(item.a)}</p>
          </div>
        ),
      )}
    </section>
  );
}

function TestimonialsBlock({ config }: { config: Record<string, unknown> }) {
  const items = rows(config.items);
  if (items.length === 0) return null;
  const grid = str(config.layout, "grid") === "grid";
  const showStars = bool(config.showStars, true);
  return (
    <section
      className="pcat-testimonials"
      style={{ background: background(config.bgColor, "transparent") }}>
      <h2 className="pcat-title">Kata pelanggan kami</h2>
      <div className={`pcat-cards ${grid ? "pcat-cards--grid" : ""}`}>
        {items.map((item, index) => (
          <blockquote
            key={index}
            className="pcat-card"
            style={{
              ...glassStyle(config, bool(config.glassCards, false)),
              backgroundColor: bool(config.glassCards, false)
                ? `rgba(255,255,255,${alpha(config.cardOpacity, 85)})`
                : undefined,
            }}>
            {showStars ? (
              <span className="pcat-stars" aria-label={`${num(item.rating, 5)} dari 5`}>
                {"★".repeat(Math.max(0, Math.min(5, Math.round(num(item.rating, 5)))))}
              </span>
            ) : null}
            <p>&ldquo;{str(item.quote)}&rdquo;</p>
            <cite>{str(item.name)}</cite>
          </blockquote>
        ))}
      </div>
    </section>
  );
}

function StatsBlock({ config }: { config: Record<string, unknown> }) {
  const stats = rows(config.stats);
  if (stats.length === 0) return null;
  const grid = str(config.layout, "row") === "grid";
  return (
    <section
      className="pcat-stats"
      style={{
        background: background(config.bgColor, "transparent"),
        color: str(config.textColor) || undefined,
        ...glassStyle(config, bool(config.glassEffect, false)),
      }}>
      <div className={`pcat-cards ${grid ? "pcat-cards--grid" : "pcat-cards--even"}`}>
        {stats.map((stat, index) => (
          <div key={index} className="pcat-stat">
            <span className="pcat-stat-value">
              {str(stat.emoji) ? <span aria-hidden="true">{str(stat.emoji)} </span> : null}
              {str(stat.value)}
            </span>
            <span className="pcat-stat-label">{str(stat.label)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ImageBannerBlock({ config }: { config: Record<string, unknown> }) {
  const image = safeHref(config.imageUrl);
  if (!image) return null;
  const height = HEIGHT[str(config.height, "md")] ?? HEIGHT.md;
  const link = safeHref(config.linkUrl);
  const overlayText = str(config.overlayText);
  const media = (
    <div
      className="pcat-image-banner"
      style={{
        minHeight: height,
        background: `url(${image}) center/${str(config.objectFit, "cover")} no-repeat`,
        filter: blur(config.blurAmount, 0) === "none" ? undefined : blur(config.blurAmount, 0),
      }}>
      {overlayText ? (
        <span
          className="pcat-image-caption"
          style={{
            background: background(config.overlayColor, "rgba(0,0,0,0.35)"),
            backdropFilter: blur(config.overlayBlur, 0),
          }}>
          {overlayText}
        </span>
      ) : null}
    </div>
  );
  return link ? (
    <a className="pcat-image-link" href={link}>
      {media}
    </a>
  ) : (
    media
  );
}

function VideoBlock({ config }: { config: Record<string, unknown> }) {
  const url = safeHref(config.embedUrl);
  if (!url || !url.startsWith("https://")) return null;
  return (
    <section className="pcat-video" style={{ background: background(config.bgColor, "transparent") }}>
      {str(config.title) ? <h2 className="pcat-title">{str(config.title)}</h2> : null}
      <div className="pcat-video-frame" data-ratio={str(config.aspectRatio, "16/9")}>
        <iframe
          src={url}
          title={str(config.title, "Video profil toko")}
          loading="lazy"
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
    </section>
  );
}

function SocialBlock({ config, tenantName }: { config: Record<string, unknown>; tenantName: string }) {
  const networks: Array<[string, string]> = [
    ["Instagram", str(config.instagram)],
    ["Facebook", str(config.facebook)],
    ["TikTok", str(config.tiktok)],
    ["Twitter", str(config.twitter)],
    ["YouTube", str(config.youtube)],
  ];
  const links = networks
    .map(([label, value]) => [label, safeHref(value)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  if (links.length === 0) return null;
  const buttons = str(config.style, "buttons") === "buttons";
  return (
    <section
      className="pcat-social"
      style={{
        background: background(config.bgColor, "transparent"),
        color: str(config.textColor) || undefined,
      }}>
      <h2 className="pcat-title">{str(config.label, `Media sosial ${tenantName}`)}</h2>
      <ul className="pcat-social-list">
        {links.map(([label, href]) => (
          <li key={label}>
            <a
              className={buttons ? "btn btn-secondary btn-sm" : "pcat-social-link"}
              href={href}
              target="_blank"
              rel="noreferrer noopener">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ContactBlock({
  config,
  accent,
  whatsappNumber,
}: {
  config: Record<string, unknown>;
  accent: string;
  whatsappNumber: string | null;
}) {
  const waHref = whatsappNumber
    ? `https://wa.me/${whatsappNumber.replace(/[^0-9]/g, "")}`
    : null;
  const label = str(config.label, "Butuh bantuan? Hubungi kami langsung!");
  const cta = str(config.ctaLabel, "Tanya via WhatsApp");
  return (
    <section
      className="pcat-contact"
      style={{
        background: background(config.bgColor, accent),
        color: str(config.textColor, "#fffdf9"),
        ...glassStyle(config, bool(config.glassEffect, false)),
      }}>
      <p>{label}</p>
      {waHref ? (
        <a className="btn btn-secondary btn-sm" href={waHref} target="_blank" rel="noreferrer noopener">
          {cta}
        </a>
      ) : null}
    </section>
  );
}

function StepsBlock({ config }: { config: Record<string, unknown> }) {
  const steps = rows(config.steps);
  const fallback: Array<{ title: string; description: string }> = [
    { title: "Pilih barang & tanggal", description: "Tentukan unit dan periode sewa yang kamu butuhkan." },
    { title: "Cek ketersediaan", description: "Sistem memeriksa unit yang benar-benar bebas pada periode itu." },
    { title: "Ajukan booking", description: "Isi kontak, setujui syarat sewa, lalu kirim pengajuan." },
    { title: "Simpan link pesanan", description: "Pantau status dan instruksi pembayaran lewat link tersebut." },
  ];
  const items = steps.length > 0 ? steps.map((step) => ({ title: str(step.title), description: str(step.description) })) : fallback;
  return (
    <section className="pcat-steps" style={{ background: background(config.bgColor, "transparent") }}>
      <h2 className="pcat-title">{str(config.heading, "Cara booking sewa")}</h2>
      <ol className="ordered-list">
        {items.map((item, index) => (
          <li key={index}>
            <strong>{item.title}</strong>
            {item.description ? <> — {item.description}</> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ───────────────────────────────────────────── daftar blok ── */

/** Blok yang dikenali renderer; tipe lain diabaikan (server tetap allowlist-nya). */
const KNOWN_BLOCKS = new Set([
  "hero",
  "categories",
  "featured",
  "promo_banner",
  "testimonials",
  "faq",
  "how_to_book",
  "contact_strip",
  "stats_bar",
  "image_banner",
  "rich_text",
  "video_embed",
  "social_links",
  "spacer",
]);

export function catalogBlockList(config: PublicCatalogConfig["config"] | undefined): CatalogBlock[] {
  const raw = config?.blocks;
  if (!Array.isArray(raw)) return [];
  const blocks: CatalogBlock[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const row = item as { id?: unknown; type?: unknown; enabled?: unknown; config?: unknown };
    if (typeof row.type !== "string" || row.enabled === false) return;
    if (!KNOWN_BLOCKS.has(row.type)) return;
    blocks.push({
      id: typeof row.id === "string" && row.id ? row.id : `${row.type}-${index + 1}`,
      type: row.type,
      enabled: true,
      config: record(row.config),
    });
  });
  return blocks;
}

/** Gaya halaman dari tema tenant: latar, tipografi, dan warna aksen. */
export function catalogThemeStyle(theme: Record<string, unknown> | undefined): CSSProperties {
  if (!theme) return {};
  const style = catalogThemeVars(theme);
  const pageBg = str(theme.pageBgColor);
  if (pageBg) style.background = pageBg;
  const font = str(theme.fontFamily);
  if (font) style.fontFamily = `"${font}", var(--sw-font-sans)`;
  return style;
}

export function catalogAccent(theme: Record<string, unknown> | undefined): string {
  const accent = str(theme?.accentColor);
  return /^#[0-9a-f]{3,6}$/i.test(accent) || /^rgba?\(/i.test(accent) ? accent : "#a85f3c";
}

export function isGlassTheme(theme: Record<string, unknown> | undefined): boolean {
  if (!theme) return false;
  const enabled = theme.glassmorphism;
  return enabled === true || enabled === "true";
}

export function PublicCatalogBlocks({
  blocks,
  tenantName,
  theme,
  whatsappNumber = null,
  renderCategories,
  renderProducts,
}: CatalogBlockListProps) {
  const accent = catalogAccent(theme);
  const primary = catalogPrimary(theme);
  // Katalog dan booking adalah fungsi inti: produk tetap tampil walau tenant
  // menonaktifkan blok "Produk Unggulan".
  const hasProductsBlock = blocks.some((block) => block.type === "featured");

  return (
    <div className="pcat-blocks" style={catalogThemeVars(theme)}>
      {blocks.map((block) => {
        const config = block.config;
        switch (block.type) {
          case "hero":
            return <HeroBlock key={block.id} config={config} accent={accent} primary={primary} />;
          case "promo_banner":
            return <PromoBlock key={block.id} config={config} accent={accent} />;
          case "rich_text":
            return <RichTextBlock key={block.id} config={config} />;
          case "faq":
            return <FaqBlock key={block.id} config={config} />;
          case "testimonials":
            return <TestimonialsBlock key={block.id} config={config} />;
          case "stats_bar":
            return <StatsBlock key={block.id} config={config} />;
          case "image_banner":
            return <ImageBannerBlock key={block.id} config={config} />;
          case "video_embed":
            return <VideoBlock key={block.id} config={config} />;
          case "social_links":
            return <SocialBlock key={block.id} config={config} tenantName={tenantName} />;
          case "contact_strip":
            return (
              <ContactBlock
                key={block.id}
                config={config}
                accent={accent}
                whatsappNumber={whatsappNumber}
              />
            );
          case "how_to_book":
            return <StepsBlock key={block.id} config={config} />;
          case "spacer":
            return (
              <div
                key={block.id}
                aria-hidden="true"
                style={{ height: SPACER[str(config.height, "md")] ?? SPACER.md }}
              />
            );
          case "categories":
            return <div key={block.id}>{renderCategories?.(config)}</div>;
          case "featured":
            return <div key={block.id}>{renderProducts?.(config)}</div>;
          default:
            return null;
        }
      })}
      {!hasProductsBlock ? <div>{renderProducts?.({})}</div> : null}
    </div>
  );
}


"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  catalogConfigApi,
  type CatalogConfigBlockDefinition,
  type CatalogConfigRequest,
  type CatalogConfigTemplate,
} from "@/shared/api/endpoints";
import { describeApiError, isApiRequestError } from "@/shared/api/errors";
import { useSession } from "@/shared/auth/session";
import { Button } from "@/shared/ui/buttons";
import { TextInput } from "@/shared/ui/form";
import { Icon } from "@/shared/ui/icons";
import { Dialog } from "@/shared/ui/overlays";
import { InlineAlert } from "@/shared/ui/states";
import { Badge, PageHeader } from "@/shared/ui/surfaces";

/* ════════════════════════════════════════════════════════════════ TYPES ═══ */

export type BlockType =
  | "hero"
  | "categories"
  | "featured"
  | "promo_banner"
  | "testimonials"
  | "faq"
  | "how_to_book"
  | "contact_strip"
  | "stats_bar"
  | "image_banner"
  | "rich_text"
  | "video_embed"
  | "social_links"
  | "spacer";

export interface CatalogTheme {
  primaryColor: string;
  accentColor: string;
  pageBgColor: string;
  fontFamily: string;
  buttonStyle: "rounded" | "pill" | "square";
  cardRadius: "none" | "sm" | "md" | "lg";
  glassmorphism: boolean;
  cardOpacity: number;
  backdropBlur: number;
  glassBorder: "subtle" | "bold" | "glow" | "none";
}

export interface HeroConfig {
  heading: string;
  subheading: string;
  ctaLabel: string;
  ctaLink: string;
  bgColor: string;
  bgImageUrl: string;
  overlayOpacity: number;
  textAlign: "left" | "center" | "right";
  heightSize: "sm" | "md" | "lg";
  showCta: boolean;
  bgBlur?: number;
  bgOpacity?: number;
  glassCard?: boolean;
  cardBlur?: number;
  cardOpacity?: number;
}

export interface CategoriesConfig {
  style: "chips" | "grid" | "list";
  showCount: boolean;
  bgColor: string;
}

export interface FeaturedConfig {
  columns: 2 | 3 | 4;
  cardStyle: "minimal" | "bordered" | "shadow" | "glass" | "translucent";
  showPrice: boolean;
  showCategory: boolean;
  limit: number;
  bgColor: string;
  cardOpacity?: number;
  cardBlur?: number;
}

export interface PromoBannerConfig {
  title: string;
  body: string;
  emoji: string;
  ctaLabel: string;
  bgColor: string;
  textColor: string;
  textAlign: "left" | "center";
  showCta: boolean;
  bgOpacity?: number;
  backdropBlur?: number;
  glassEffect?: boolean;
}

export interface TestimonialsConfig {
  items: Array<{ name: string; quote: string; rating: number }>;
  showStars: boolean;
  layout: "stack" | "grid";
  bgColor: string;
  glassCards?: boolean;
  cardOpacity?: number;
  cardBlur?: number;
}

export interface FaqConfig {
  items: Array<{ q: string; a: string }>;
  style: "accordion" | "flat";
  bgColor: string;
  glassEffect?: boolean;
  bgOpacity?: number;
  backdropBlur?: number;
}

export interface StatsBarConfig {
  stats: Array<{ value: string; label: string; emoji: string }>;
  bgColor: string;
  textColor: string;
  layout: "row" | "grid";
  glassEffect?: boolean;
  bgOpacity?: number;
  backdropBlur?: number;
}

export interface ImageBannerConfig {
  imageUrl: string;
  altText: string;
  linkUrl: string;
  height: "sm" | "md" | "lg";
  objectFit: "cover" | "contain";
  overlayText: string;
  overlayColor: string;
  blurAmount?: number;
  overlayOpacity?: number;
  overlayBlur?: number;
}

export interface RichTextConfig {
  content: string;
  bgColor: string;
  textColor: string;
  textAlign: "left" | "center" | "right";
  maxWidth: "narrow" | "normal" | "wide";
  glassCard?: boolean;
  bgOpacity?: number;
  backdropBlur?: number;
}

export interface VideoEmbedConfig {
  embedUrl: string;
  title: string;
  aspectRatio: "16/9" | "4/3" | "1/1";
  bgColor: string;
}

export interface SocialLinksConfig {
  instagram: string;
  facebook: string;
  tiktok: string;
  twitter: string;
  youtube: string;
  bgColor: string;
  textColor: string;
  style: "icons" | "buttons";
  label: string;
}

export interface ContactStripConfig {
  label: string;
  ctaLabel: string;
  bgColor: string;
  textColor: string;
  glassEffect?: boolean;
  bgOpacity?: number;
  backdropBlur?: number;
}

export interface SpacerConfig {
  height: "xs" | "sm" | "md" | "lg" | "xl";
  bgColor: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface BlockDef { id: string; type: BlockType; enabled: boolean; config: any; }

/* ═══════════════════════════════════════════════════════════ BLOCK META ══ */

export type BlockCategory = "main" | "promo" | "social" | "media";

const BLOCK_META: Record<BlockType, { label: string; description: string; emoji: string; category: BlockCategory }> = {
  hero:          { label: "Hero / Banner Utama", description: "Judul besar, subjudul, gambar latar & tombol CTA", emoji: "🖼️", category: "main" },
  categories:    { label: "Kategori Produk", description: "Grid atau chip kategori untuk filter produk", emoji: "🏷️", category: "main" },
  featured:      { label: "Produk Unggulan", description: "Daftar produk pilihan dengan kontrol kolom & gaya kartu", emoji: "📦", category: "main" },
  promo_banner:  { label: "Banner Promosi", description: "Strip promo berwarna dengan emoji, teks & tombol CTA", emoji: "🎉", category: "promo" },
  testimonials:  { label: "Testimoni Pelanggan", description: "Kutipan pelanggan, rating bintang, layout stack/grid", emoji: "💬", category: "social" },
  faq:           { label: "FAQ / Tanya Jawab", description: "Pertanyaan & jawaban umum, gaya accordion/flat", emoji: "❓", category: "social" },
  how_to_book:   { label: "Cara Booking", description: "Langkah-langkah panduan cara memesan barang", emoji: "📋", category: "social" },
  contact_strip: { label: "Strip Kontak / WhatsApp", description: "Tombol kontak & WhatsApp, warna & label kustom", emoji: "📞", category: "media" },
  stats_bar:     { label: "Statistik Toko", description: "3–4 angka kunci: pelanggan, produk sewa, rating", emoji: "📊", category: "social" },
  image_banner:  { label: "Banner Gambar Besar", description: "Gambar full-width dengan link & teks overlay", emoji: "🖼", category: "promo" },
  rich_text:     { label: "Teks Kustom / Cerita", description: "Blok teks bebas: pengantar, cerita brand, info penting", emoji: "📝", category: "promo" },
  video_embed:   { label: "Embed Video Toko", description: "Tempelkan video YouTube atau Vimeo profil toko", emoji: "▶️", category: "media" },
  social_links:  { label: "Tautan Sosial Media", description: "Ikon / tombol Instagram, TikTok, Facebook, dll", emoji: "🔗", category: "media" },
  spacer:        { label: "Spasi Pemisah", description: "Pemisah vertikal antar blok komponen", emoji: "↕️", category: "main" },
};

/* ══════════════════════════════════════════════════════ DEFAULT THEME ══ */

const DEFAULT_THEME: CatalogTheme = {
  primaryColor: "#2f2a24",
  accentColor: "#a85f3c",
  pageBgColor: "#f1ede4",
  fontFamily: "Inter Variable",
  buttonStyle: "rounded",
  cardRadius: "md",
  glassmorphism: false,
  cardOpacity: 85,
  backdropBlur: 12,
  glassBorder: "subtle",
};

/* ══════════════════════════════════════════════════════ DEFAULT BLOCKS ══ */

const DEFAULT_BLOCKS: BlockDef[] = [
  {
    id: "hero", type: "hero", enabled: true,
    config: {
      heading: "Sewa barang pilihan, mudah & cepat",
      subheading: "Cek ketersediaan dan booking online langsung dari sini.",
      ctaLabel: "Lihat Produk", ctaLink: "#produk",
      bgColor: "#2f2a24", bgImageUrl: "", overlayOpacity: 60,
      textAlign: "center", heightSize: "md", showCta: true,
    } as HeroConfig,
  },
  {
    id: "stats_bar", type: "stats_bar", enabled: false,
    config: {
      stats: [
        { value: "500+", label: "Pelanggan puas", emoji: "🤝" },
        { value: "100+", label: "Produk sewa", emoji: "📦" },
        { value: "4.9 ★", label: "Rating rata-rata", emoji: "⭐" },
        { value: "3 thn", label: "Pengalaman", emoji: "🏆" },
      ],
      bgColor: "#fcfaf4", textColor: "#2f2a24", layout: "row",
    } as StatsBarConfig,
  },
  {
    id: "categories", type: "categories", enabled: true,
    config: { style: "chips", showCount: false, bgColor: "" } as CategoriesConfig,
  },
  {
    id: "featured", type: "featured", enabled: true,
    config: {
      columns: 3, cardStyle: "bordered", showPrice: true,
      showCategory: true, limit: 6, bgColor: "",
    } as FeaturedConfig,
  },
  {
    id: "image_banner", type: "image_banner", enabled: false,
    config: {
      imageUrl: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=1200&q=80",
      altText: "Koleksi kamera kami", linkUrl: "",
      height: "md", objectFit: "cover",
      overlayText: "", overlayColor: "rgba(0,0,0,0.3)",
    } as ImageBannerConfig,
  },
  {
    id: "promo_banner", type: "promo_banner", enabled: false,
    config: {
      title: "Promo Spesial Akhir Tahun!", emoji: "🎉",
      body: "Diskon 10% untuk semua sewa di hari kerja. Hubungi kami sekarang!",
      ctaLabel: "Hubungi Kami",
      bgColor: "#a85f3c", textColor: "#fffdf9",
      textAlign: "center", showCta: false,
    } as PromoBannerConfig,
  },
  {
    id: "rich_text", type: "rich_text", enabled: false,
    config: {
      content: "Kami adalah toko sewa terpercaya dengan pengalaman melayani pelanggan lebih dari 3 tahun. Semua produk kami terawat dengan baik dan siap pakai.",
      bgColor: "#fcfaf4", textColor: "#2f2a24",
      textAlign: "center", maxWidth: "normal",
    } as RichTextConfig,
  },
  {
    id: "testimonials", type: "testimonials", enabled: false,
    config: {
      items: [
        { name: "Budi S.", quote: "Prosesnya gampang banget, barangnya juga terawat!", rating: 5 },
        { name: "Rina A.", quote: "Booking cepat, staf ramah, pasti balik lagi.", rating: 5 },
        { name: "Deni P.", quote: "Harga terjangkau, kualitas terjaga. Recommended!", rating: 4 },
      ],
      showStars: true, layout: "grid", bgColor: "",
    } as TestimonialsConfig,
  },
  {
    id: "faq", type: "faq", enabled: false,
    config: {
      items: [
        { q: "Bagaimana cara booking?", a: "Pilih produk, tentukan tanggal, isi data kontak, lalu klik Ajukan Booking." },
        { q: "Apakah bisa bayar di tempat?", a: "Ya, metode pembayaran akan dikonfirmasi oleh admin toko setelah booking disetujui." },
        { q: "Berapa minimal durasi sewa?", a: "Minimal 1 hari. Tarif harian berlaku untuk durasi kurang dari 7 hari." },
      ],
      style: "accordion", bgColor: "",
    } as FaqConfig,
  },
  {
    id: "video_embed", type: "video_embed", enabled: false,
    config: {
      embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
      title: "Tonton video profil toko kami",
      aspectRatio: "16/9", bgColor: "",
    } as VideoEmbedConfig,
  },
  {
    id: "how_to_book", type: "how_to_book", enabled: true,
    config: {},
  },
  {
    id: "social_links", type: "social_links", enabled: false,
    config: {
      instagram: "https://instagram.com/", facebook: "",
      tiktok: "", twitter: "", youtube: "",
      bgColor: "#fcfaf4", textColor: "#2f2a24",
      style: "buttons", label: "Ikuti kami di media sosial",
    } as SocialLinksConfig,
  },
  {
    id: "contact_strip", type: "contact_strip", enabled: true,
    config: {
      label: "Butuh bantuan? Hubungi kami langsung!",
      ctaLabel: "Tanya via WhatsApp",
      bgColor: "#f6e7db", textColor: "#2f2a24",
    } as ContactStripConfig,
  },
  {
    id: "spacer", type: "spacer", enabled: false,
    config: { height: "md", bgColor: "" } as SpacerConfig,
  },
];

/* ══════════════════════════════════════════════════════ DRAG SORT HOOK ══ */

/* ══════════════════════════════════════════ SERVER SYNC (WEB-07) ══ */

/** Pelanggaran validasi dari server: `path` menunjuk blok/properti terkait. */
interface CatalogConfigIssue {
  path: string;
  message: string;
}

/**
 * Konfigurasi tersimpan hanya memuat properti yang benar-benar terisi (nilai
 * kosong dibuang server). Default per tipe blok digabung kembali agar panel
 * editor tidak pernah menerima nilai undefined.
 */
function hydrateBlocks(raw: unknown): BlockDef[] {
  if (!Array.isArray(raw)) return DEFAULT_BLOCKS;
  const hydrated: BlockDef[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const row = item as { id?: unknown; type?: unknown; enabled?: unknown; config?: unknown };
    const type = typeof row.type === "string" ? row.type : "";
    const meta = BLOCK_META[type as BlockType];
    if (!meta) return;
    const fallback = DEFAULT_BLOCKS.find((block) => block.type === type)?.config ?? {};
    hydrated.push({
      id: typeof row.id === "string" && row.id ? row.id : `${type}-${index + 1}`,
      type: type as BlockType,
      enabled: row.enabled !== false,
      config: { ...fallback, ...((row.config as Record<string, unknown> | undefined) ?? {}) },
    });
  });
  return hydrated.length > 0 ? hydrated : DEFAULT_BLOCKS;
}

function hydrateTheme(raw: unknown): CatalogTheme {
  if (!raw || typeof raw !== "object") return DEFAULT_THEME;
  return { ...DEFAULT_THEME, ...(raw as Partial<CatalogTheme>) };
}

function issuesFrom(error: unknown): CatalogConfigIssue[] {
  if (!isApiRequestError(error)) return [];
  const details = error.details as { issues?: unknown } | null;
  if (!details || !Array.isArray(details.issues)) return [];
  return details.issues
    .filter((issue): issue is CatalogConfigIssue => {
      const row = issue as { path?: unknown; message?: unknown };
      return typeof row.path === "string" && typeof row.message === "string";
    })
    .map((issue) => ({ path: issue.path, message: issue.message }));
}

function useDragSort(blocks: BlockDef[], setBlocks: (b: BlockDef[]) => void) {
  const dragIdx = useRef<number | null>(null);
  const dragOverIdx = useRef<number | null>(null);

  const onDragStart = useCallback((idx: number) => { dragIdx.current = idx; }, []);
  const onDragEnter = useCallback((idx: number) => { dragOverIdx.current = idx; }, []);
  const onDragEnd = useCallback(() => {
    const from = dragIdx.current, to = dragOverIdx.current;
    if (from === null || to === null || from === to) { dragIdx.current = null; dragOverIdx.current = null; return; }
    const next = [...blocks];
    const removed = next.splice(from, 1);
    if (removed.length > 0 && removed[0] !== undefined) next.splice(to, 0, removed[0]);
    setBlocks(next);
    dragIdx.current = null; dragOverIdx.current = null;
  }, [blocks, setBlocks]);

  return { onDragStart, onDragEnter, onDragEnd };
}

/* ══════════════════════════════════════════════════════ HELPERS ══ */

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <div className="ce-color-row">
        <input type="color" className="ce-color-picker" value={value || "#ffffff"} onChange={(e) => onChange(e.target.value)} />
        <span className="ce-color-value">{value || "(default)"}</span>
        {value && <button type="button" className="ce-color-clear" onClick={() => onChange("")} title="Reset ke default">✕</button>}
      </div>
    </label>
  );
}

function SelectField({ label, value, onChange, options }: {
  label: string; value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
    </label>
  );
}

function ToggleField({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="ce-toggle-field">
      <div className="ce-toggle-field-text">
        <span className="ce-block-label">{label}</span>
        {hint && <span className="ce-block-desc">{hint}</span>}
      </div>
      <button
        type="button"
        className={`ce-toggle ${value ? "ce-toggle--on" : ""}`}
        aria-pressed={value}
        onClick={() => onChange(!value)}
      >
        <span className="ce-toggle-thumb" />
      </button>
    </div>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  if (!hex) return `rgba(255,255,255,${alpha})`;
  if (hex.startsWith("rgba") || hex.startsWith("hsla")) return hex;
  let clean = hex.replace("#", "");
  if (clean.length === 3) {
    clean = clean.split("").map((c) => c + c).join("");
  }
  if (clean.length === 6) {
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
  }
  return hex;
}

function RangeField({ label, value, min, max, step = 1, unit = "", onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span className="label">{label} — <strong>{value}{unit}</strong></span>
      <input type="range" className="ce-range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function VisualEffectSection({ title = "Efek Visual (Blur & Transparansi)", children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="ce-fx-section">
      <div className="ce-fx-header">
        <span className="ce-fx-icon" aria-hidden="true">✨</span>
        <span className="ce-fx-title">{title}</span>
      </div>
      <div className="ce-fx-body">
        {children}
      </div>
    </div>
  );
}

function Stars({ count }: { count: number }) {
  return (
    <span className="ce-stars">
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} style={{ opacity: n <= count ? 1 : 0.3 }}>★</span>
      ))}
    </span>
  );
}

/* ════════════════════════════════════════════════════ PREVIEW RENDERERS ══ */

function BlockPreview({ block, theme }: { block: BlockDef; theme: CatalogTheme }) {
  const br = theme.cardRadius === "none" ? "0" : theme.cardRadius === "sm" ? "4px" : theme.cardRadius === "lg" ? "14px" : "8px";
  const btnBr = theme.buttonStyle === "pill" ? "999px" : theme.buttonStyle === "square" ? "0" : "6px";
  const globalGlass = theme.glassmorphism;
  const globalBlur = theme.backdropBlur ?? 12;
  const globalCardOpacity = (theme.cardOpacity ?? 85) / 100;

  switch (block.type) {
    case "hero": {
      const cfg = block.config as HeroConfig;
      const heights: Record<string, string> = { sm: "90px", md: "140px", lg: "190px" };
      const h = heights[cfg.heightSize] ?? "140px";
      const hasImage = !!cfg.bgImageUrl;
      const bgBlur = cfg.bgBlur ?? 0;
      const bgOpacity = (cfg.bgOpacity ?? 100) / 100;
      const overlayOp = (cfg.overlayOpacity ?? 60) / 100;
      const isGlassCard = cfg.glassCard || globalGlass;

      return (
        <div className="ce-preview-hero" style={{
          position: "relative",
          overflow: "hidden",
          minHeight: h,
          textAlign: cfg.textAlign,
          backgroundColor: !hasImage ? hexToRgba(cfg.bgColor || theme.primaryColor, bgOpacity) : undefined,
        }}>
          {hasImage && (
            <div style={{
              position: "absolute",
              inset: bgBlur > 0 ? "-12px" : 0,
              backgroundImage: `url(${cfg.bgImageUrl})`,
              backgroundPosition: "center",
              backgroundSize: "cover",
              filter: bgBlur > 0 ? `blur(${bgBlur}px)` : undefined,
              transform: bgBlur > 0 ? "scale(1.08)" : undefined,
            }} />
          )}
          {hasImage && (
            <div style={{
              position: "absolute",
              inset: 0,
              background: `rgba(0,0,0,${overlayOp})`,
            }} />
          )}

          {isGlassCard ? (
            <div className="ce-preview-hero-glass-card" style={{
              borderRadius: br,
              backdropFilter: `blur(${cfg.cardBlur ?? globalBlur}px)`,
              WebkitBackdropFilter: `blur(${cfg.cardBlur ?? globalBlur}px)`,
              background: `rgba(255,255,255,${(cfg.cardOpacity ?? 20) / 100})`,
              border: "1px solid rgba(255,255,255,0.3)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
            }}>
              <span className="ce-preview-hero-heading" style={{ fontFamily: theme.fontFamily }}>{cfg.heading || "Judul toko"}</span>
              <span className="ce-preview-hero-sub">{cfg.subheading || "Subjudul"}</span>
              {cfg.showCta !== false && (
                <span className="ce-preview-hero-cta" style={{
                  borderRadius: btnBr,
                  background: theme.accentColor,
                  color: "#fffdf9",
                }}>{cfg.ctaLabel || "Lihat Produk"}</span>
              )}
            </div>
          ) : (
            <div style={{ position: "relative", zIndex: 1 }}>
              <span className="ce-preview-hero-heading" style={{ fontFamily: theme.fontFamily }}>{cfg.heading || "Judul toko"}</span>
              <span className="ce-preview-hero-sub">{cfg.subheading || "Subjudul"}</span>
              {cfg.showCta !== false && (
                <span className="ce-preview-hero-cta" style={{
                  borderRadius: btnBr,
                  background: theme.accentColor,
                  color: "#fffdf9",
                }}>{cfg.ctaLabel || "Lihat Produk"}</span>
              )}
            </div>
          )}
        </div>
      );
    }

    case "stats_bar": {
      const cfg = block.config as StatsBarConfig;
      const isGlass = cfg.glassEffect || globalGlass;
      const bgOpacity = (cfg.bgOpacity ?? 85) / 100;
      const blur = cfg.backdropBlur ?? globalBlur;

      return (
        <div className="ce-preview-stats" style={{
          background: isGlass
            ? hexToRgba(cfg.bgColor || "#ffffff", bgOpacity)
            : cfg.bgColor || "#fcfaf4",
          color: cfg.textColor || "#2f2a24",
          flexDirection: "row",
          backdropFilter: isGlass ? `blur(${blur}px)` : undefined,
          WebkitBackdropFilter: isGlass ? `blur(${blur}px)` : undefined,
          border: isGlass ? "1px solid rgba(255,255,255,0.3)" : undefined,
        }}>
          {(cfg.stats ?? []).map((s, i) => (
            <div key={i} className="ce-preview-stat" style={{
              background: isGlass ? "rgba(255,255,255,0.2)" : undefined,
              borderRadius: isGlass ? br : undefined,
              padding: isGlass ? "6px 8px" : undefined,
              backdropFilter: isGlass ? "blur(4px)" : undefined,
            }}>
              <span className="ce-preview-stat-emoji">{s.emoji}</span>
              <span className="ce-preview-stat-value">{s.value}</span>
              <span className="ce-preview-stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      );
    }

    case "categories": {
      const cfg = block.config as CategoriesConfig;
      const cats = ["Kamera", "Lensa", "Tripod", "Tas"];
      const isGlass = globalGlass;
      const glassBg = `rgba(255,255,255,${globalCardOpacity})`;
      const glassBlur = `blur(${globalBlur}px)`;

      return (
        <div className="ce-preview-categories" style={{ background: cfg.bgColor || undefined }}>
          {cfg.style === "chips" && cats.map((cat) => (
            <span key={cat} className="ce-preview-cat-chip" style={{
              borderRadius: br,
              background: isGlass ? glassBg : undefined,
              backdropFilter: isGlass ? glassBlur : undefined,
              WebkitBackdropFilter: isGlass ? glassBlur : undefined,
              border: isGlass ? "1px solid rgba(255,255,255,0.35)" : undefined,
            }}>{cat}</span>
          ))}
          {cfg.style === "grid" && cats.map((cat) => (
            <span key={cat} className="ce-preview-cat-grid" style={{
              borderRadius: br,
              background: isGlass ? glassBg : undefined,
              backdropFilter: isGlass ? glassBlur : undefined,
              WebkitBackdropFilter: isGlass ? glassBlur : undefined,
              border: isGlass ? "1px solid rgba(255,255,255,0.35)" : undefined,
            }}>{cat}</span>
          ))}
          {cfg.style === "list" && cats.map((cat) => (
            <span key={cat} className="ce-preview-cat-list">{cat}</span>
          ))}
          <span className="ce-preview-cat-chip ce-preview-cat-more" style={{ borderRadius: br }}>+ lainnya</span>
        </div>
      );
    }

    case "featured": {
      const cfg = block.config as FeaturedConfig;
      const cols = cfg.columns ?? 3;
      const isGlass = cfg.cardStyle === "glass" || (globalGlass && cfg.cardStyle !== "minimal" && cfg.cardStyle !== "translucent");
      const isTranslucent = cfg.cardStyle === "translucent";
      const cardBlur = cfg.cardBlur ?? globalBlur;
      const cardOpacity = (cfg.cardOpacity ?? (globalCardOpacity * 100)) / 100;

      const cardStyles = {
        minimal: { border: "1px solid transparent", bg: undefined as string | undefined, shadow: undefined as string | undefined },
        bordered: { border: "1px solid #e3dcce", bg: undefined as string | undefined, shadow: undefined as string | undefined },
        shadow: { border: "1px solid transparent", bg: undefined as string | undefined, shadow: "0 2px 8px rgba(0,0,0,0.1)" },
        glass: {
          border: theme.glassBorder === "glow" ? "1px solid rgba(255,255,255,0.6)" : "1px solid rgba(255,255,255,0.35)",
          bg: `rgba(255,255,255,${cardOpacity})`,
          shadow: theme.glassBorder === "glow" ? "0 4px 20px rgba(0,0,0,0.08), 0 0 12px rgba(255,255,255,0.5)" : "0 4px 16px rgba(0,0,0,0.06)",
        },
        translucent: {
          border: "1px solid rgba(255,255,255,0.25)",
          bg: "rgba(255,255,255,0.45)",
          shadow: "0 2px 8px rgba(0,0,0,0.04)",
        },
      };

      const currentStyle = isGlass
        ? cardStyles.glass
        : isTranslucent
        ? cardStyles.translucent
        : cfg.cardStyle === "minimal"
        ? cardStyles.minimal
        : cfg.cardStyle === "shadow"
        ? cardStyles.shadow
        : cardStyles.bordered;

      return (
        <div className="ce-preview-featured" style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          background: cfg.bgColor || undefined,
        }}>
          {Array.from({ length: Math.min(cols, 4) }).map((_, n) => (
            <div key={n} className="ce-preview-product-card" style={{
              borderRadius: br,
              border: currentStyle.border,
              background: currentStyle.bg,
              boxShadow: currentStyle.shadow,
              backdropFilter: (isGlass || isTranslucent) ? `blur(${cardBlur}px)` : undefined,
              WebkitBackdropFilter: (isGlass || isTranslucent) ? `blur(${cardBlur}px)` : undefined,
            }}>
              <span className="ce-preview-product-thumb" />
              <span className="ce-preview-product-name">Produk {n + 1}</span>
              {cfg.showPrice !== false && <span className="ce-preview-product-price" style={{ color: theme.accentColor }}>Rp 150.000/hari</span>}
              {cfg.showCategory && <span className="ce-preview-product-cat">Kamera</span>}
            </div>
          ))}
        </div>
      );
    }

    case "image_banner": {
      const cfg = block.config as ImageBannerConfig;
      const heights: Record<string, string> = { sm: "80px", md: "130px", lg: "180px" };
      const blurAmt = cfg.blurAmount ?? 0;
      const overlayBlur = cfg.overlayBlur ?? 0;
      const overlayOp = (cfg.overlayOpacity ?? 40) / 100;

      return (
        <div className="ce-preview-image-banner" style={{
          height: heights[cfg.height] ?? "130px",
          backgroundColor: cfg.imageUrl ? undefined : "#e3dcce",
          position: "relative",
          overflow: "hidden",
        }}>
          {cfg.imageUrl && (
            <div style={{
              position: "absolute",
              inset: blurAmt > 0 ? "-12px" : 0,
              backgroundImage: `url(${cfg.imageUrl})`,
              backgroundSize: cfg.objectFit === "contain" ? "contain" : "cover",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
              filter: blurAmt > 0 ? `blur(${blurAmt}px)` : undefined,
              transform: blurAmt > 0 ? "scale(1.08)" : undefined,
            }} />
          )}
          {cfg.overlayText && (
            <div className="ce-preview-image-overlay" style={{
              background: hexToRgba(cfg.overlayColor || "#000000", overlayOp),
              backdropFilter: overlayBlur > 0 ? `blur(${overlayBlur}px)` : undefined,
              WebkitBackdropFilter: overlayBlur > 0 ? `blur(${overlayBlur}px)` : undefined,
            }}>
              <span>{cfg.overlayText}</span>
            </div>
          )}
          {!cfg.imageUrl && <div className="ce-preview-image-placeholder"><Icon name="image" size={24} /></div>}
        </div>
      );
    }

    case "promo_banner": {
      const cfg = block.config as PromoBannerConfig;
      const isGlass = cfg.glassEffect || globalGlass;
      const bgOpacity = (cfg.bgOpacity ?? 100) / 100;
      const blur = cfg.backdropBlur ?? (isGlass ? globalBlur : 0);

      return (
        <div className="ce-preview-promo" style={{
          background: hexToRgba(cfg.bgColor || theme.accentColor, bgOpacity),
          color: cfg.textColor || "#fffdf9",
          textAlign: cfg.textAlign || "center",
          backdropFilter: blur > 0 ? `blur(${blur}px)` : undefined,
          WebkitBackdropFilter: blur > 0 ? `blur(${blur}px)` : undefined,
          border: isGlass ? "1px solid rgba(255,255,255,0.3)" : undefined,
        }}>
          {cfg.emoji && <span className="ce-preview-promo-emoji">{cfg.emoji}</span>}
          <strong>{cfg.title || "Judul Promo"}</strong>
          <span>{cfg.body || "Deskripsi promo singkat."}</span>
          {cfg.showCta && cfg.ctaLabel && (
            <span className="ce-preview-promo-cta" style={{ borderRadius: btnBr, borderColor: cfg.textColor || "#fffdf9" }}>
              {cfg.ctaLabel}
            </span>
          )}
        </div>
      );
    }

    case "rich_text": {
      const cfg = block.config as RichTextConfig;
      const maxWidths: Record<string, string> = { narrow: "320px", normal: "480px", wide: "100%" };
      const isGlass = cfg.glassCard || globalGlass;
      const bgOpacity = (cfg.bgOpacity ?? 100) / 100;
      const blur = cfg.backdropBlur ?? (isGlass ? globalBlur : 0);

      return (
        <div className="ce-preview-rich-text" style={{
          textAlign: cfg.textAlign || "left",
        }}>
          <div style={{
            maxWidth: maxWidths[cfg.maxWidth ?? "normal"],
            margin: "0 auto",
            background: cfg.bgColor ? hexToRgba(cfg.bgColor, bgOpacity) : (isGlass ? `rgba(255,255,255,${bgOpacity})` : undefined),
            color: cfg.textColor || undefined,
            padding: isGlass ? "16px 20px" : undefined,
            borderRadius: isGlass ? br : undefined,
            backdropFilter: blur > 0 ? `blur(${blur}px)` : undefined,
            WebkitBackdropFilter: blur > 0 ? `blur(${blur}px)` : undefined,
            border: isGlass ? "1px solid rgba(255,255,255,0.3)" : undefined,
            boxShadow: isGlass ? "0 4px 16px rgba(0,0,0,0.05)" : undefined,
          }}>
            <p style={{ margin: 0 }}>
              {cfg.content || "Teks kustom kamu di sini…"}
            </p>
          </div>
        </div>
      );
    }

    case "testimonials": {
      const cfg = block.config as TestimonialsConfig;
      const isGlass = cfg.glassCards || globalGlass;
      const cardOpacity = (cfg.cardOpacity ?? (globalCardOpacity * 100)) / 100;
      const cardBlur = cfg.cardBlur ?? globalBlur;

      return (
        <div className="ce-preview-testimonials" style={{
          flexDirection: cfg.layout === "grid" ? "row" : "column",
          background: cfg.bgColor || undefined,
        }}>
          {(cfg.items ?? []).slice(0, cfg.layout === "grid" ? 3 : 2).map((t, i) => (
            <div key={i} className="ce-preview-testimonial-card" style={{
              borderRadius: br,
              background: isGlass ? `rgba(255,255,255,${cardOpacity})` : undefined,
              backdropFilter: isGlass ? `blur(${cardBlur}px)` : undefined,
              WebkitBackdropFilter: isGlass ? `blur(${cardBlur}px)` : undefined,
              border: isGlass ? "1px solid rgba(255,255,255,0.35)" : undefined,
              boxShadow: isGlass ? "0 4px 16px rgba(0,0,0,0.05)" : undefined,
            }}>
              {cfg.showStars && <Stars count={t.rating ?? 5} />}
              <span className="ce-preview-testimonial-quote">&ldquo;{t.quote}&rdquo;</span>
              <span className="ce-preview-testimonial-name">— {t.name}</span>
            </div>
          ))}
        </div>
      );
    }

    case "faq": {
      const cfg = block.config as FaqConfig;
      const isGlass = cfg.glassEffect || globalGlass;
      const bgOpacity = (cfg.bgOpacity ?? 85) / 100;
      const blur = cfg.backdropBlur ?? (isGlass ? globalBlur : 0);

      return (
        <div className="ce-preview-faq" style={{ background: cfg.bgColor || undefined }}>
          {(cfg.items ?? []).slice(0, 2).map((item, i) => (
            <div key={i} className="ce-preview-faq-item" style={{
              borderRadius: cfg.style === "flat" ? "0" : br,
              background: isGlass ? `rgba(255,255,255,${bgOpacity})` : undefined,
              backdropFilter: isGlass ? `blur(${blur}px)` : undefined,
              WebkitBackdropFilter: isGlass ? `blur(${blur}px)` : undefined,
              border: isGlass ? "1px solid rgba(255,255,255,0.3)" : undefined,
            }}>
              <span className="ce-preview-faq-q" style={{
                background: isGlass ? "rgba(255,255,255,0.15)" : undefined,
              }}>{item.q}</span>
              {cfg.style === "flat" && <span className="ce-preview-faq-a">{item.a}</span>}
            </div>
          ))}
        </div>
      );
    }

    case "video_embed": {
      const cfg = block.config as VideoEmbedConfig;
      const ratios: Record<string, string> = { "16/9": "56.25%", "4/3": "75%", "1/1": "100%" };
      return (
        <div className="ce-preview-video" style={{ background: cfg.bgColor || "#000", paddingTop: ratios[cfg.aspectRatio ?? "16/9"] ?? "56.25%" }}>
          <div className="ce-preview-video-inner">
            <Icon name="eye" size={24} />
            <span>{cfg.title || "Video embed"}</span>
          </div>
        </div>
      );
    }

    case "how_to_book":
      return (
        <div className="ce-preview-how">
          {["Pilih barang", "Cek ketersediaan", "Isi kontak", "Simpan link pesanan"].map((step, i) => (
            <div key={i} className="ce-preview-how-step">
              <span className="ce-preview-how-num" style={{ background: theme.primaryColor, borderRadius: btnBr }}>{i + 1}</span>
              <span>{step}</span>
            </div>
          ))}
        </div>
      );

    case "social_links": {
      const cfg = block.config as SocialLinksConfig;
      const links = [
        { key: "instagram", label: "Instagram", icon: "📸" },
        { key: "facebook", label: "Facebook", icon: "👤" },
        { key: "tiktok", label: "TikTok", icon: "🎵" },
        { key: "youtube", label: "YouTube", icon: "▶️" },
        { key: "twitter", label: "Twitter/X", icon: "🐦" },
      ].filter((l) => (cfg as unknown as Record<string, string>)[l.key]);
      return (
        <div className="ce-preview-social" style={{ background: cfg.bgColor || "#fcfaf4", color: cfg.textColor || "#2f2a24" }}>
          {cfg.label && <span className="ce-preview-social-label">{cfg.label}</span>}
          <div className="ce-preview-social-links">
            {links.map((l) => (
              <span key={l.key} className={`ce-preview-social-item ce-preview-social-${cfg.style ?? "icons"}`}
                style={{ borderRadius: cfg.style === "buttons" ? btnBr : "50%" }}>
                {l.icon} {cfg.style === "buttons" && l.label}
              </span>
            ))}
            {links.length === 0 && <span className="text-xs text-muted">Belum ada link sosmed</span>}
          </div>
        </div>
      );
    }

    case "contact_strip": {
      const cfg = block.config as ContactStripConfig;
      const isGlass = cfg.glassEffect || globalGlass;
      const bgOpacity = (cfg.bgOpacity ?? 85) / 100;
      const blur = cfg.backdropBlur ?? (isGlass ? globalBlur : 0);

      return (
        <div className="ce-preview-contact" style={{
          background: isGlass
            ? hexToRgba(cfg.bgColor || "#f6e7db", bgOpacity)
            : cfg.bgColor || "#f6e7db",
          color: cfg.textColor || "#2f2a24",
          backdropFilter: isGlass ? `blur(${blur}px)` : undefined,
          WebkitBackdropFilter: isGlass ? `blur(${blur}px)` : undefined,
          border: isGlass ? "1px solid rgba(255,255,255,0.35)" : undefined,
          boxShadow: isGlass ? "0 4px 20px rgba(0,0,0,0.06)" : undefined,
        }}>
          <Icon name="message" size={16} />
          <span>{cfg.label || "Hubungi kami"}</span>
          <span className="ce-preview-contact-btn" style={{ borderRadius: btnBr, background: theme.accentColor }}>
            {cfg.ctaLabel || "Tanya Sekarang"}
          </span>
        </div>
      );
    }

    case "spacer": {
      const cfg = block.config as SpacerConfig;
      const heights: Record<string, string> = { xs: "8px", sm: "16px", md: "32px", lg: "48px", xl: "72px" };
      return (
        <div className="ce-preview-spacer" style={{ height: heights[cfg.height ?? "md"], background: cfg.bgColor || "transparent" }}>
          <span className="ce-preview-spacer-label">↕ Spasi {cfg.height}</span>
        </div>
      );
    }

    default:
      return null;
  }
}

/* ═══════════════════════════════════════════════════════ CONFIG PANELS ══ */

export type InspectorSubTab = "content" | "design" | "effects";

function BlockConfigPanel({ block, onUpdate, theme, subTab }: {
  block: BlockDef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onUpdate: (c: any) => void;
  theme: CatalogTheme;
  subTab: InspectorSubTab;
}) {
  switch (block.type) {
    case "hero": {
      const c = block.config as HeroConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <TextInput label="Judul utama" value={c.heading} onChange={(e) => onUpdate({ ...c, heading: e.target.value })} />
            <TextInput label="Subjudul" value={c.subheading} onChange={(e) => onUpdate({ ...c, subheading: e.target.value })} />
            <TextInput label="URL gambar latar (opsional)" placeholder="https://…" value={c.bgImageUrl}
              onChange={(e) => onUpdate({ ...c, bgImageUrl: e.target.value })} />
            <ToggleField label="Tampilkan tombol CTA" value={c.showCta !== false} onChange={(v) => onUpdate({ ...c, showCta: v })} />
            {c.showCta !== false && (
              <>
                <TextInput label="Label tombol CTA" value={c.ctaLabel} onChange={(e) => onUpdate({ ...c, ctaLabel: e.target.value })} />
                <TextInput label="Link tombol (opsional)" placeholder="#produk atau https://…" value={c.ctaLink}
                  onChange={(e) => onUpdate({ ...c, ctaLink: e.target.value })} />
              </>
            )}
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Tinggi banner" value={c.heightSize} onChange={(v) => onUpdate({ ...c, heightSize: v })}
              options={[{ value: "sm", label: "Kecil (90px)" }, { value: "md", label: "Sedang (140px)" }, { value: "lg", label: "Besar (190px)" }]} />
            <SelectField label="Rata teks" value={c.textAlign} onChange={(v) => onUpdate({ ...c, textAlign: v })}
              options={[{ value: "left", label: "Rata Kiri" }, { value: "center", label: "Rata Tengah" }, { value: "right", label: "Rata Kanan" }]} />
            <ColorField label="Warna latar (jika tanpa gambar)" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          {c.bgImageUrl ? (
            <>
              <RangeField label="Efek blur gambar latar" value={c.bgBlur ?? 0} min={0} max={30} step={2} unit="px"
                onChange={(v) => onUpdate({ ...c, bgBlur: v })} />
              <RangeField label="Kegelapan overlay gambar" value={c.overlayOpacity ?? 60} min={0} max={95} step={5} unit="%"
                onChange={(v) => onUpdate({ ...c, overlayOpacity: v })} />
            </>
          ) : (
            <RangeField label="Transparansi warna latar" value={c.bgOpacity ?? 100} min={10} max={100} step={5} unit="%"
              onChange={(v) => onUpdate({ ...c, bgOpacity: v })} />
          )}
          <ToggleField label="Wadah Teks Frosted Glass" hint="Kotak teks semi-transparan berkabut kaca modern di atas latar"
            value={c.glassCard ?? false} onChange={(v) => onUpdate({ ...c, glassCard: v })} />
          {c.glassCard && (
            <>
              <RangeField label="Opasitas wadah teks" value={c.cardOpacity ?? 20} min={10} max={80} step={5} unit="%"
                onChange={(v) => onUpdate({ ...c, cardOpacity: v })} />
              <RangeField label="Intensitas blur wadah teks" value={c.cardBlur ?? 12} min={0} max={25} step={1} unit="px"
                onChange={(v) => onUpdate({ ...c, cardBlur: v })} />
            </>
          )}
        </div>
      );
    }

    case "featured": {
      const c = block.config as FeaturedConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <RangeField label="Batas jumlah produk" value={c.limit ?? 6} min={2} max={12} step={2} onChange={(v) => onUpdate({ ...c, limit: v })} />
            <ToggleField label="Tampilkan harga sewa" value={c.showPrice !== false} onChange={(v) => onUpdate({ ...c, showPrice: v })} />
            <ToggleField label="Tampilkan kategori produk" value={c.showCategory !== false} onChange={(v) => onUpdate({ ...c, showCategory: v })} />
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Jumlah kolom grid" value={String(c.columns)} onChange={(v) => onUpdate({ ...c, columns: Number(v) })}
              options={[{ value: "2", label: "2 Kolom" }, { value: "3", label: "3 Kolom (Rekomendasi)" }, { value: "4", label: "4 Kolom" }]} />
            <SelectField label="Gaya kartu produk" value={c.cardStyle} onChange={(v) => onUpdate({ ...c, cardStyle: v })}
              options={[
                { value: "minimal", label: "Minimal (tanpa border)" },
                { value: "bordered", label: "Border Garis Halus" },
                { value: "shadow", label: "Bayangan Elegan (Drop Shadow)" },
                { value: "glass", label: "✨ Frosted Glass (Kaca Buram)" },
                { value: "translucent", label: "✨ Semi-Transparan (Translucent)" },
              ]} />
            <ColorField label="Warna latar blok (opsional)" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <RangeField label="Opasitas kartu produk" value={c.cardOpacity ?? 85} min={20} max={100} step={5} unit="%"
            onChange={(v) => onUpdate({ ...c, cardOpacity: v })} />
          <RangeField label="Intensitas blur backdrop kartu" value={c.cardBlur ?? 12} min={0} max={25} step={1} unit="px"
            onChange={(v) => onUpdate({ ...c, cardBlur: v })} />
        </div>
      );
    }

    case "categories": {
      const c = block.config as CategoriesConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <ToggleField label="Tampilkan hitungan jumlah produk" value={c.showCount} onChange={(v) => onUpdate({ ...c, showCount: v })} />
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Gaya tata letak" value={c.style} onChange={(v) => onUpdate({ ...c, style: v })}
              options={[{ value: "chips", label: "Pill / Chip Horisontal" }, { value: "grid", label: "Grid Kotak" }, { value: "list", label: "Daftar Baris Vertikal" }]} />
            <ColorField label="Warna latar blok" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <p className="text-sm text-muted">Kategori produk mengadopsi warna aksen dan sudut kartu dari tab <strong>Tema &amp; Gaya</strong>.</p>
        </div>
      );
    }

    case "promo_banner": {
      const c = block.config as PromoBannerConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <div className="ce-inline-row">
              <TextInput label="Emoji" placeholder="🎉" value={c.emoji} onChange={(e) => onUpdate({ ...c, emoji: e.target.value })} />
              <TextInput label="Judul promo" value={c.title} onChange={(e) => onUpdate({ ...c, title: e.target.value })} />
            </div>
            <TextInput label="Isi teks promo" value={c.body} onChange={(e) => onUpdate({ ...c, body: e.target.value })} />
            <ToggleField label="Tampilkan tombol CTA" value={c.showCta ?? false} onChange={(v) => onUpdate({ ...c, showCta: v })} />
            {c.showCta && <TextInput label="Label tombol CTA" value={c.ctaLabel} onChange={(e) => onUpdate({ ...c, ctaLabel: e.target.value })} />}
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Rata teks" value={c.textAlign} onChange={(v) => onUpdate({ ...c, textAlign: v })}
              options={[{ value: "left", label: "Kiri" }, { value: "center", label: "Tengah" }]} />
            <ColorField label="Warna latar promo" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
            <ColorField label="Warna teks" value={c.textColor} onChange={(v) => onUpdate({ ...c, textColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <ToggleField label="Efek Frosted Glass" hint="Banner promo semi-transparan dengan efek kabut kaca"
            value={c.glassEffect ?? false} onChange={(v) => onUpdate({ ...c, glassEffect: v })} />
          <RangeField label="Opasitas warna latar" value={c.bgOpacity ?? 100} min={20} max={100} step={5} unit="%"
            onChange={(v) => onUpdate({ ...c, bgOpacity: v })} />
          <RangeField label="Intensitas blur backdrop" value={c.backdropBlur ?? 10} min={0} max={25} step={1} unit="px"
            onChange={(v) => onUpdate({ ...c, backdropBlur: v })} />
        </div>
      );
    }

    case "stats_bar": {
      const c = block.config as StatsBarConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <span className="text-xs text-muted">Daftar metrik statistik:</span>
            {(c.stats ?? []).map((s, i) => (
              <div key={i} className="ce-testimonial-entry">
                <div className="ce-inline-row">
                  <TextInput label="Emoji" value={s.emoji} onChange={(e) => {
                    const next = c.stats.map((x: typeof s, j: number) => j === i ? { ...x, emoji: e.target.value } : x);
                    onUpdate({ ...c, stats: next });
                  }} />
                  <TextInput label="Nilai / Angka" value={s.value} onChange={(e) => {
                    const next = c.stats.map((x: typeof s, j: number) => j === i ? { ...x, value: e.target.value } : x);
                    onUpdate({ ...c, stats: next });
                  }} />
                </div>
                <TextInput label="Keterangan / Label" value={s.label} onChange={(e) => {
                  const next = c.stats.map((x: typeof s, j: number) => j === i ? { ...x, label: e.target.value } : x);
                  onUpdate({ ...c, stats: next });
                }} />
              </div>
            ))}
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Format layout" value={c.layout} onChange={(v) => onUpdate({ ...c, layout: v })}
              options={[{ value: "row", label: "Baris Horisontal" }, { value: "grid", label: "Grid Kotak 2×2" }]} />
            <ColorField label="Warna latar" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
            <ColorField label="Warna teks & angka" value={c.textColor} onChange={(v) => onUpdate({ ...c, textColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <ToggleField label="Efek Kartu Kaca (Glassmorphism)" hint="Ubah statistik menjadi kartu transparan berkilau"
            value={c.glassEffect ?? false} onChange={(v) => onUpdate({ ...c, glassEffect: v })} />
          {c.glassEffect && (
            <>
              <RangeField label="Opasitas latar statistik" value={c.bgOpacity ?? 80} min={20} max={100} step={5} unit="%"
                onChange={(v) => onUpdate({ ...c, bgOpacity: v })} />
              <RangeField label="Intensitas blur backdrop" value={c.backdropBlur ?? 12} min={0} max={25} step={1} unit="px"
                onChange={(v) => onUpdate({ ...c, backdropBlur: v })} />
            </>
          )}
        </div>
      );
    }

    case "testimonials": {
      const c = block.config as TestimonialsConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            {(c.items ?? []).map((t, i) => (
              <div key={i} className="ce-testimonial-entry">
                <div className="ce-inline-row">
                  <TextInput label={`Nama Pelanggan ${i + 1}`} value={t.name} onChange={(e) => {
                    const next = c.items.map((x: typeof t, j: number) => j === i ? { ...x, name: e.target.value } : x);
                    onUpdate({ ...c, items: next });
                  }} />
                  <label className="field" style={{ flex: "0 0 90px" }}>
                    <span className="label">Rating</span>
                    <select className="select" value={t.rating} onChange={(e) => {
                      const next = c.items.map((x: typeof t, j: number) => j === i ? { ...x, rating: Number(e.target.value) } : x);
                      onUpdate({ ...c, items: next });
                    }}>
                      {[5, 4, 3, 2, 1].map((r) => <option key={r} value={r}>{r} ★</option>)}
                    </select>
                  </label>
                </div>
                <TextInput label="Kutipan Ulasan" value={t.quote} onChange={(e) => {
                  const next = c.items.map((x: typeof t, j: number) => j === i ? { ...x, quote: e.target.value } : x);
                  onUpdate({ ...c, items: next });
                }} />
                <button type="button" className="btn btn-ghost btn-sm ce-remove-btn"
                  onClick={() => onUpdate({ ...c, items: c.items.filter((_: typeof t, j: number) => j !== i) })}>
                  <Icon name="trash" size={14} /> Hapus Ulasan Ini
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm"
              onClick={() => onUpdate({ ...c, items: [...(c.items ?? []), { name: "", quote: "", rating: 5 }] })}>
              <Icon name="plus" size={14} /> Tambah Ulasan Baru
            </button>
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Layout tampilan" value={c.layout} onChange={(v) => onUpdate({ ...c, layout: v })}
              options={[{ value: "stack", label: "Tumpuk Vertikal" }, { value: "grid", label: "Grid Sejajar Horisontal" }]} />
            <ToggleField label="Tampilkan bintang rating" value={c.showStars !== false} onChange={(v) => onUpdate({ ...c, showStars: v })} />
            <ColorField label="Warna latar blok" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <ToggleField label="Kartu Frosted Glass" hint="Kartu testimoni transparan dengan pantulan kaca"
            value={c.glassCards ?? false} onChange={(v) => onUpdate({ ...c, glassCards: v })} />
          {c.glassCards && (
            <>
              <RangeField label="Opasitas kartu ulasan" value={c.cardOpacity ?? 85} min={20} max={100} step={5} unit="%"
                onChange={(v) => onUpdate({ ...c, cardOpacity: v })} />
              <RangeField label="Intensitas blur backdrop" value={c.cardBlur ?? 12} min={0} max={25} step={1} unit="px"
                onChange={(v) => onUpdate({ ...c, cardBlur: v })} />
            </>
          )}
        </div>
      );
    }

    case "faq": {
      const c = block.config as FaqConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            {(c.items ?? []).map((item, i) => (
              <div key={i} className="ce-testimonial-entry">
                <TextInput label={`Pertanyaan ${i + 1}`} value={item.q} onChange={(e) => {
                  const next = c.items.map((x: typeof item, j: number) => j === i ? { ...x, q: e.target.value } : x);
                  onUpdate({ ...c, items: next });
                }} />
                <TextInput label={`Jawaban ${i + 1}`} value={item.a} onChange={(e) => {
                  const next = c.items.map((x: typeof item, j: number) => j === i ? { ...x, a: e.target.value } : x);
                  onUpdate({ ...c, items: next });
                }} />
                <button type="button" className="btn btn-ghost btn-sm ce-remove-btn"
                  onClick={() => onUpdate({ ...c, items: c.items.filter((_: typeof item, j: number) => j !== i) })}>
                  <Icon name="trash" size={14} /> Hapus FAQ
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm"
              onClick={() => onUpdate({ ...c, items: [...(c.items ?? []), { q: "", a: "" }] })}>
              <Icon name="plus" size={14} /> Tambah Pertanyaan FAQ
            </button>
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Format FAQ" value={c.style} onChange={(v) => onUpdate({ ...c, style: v })}
              options={[{ value: "accordion", label: "Accordion (Klik Buka-Tutup)" }, { value: "flat", label: "Flat (Semua Terbuka)" }]} />
            <ColorField label="Warna latar blok" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <ToggleField label="Accordion Glassmorphism" hint="Pertanyaan &amp; jawaban berlatar kaca transparan"
            value={c.glassEffect ?? false} onChange={(v) => onUpdate({ ...c, glassEffect: v })} />
          {c.glassEffect && (
            <>
              <RangeField label="Opasitas item FAQ" value={c.bgOpacity ?? 85} min={20} max={100} step={5} unit="%"
                onChange={(v) => onUpdate({ ...c, bgOpacity: v })} />
              <RangeField label="Intensitas blur backdrop" value={c.backdropBlur ?? 10} min={0} max={20} step={1} unit="px"
                onChange={(v) => onUpdate({ ...c, backdropBlur: v })} />
            </>
          )}
        </div>
      );
    }

    case "image_banner": {
      const c = block.config as ImageBannerConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <TextInput label="URL gambar" placeholder="https://…" value={c.imageUrl} onChange={(e) => onUpdate({ ...c, imageUrl: e.target.value })} />
            <TextInput label="Teks deskripsi gambar (alt)" value={c.altText} onChange={(e) => onUpdate({ ...c, altText: e.target.value })} />
            <TextInput label="Link tautan saat gambar diklik (opsional)" placeholder="https://…" value={c.linkUrl} onChange={(e) => onUpdate({ ...c, linkUrl: e.target.value })} />
            <TextInput label="Teks tulisan di atas gambar (overlay)" value={c.overlayText} onChange={(e) => onUpdate({ ...c, overlayText: e.target.value })} />
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Tinggi banner gambar" value={c.height} onChange={(v) => onUpdate({ ...c, height: v })}
              options={[{ value: "sm", label: "Kecil (80px)" }, { value: "md", label: "Sedang (130px)" }, { value: "lg", label: "Besar (180px)" }]} />
            <SelectField label="Kerapatan gambar" value={c.objectFit} onChange={(v) => onUpdate({ ...c, objectFit: v })}
              options={[{ value: "cover", label: "Cover (Penuh terpotong proporsional)" }, { value: "contain", label: "Contain (Seluruh gambar terlihat)" }]} />
            {c.overlayText && <TextInput label="Warna overlay teks" placeholder="rgba(0,0,0,0.4)" value={c.overlayColor} onChange={(e) => onUpdate({ ...c, overlayColor: e.target.value })} />}
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <RangeField label="Intensitas blur gambar latar" value={c.blurAmount ?? 0} min={0} max={30} step={2} unit="px"
            onChange={(v) => onUpdate({ ...c, blurAmount: v })} />
          {c.overlayText && (
            <>
              <RangeField label="Transparansi overlay" value={c.overlayOpacity ?? 40} min={0} max={95} step={5} unit="%"
                onChange={(v) => onUpdate({ ...c, overlayOpacity: v })} />
              <RangeField label="Blur backdrop overlay (frosted)" value={c.overlayBlur ?? 0} min={0} max={20} step={1} unit="px"
                onChange={(v) => onUpdate({ ...c, overlayBlur: v })} />
            </>
          )}
        </div>
      );
    }

    case "rich_text": {
      const c = block.config as RichTextConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <label className="field">
              <span className="label">Isi paragraf teks</span>
              <textarea className="ce-textarea" rows={5} value={c.content} onChange={(e) => onUpdate({ ...c, content: e.target.value })} />
            </label>
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Rata teks" value={c.textAlign} onChange={(v) => onUpdate({ ...c, textAlign: v })}
              options={[{ value: "left", label: "Rata Kiri" }, { value: "center", label: "Rata Tengah" }, { value: "right", label: "Rata Kanan" }]} />
            <SelectField label="Lebar maksimal wadah teks" value={c.maxWidth} onChange={(v) => onUpdate({ ...c, maxWidth: v })}
              options={[{ value: "narrow", label: "Sempit (Fokus)" }, { value: "normal", label: "Normal Standar" }, { value: "wide", label: "Lebar Penuh" }]} />
            <ColorField label="Warna latar kotak" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
            <ColorField label="Warna font teks" value={c.textColor} onChange={(v) => onUpdate({ ...c, textColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <ToggleField label="Wadah Frosted Glass" hint="Tampilkan teks dalam bingkai kaca buram modern"
            value={c.glassCard ?? false} onChange={(v) => onUpdate({ ...c, glassCard: v })} />
          {c.glassCard && (
            <>
              <RangeField label="Opasitas latar kotak" value={c.bgOpacity ?? 85} min={10} max={100} step={5} unit="%"
                onChange={(v) => onUpdate({ ...c, bgOpacity: v })} />
              <RangeField label="Intensitas blur backdrop" value={c.backdropBlur ?? 12} min={0} max={25} step={1} unit="px"
                onChange={(v) => onUpdate({ ...c, backdropBlur: v })} />
            </>
          )}
        </div>
      );
    }

    case "contact_strip": {
      const c = block.config as ContactStripConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <TextInput label="Teks ajakan kontak" value={c.label} onChange={(e) => onUpdate({ ...c, label: e.target.value })} />
            <TextInput label="Label tombol kontak" value={c.ctaLabel} onChange={(e) => onUpdate({ ...c, ctaLabel: e.target.value })} />
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <ColorField label="Warna latar strip" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
            <ColorField label="Warna font teks" value={c.textColor} onChange={(v) => onUpdate({ ...c, textColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <ToggleField label="Efek Floating Glass Bar" hint="Strip kontak mengambang transparan dengan efek frosted"
            value={c.glassEffect ?? false} onChange={(v) => onUpdate({ ...c, glassEffect: v })} />
          {c.glassEffect && (
            <>
              <RangeField label="Opasitas strip" value={c.bgOpacity ?? 85} min={20} max={100} step={5} unit="%"
                onChange={(v) => onUpdate({ ...c, bgOpacity: v })} />
              <RangeField label="Intensitas blur backdrop" value={c.backdropBlur ?? 12} min={0} max={25} step={1} unit="px"
                onChange={(v) => onUpdate({ ...c, backdropBlur: v })} />
            </>
          )}
        </div>
      );
    }

    case "video_embed": {
      const c = block.config as VideoEmbedConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <TextInput label="URL embed video YouTube/Vimeo" placeholder="https://www.youtube.com/embed/…"
              value={c.embedUrl} onChange={(e) => onUpdate({ ...c, embedUrl: e.target.value })} />
            <TextInput label="Judul / Keterangan video" value={c.title} onChange={(e) => onUpdate({ ...c, title: e.target.value })} />
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Rasio aspek video" value={c.aspectRatio} onChange={(v) => onUpdate({ ...c, aspectRatio: v })}
              options={[{ value: "16/9", label: "16:9 (Landscape)" }, { value: "4/3", label: "4:3 (Klasik)" }, { value: "1/1", label: "1:1 (Persegi)" }]} />
            <ColorField label="Warna latar blok" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <p className="text-sm text-muted">Pemutar video responsif secara otomatis beradaptasi dengan layar perangkat.</p>
        </div>
      );
    }

    case "social_links": {
      const c = block.config as SocialLinksConfig;
      if (subTab === "content") {
        return (
          <div className="ce-config-fields">
            <TextInput label="Label ajakan" placeholder="Ikuti kami di…" value={c.label} onChange={(e) => onUpdate({ ...c, label: e.target.value })} />
            <TextInput label="Instagram (URL)" placeholder="https://instagram.com/…" value={c.instagram} onChange={(e) => onUpdate({ ...c, instagram: e.target.value })} />
            <TextInput label="TikTok (URL)" placeholder="https://tiktok.com/@…" value={c.tiktok} onChange={(e) => onUpdate({ ...c, tiktok: e.target.value })} />
            <TextInput label="Facebook (URL)" placeholder="https://facebook.com/…" value={c.facebook} onChange={(e) => onUpdate({ ...c, facebook: e.target.value })} />
            <TextInput label="YouTube (URL)" placeholder="https://youtube.com/…" value={c.youtube} onChange={(e) => onUpdate({ ...c, youtube: e.target.value })} />
            <TextInput label="Twitter / X (URL)" placeholder="https://x.com/…" value={c.twitter} onChange={(e) => onUpdate({ ...c, twitter: e.target.value })} />
          </div>
        );
      }
      if (subTab === "design") {
        return (
          <div className="ce-config-fields">
            <SelectField label="Gaya tombol media sosial" value={c.style} onChange={(v) => onUpdate({ ...c, style: v })}
              options={[{ value: "icons", label: "Ikon Bulat Minimalis" }, { value: "buttons", label: "Tombol Lengkap Berlabel" }]} />
            <ColorField label="Warna latar" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
            <ColorField label="Warna font/ikon" value={c.textColor} onChange={(v) => onUpdate({ ...c, textColor: v })} />
          </div>
        );
      }
      return (
        <div className="ce-config-fields">
          <p className="text-sm text-muted">Radius sudut tombol mengikuti gaya tombol global di tab <strong>Tema &amp; Gaya</strong>.</p>
        </div>
      );
    }

    case "how_to_book":
      return (
        <div className="ce-config-fields">
          <p className="text-sm text-muted">
            Blok ini menampilkan alur 4 langkah pemesanan terpadu Rentalio secara otomatis:
          </p>
          <ol className="text-xs text-muted" style={{ paddingLeft: "16px", display: "flex", flexDirection: "column", gap: "4px" }}>
            <li>Pilih barang &amp; durasi sewa</li>
            <li>Ajukan booking melalui formulir katalog</li>
            <li>Konfirmasi dari admin toko &amp; pembayaran</li>
            <li>Barang diambil di toko atau dikirim</li>
          </ol>
        </div>
      );

    case "spacer": {
      const c = block.config as SpacerConfig;
      if (subTab === "content") {
        return <p className="text-sm text-muted">Spasi kosong memberikan jeda vertikal antar blok agar katalog terasa lapang dan lega.</p>;
      }
      return (
        <div className="ce-config-fields">
          <SelectField label="Tinggi jarak vertikal" value={c.height} onChange={(v) => onUpdate({ ...c, height: v })}
            options={[
              { value: "xs", label: "Sangat Kecil (8px)" },
              { value: "sm", label: "Kecil (16px)" },
              { value: "md", label: "Sedang (32px)" },
              { value: "lg", label: "Besar (48px)" },
              { value: "xl", label: "Ekstra Besar (72px)" },
            ]} />
          <ColorField label="Warna latar spasi (opsional)" value={c.bgColor} onChange={(v) => onUpdate({ ...c, bgColor: v })} />
        </div>
      );
    }

    default:
      return null;
  }
}

/* ════════════════════════════════════════════════════════ THEME PANEL ══ */

function ThemePanel({ theme, onChange }: { theme: CatalogTheme; onChange: (t: CatalogTheme) => void }) {
  const FONTS = [
    "Inter Variable", "Georgia", "Poppins", "Lato", "Roboto",
    "Merriweather", "Playfair Display", "Montserrat",
  ];

  const applyPreset = (preset: {
    glassmorphism: boolean;
    cardOpacity: number;
    backdropBlur: number;
    glassBorder: "subtle" | "bold" | "glow" | "none";
  }) => {
    onChange({
      ...theme,
      ...preset,
    });
  };

  return (
    <div className="ce-config-fields">
      <p className="text-xs text-muted">Tema berlaku untuk seluruh halaman katalog — warna, tipografi, dan gaya komponen.</p>

      <VisualEffectSection title="Preset Cepat Efek Visual (Glassmorphism)">
        <p className="text-xs text-muted">Pilih tampilan estetika instan untuk seluruh katalog toko kamu:</p>
        <div className="ce-preset-grid">
          <button
            type="button"
            id="ce-preset-solid"
            className={`ce-preset-btn ${!theme.glassmorphism ? "ce-preset-btn--active" : ""}`}
            onClick={() => applyPreset({ glassmorphism: false, cardOpacity: 100, backdropBlur: 0, glassBorder: "none" })}>
            <span className="ce-preset-title">Standar Solid</span>
            <span className="ce-preset-desc">Padat klasik tanpa blur</span>
          </button>
          <button
            type="button"
            id="ce-preset-soft"
            className={`ce-preset-btn ${theme.glassmorphism && theme.cardOpacity >= 80 ? "ce-preset-btn--active" : ""}`}
            onClick={() => applyPreset({ glassmorphism: true, cardOpacity: 85, backdropBlur: 10, glassBorder: "subtle" })}>
            <span className="ce-preset-title">Soft Glass</span>
            <span className="ce-preset-desc">Kaca halus, blur 10px</span>
          </button>
          <button
            type="button"
            id="ce-preset-deep"
            className={`ce-preset-btn ${theme.glassmorphism && theme.cardOpacity < 80 && theme.cardOpacity >= 55 ? "ce-preset-btn--active" : ""}`}
            onClick={() => applyPreset({ glassmorphism: true, cardOpacity: 65, backdropBlur: 20, glassBorder: "glow" })}>
            <span className="ce-preset-title">Deep Frosted</span>
            <span className="ce-preset-desc">Kabut tebal &amp; kilau</span>
          </button>
          <button
            type="button"
            id="ce-preset-ultra"
            className={`ce-preset-btn ${theme.glassmorphism && theme.cardOpacity < 55 ? "ce-preset-btn--active" : ""}`}
            onClick={() => applyPreset({ glassmorphism: true, cardOpacity: 45, backdropBlur: 16, glassBorder: "bold" })}>
            <span className="ce-preset-title">Ultra Transparan</span>
            <span className="ce-preset-desc">Sangat tembus pandang</span>
          </button>
        </div>

        <ToggleField
          label="Aktifkan Efek Frosted Glass Global"
          hint="Mengubah kartu produk, strip, dan kontainer menjadi efek kaca buram tembus pandang"
          value={theme.glassmorphism}
          onChange={(v) => onChange({ ...theme, glassmorphism: v })}
        />

        {theme.glassmorphism && (
          <>
            <RangeField
              label="Tingkat Transparansi Kartu"
              value={theme.cardOpacity}
              min={20}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => onChange({ ...theme, cardOpacity: v })}
            />
            <RangeField
              label="Intensitas Blur Backdrop"
              value={theme.backdropBlur}
              min={0}
              max={30}
              step={1}
              unit="px"
              onChange={(v) => onChange({ ...theme, backdropBlur: v })}
            />
            <SelectField
              label="Gaya Garis Tepi Kaca"
              value={theme.glassBorder}
              onChange={(v) => onChange({ ...theme, glassBorder: v as CatalogTheme["glassBorder"] })}
              options={[
                { value: "subtle", label: "Halus (Subtle 1px)" },
                { value: "bold", label: "Tegas (Bold 1.5px)" },
                { value: "glow", label: "Kilau Lembut (Glow)" },
                { value: "none", label: "Tanpa Garis Tepi" },
              ]}
            />
          </>
        )}
      </VisualEffectSection>

      <ColorField label="Warna utama (judul, latar hero)" value={theme.primaryColor}
        onChange={(v) => onChange({ ...theme, primaryColor: v })} />
      <ColorField label="Warna aksen (tombol, harga, highlight)" value={theme.accentColor}
        onChange={(v) => onChange({ ...theme, accentColor: v })} />
      <ColorField label="Warna latar halaman katalog" value={theme.pageBgColor}
        onChange={(v) => onChange({ ...theme, pageBgColor: v })} />
      <SelectField label="Font tipografi utama" value={theme.fontFamily} onChange={(v) => onChange({ ...theme, fontFamily: v })}
        options={FONTS.map((f) => ({ value: f, label: f }))} />
      <SelectField label="Gaya sudut tombol" value={theme.buttonStyle} onChange={(v) => onChange({ ...theme, buttonStyle: v as CatalogTheme["buttonStyle"] })}
        options={[
          { value: "rounded", label: "Rounded (Sudut Halus)" },
          { value: "pill", label: "Pill (Sudut Bulat Penuh)" },
          { value: "square", label: "Square (Sudut Kotak Tegas)" },
        ]} />
      <SelectField label="Sudut lengkung kartu produk" value={theme.cardRadius} onChange={(v) => onChange({ ...theme, cardRadius: v as CatalogTheme["cardRadius"] })}
        options={[
          { value: "none", label: "Tanpa sudut (Kotak)" },
          { value: "sm", label: "Kecil (4px)" },
          { value: "md", label: "Sedang (8px)" },
          { value: "lg", label: "Besar (14px)" },
        ]} />

      <div className="ce-theme-preview-row">
        <span className="text-xs text-muted">Contoh tombol dengan tema aktif:</span>
        <div className="ce-theme-btn-preview">
          <span style={{
            display: "inline-block",
            background: theme.primaryColor,
            color: "#fffdf9",
            borderRadius: theme.buttonStyle === "pill" ? "999px" : theme.buttonStyle === "square" ? "0" : "6px",
            padding: "5px 14px",
            fontSize: "0.8125rem",
            fontFamily: theme.fontFamily,
            fontWeight: 500,
          }}>Tombol Utama</span>
          <span style={{
            display: "inline-block",
            background: theme.accentColor,
            color: "#fffdf9",
            borderRadius: theme.buttonStyle === "pill" ? "999px" : theme.buttonStyle === "square" ? "0" : "6px",
            padding: "5px 14px",
            fontSize: "0.8125rem",
            fontFamily: theme.fontFamily,
            fontWeight: 500,
          }}>Tombol Aksen</span>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════ MAIN PAGE ══ */

type View = "editor" | "preview";
type SidebarTab = "blocks" | "theme" | "add";
type DeviceMode = "desktop" | "tablet" | "mobile";

export function CatalogEditorPage() {
  const { tenant, tenantId } = useSession();
  const [blocks, setBlocks] = useState<BlockDef[]>(DEFAULT_BLOCKS);
  const [theme, setTheme] = useState<CatalogTheme>(DEFAULT_THEME);
  const [branding, setBranding] = useState<Record<string, unknown>>({});
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [inspectorSubTab, setInspectorSubTab] = useState<InspectorSubTab>("content");
  const [view, setView] = useState<View>("editor");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("blocks");
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState<number | null>(null);

  // ── Sinkronisasi server: draf tersimpan → publish → katalog publik ──
  const [loadingInitial, setLoadingInitial] = useState(Boolean(tenantId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<CatalogConfigIssue[]>([]);
  const [draftMeta, setDraftMeta] = useState<{
    id: string | null;
    version: number | null;
    templateKey: string | null;
  }>({ id: null, version: null, templateKey: null });
  const [liveVersion, setLiveVersion] = useState<number | null>(null);
  const [livePublishedAt, setLivePublishedAt] = useState<string | null>(null);
  const [publishedNotice, setPublishedNotice] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templates, setTemplates] = useState<CatalogConfigTemplate[]>([]);
  const [templateBlocks, setTemplateBlocks] = useState<CatalogConfigBlockDefinition[]>([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [applyingTemplate, setApplyingTemplate] = useState<string | null>(null);

  const markDirty = () => {
    setSaved(false);
    setDirty(true);
    setPublishedNotice(false);
  };

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void (async () => {
      setLoadingInitial(true);
      try {
        const state = await catalogConfigApi.getState(tenantId);
        if (cancelled) return;
        // Draf adalah sumber kerja; bila belum ada, pakai versi live/default.
        const source = state.draft?.config ?? state.published?.config ?? state.defaults;
        setBlocks(hydrateBlocks(source?.blocks));
        setTheme(hydrateTheme(source?.theme));
        setBranding((source?.branding as Record<string, unknown> | undefined) ?? {});
        setDraftMeta({
          id: state.draft?.id ?? null,
          version: state.draft?.version ?? null,
          templateKey: state.draft?.templateKey ?? state.defaults?.templateKey ?? null,
        });
        setLiveVersion(state.published?.version ?? null);
        setLivePublishedAt(state.published?.publishedAt ?? null);
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(describeApiError(error));
      } finally {
        if (!cancelled) setLoadingInitial(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const { onDragStart, onDragEnter, onDragEnd } = useDragSort(blocks, (next) => {
    setBlocks(next);
    setIsDraggingOver(null);
    markDirty();
  });

  const toggleBlock = (id: string) => {
    setBlocks((prev) => prev.map((b) => b.id === id ? { ...b, enabled: !b.enabled } : b));
    markDirty();
  };

  const moveBlock = (index: number, direction: "up" | "down") => {
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= blocks.length) return;
    const newBlocks = [...blocks];
    const [moved] = newBlocks.splice(index, 1);
    if (moved) {
      newBlocks.splice(targetIndex, 0, moved);
      setBlocks(newBlocks);
      markDirty();
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateConfig = (id: string, config: any) => {
    setBlocks((prev) => prev.map((b) => b.id === id ? { ...b, config } : b));
    markDirty();
  };

  /**
   * Payload yang dikirim ke server hanya memuat presentasi. Konfigurasi yang
   * sudah tersimpan (draf/live) tetap divalidasi ulang server terhadap allowlist
   * blok & properti, jadi editor tidak bisa menyelundupkan data lain.
   */
  const buildPayload = (templateKey: string | null = draftMeta.templateKey): CatalogConfigRequest => ({
    theme: theme as unknown as Record<string, unknown>,
    branding,
    blocks: blocks.map((block) => ({
      id: block.id,
      type: block.type,
      enabled: block.enabled,
      config: (block.config ?? {}) as Record<string, unknown>,
    })),
    ...(templateKey ? { templateKey } : {}),
  });

  const applySaveResult = (
    result: { id?: string; version?: number; templateKey?: string },
    options: { keepDirty?: boolean } = {},
  ) => {
    setDraftMeta({
      id: result.id ?? null,
      version: result.version ?? null,
      templateKey: result.templateKey ?? null,
    });
    setIssues([]);
    setSaveError(null);
    setSaved(true);
    if (!options.keepDirty) setDirty(false);
  };

  const handleSave = async () => {
    if (!tenantId) {
      setSaveError("Tenant belum terpilih. Muat ulang halaman setelah masuk.");
      return;
    }
    setSaving(true);
    try {
      const result = await catalogConfigApi.saveDraft(tenantId, buildPayload());
      applySaveResult(result);
    } catch (error) {
      setSaved(false);
      setSaveError(describeApiError(error));
      setIssues(issuesFrom(error));
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!tenantId) {
      setSaveError("Tenant belum terpilih. Muat ulang halaman setelah masuk.");
      return;
    }
    setPublishing(true);
    try {
      // Simpan dulu agar yang tayang = isi yang sedang terlihat di editor.
      const draft = await catalogConfigApi.saveDraft(tenantId, buildPayload());
      const result = await catalogConfigApi.publish(tenantId);
      setDraftMeta({
        id: result.draft.id ?? null,
        version: result.draft.version ?? null,
        templateKey: result.draft.templateKey ?? null,
      });
      setLiveVersion(result.published.version ?? null);
      setLivePublishedAt(result.published.publishedAt ?? null);
      setIssues([]);
      setSaveError(null);
      setSaved(true);
      setDirty(false);
      setPublishedNotice(true);
      void draft;
    } catch (error) {
      setSaved(false);
      setSaveError(describeApiError(error));
      setIssues(issuesFrom(error));
    } finally {
      setPublishing(false);
    }
  };

  const openTemplates = async () => {
    setTemplateOpen(true);
    if (!tenantId) return;
    setTemplateLoading(true);
    try {
      const gallery = await catalogConfigApi.templates(tenantId);
      setTemplates(gallery.templates);
      setTemplateBlocks(gallery.blocks);
      setTemplateError(null);
    } catch (error) {
      setTemplateError(describeApiError(error));
    } finally {
      setTemplateLoading(false);
    }
  };

  const applyTemplate = async (templateKey: string) => {
    if (!tenantId) return;
    setApplyingTemplate(templateKey);
    try {
      const draft = await catalogConfigApi.applyTemplate(tenantId, templateKey);
      setBlocks(hydrateBlocks(draft.config?.blocks));
      setTheme(hydrateTheme(draft.config?.theme));
      setBranding((draft.config?.branding as Record<string, unknown> | undefined) ?? branding);
      setDraftMeta({
        id: draft.id ?? null,
        version: draft.version ?? null,
        templateKey: draft.templateKey ?? null,
      });
      setEditingBlockId(null);
      setTemplateOpen(false);
      setTemplateError(null);
      setIssues([]);
      setSaveError(null);
      markDirty();
      setSaved(false);
    } catch (error) {
      setTemplateError(describeApiError(error));
    } finally {
      setApplyingTemplate(null);
    }
  };

  const resetToDefault = () => {
    if (confirm("Kembalikan susunan dan tema katalog ke pengaturan standar bawaan?")) {
      setBlocks(DEFAULT_BLOCKS);
      setTheme(DEFAULT_THEME);
      setEditingBlockId(null);
      markDirty();
    }
  };

  const activateAndEditBlock = (id: string) => {
    setBlocks((prev) => prev.map((b) => b.id === id ? { ...b, enabled: true } : b));
    setEditingBlockId(id);
    setSidebarTab("blocks");
    setInspectorSubTab("content");
    markDirty();
  };

  const enabledBlocks = blocks.filter((b) => b.enabled);
  const catalogUrl = tenant?.slug ? `/t/${tenant.slug}/katalog` : "/katalog";
  const editingBlock = blocks.find((b) => b.id === editingBlockId);

  return (
    <div className="page ce-page">
      <PageHeader
        title="Kustom katalog"
        subtitle="Sesuaikan tampilan visual katalog toko publik secara realtime. Atur tata letak blok, tema warna, dan pratinjau langsung."
        actions={
          <div className="cluster" style={{ gap: "8px" }}>
            <Link className="btn btn-secondary btn-sm" href={catalogUrl} target="_blank" rel="noreferrer">
              <Icon name="external" size={14} /> Buka Tab Baru
            </Link>
            <button
              type="button"
              id="ce-btn-view-toggle"
              className={`btn btn-sm ${view === "preview" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setView((prev) => (prev === "editor" ? "preview" : "editor"))}>
              <Icon name={view === "editor" ? "eye" : "layout"} size={14} />
              {view === "editor" ? "Pratinjau Penuh" : "Kembali ke Studio"}
            </button>
            <button
              type="button"
              id="ce-btn-templates"
              className="btn btn-secondary btn-sm"
              onClick={() => void openTemplates()}>
              <Icon name="layout" size={14} /> Template Bawaan
            </button>
            <Button variant="secondary" id="ce-btn-save" onClick={() => void handleSave()} loading={saving}>
              <Icon name="check" size={14} /> Simpan Draf
            </Button>
            <Button
              variant="primary"
              id="ce-btn-publish"
              onClick={() => void handlePublish()}
              loading={publishing}>
              <Icon name="arrow-up-right" size={14} /> Terbitkan
            </Button>
          </div>
        }
      />

      <div className="cluster ce-status-strip" style={{ gap: "6px" }}>
        <Badge tone="neutral">Draf v{draftMeta.version ?? "—"}</Badge>
        <Badge tone={liveVersion === null ? "warning" : "success"}>
          {liveVersion === null ? "Live: belum diterbitkan" : `Live v${liveVersion}`}
        </Badge>
        <Badge tone={dirty || draftMeta.version === null ? "warning" : "success"}>
          {dirty
            ? "Perubahan belum disimpan"
            : draftMeta.version === null
              ? "Belum ada draf tersimpan"
              : "Tersimpan di server"}
        </Badge>
        {draftMeta.templateKey && <Badge tone="info">Template: {draftMeta.templateKey}</Badge>}
      </div>

      {loadingInitial && <InlineAlert tone="info">Memuat konfigurasi katalog dari server…</InlineAlert>}
      {loadError && (
        <InlineAlert tone="danger">{loadError} Perubahan belum dapat disimpan sebelum data server termuat.</InlineAlert>
      )}
      {publishedNotice && (
        <InlineAlert tone="info">
          ✓ Konfigurasi diterbitkan (v{liveVersion}). Katalog publik sekarang memakai versi ini.
        </InlineAlert>
      )}
      {saved && !publishedNotice && (
        <InlineAlert tone="info">
          ✓ Draf tersimpan di server (v{draftMeta.version}). Tekan “Terbitkan” agar tayang di katalog publik.
        </InlineAlert>
      )}
      {liveVersion !== null && livePublishedAt && (
        <p className="text-xs text-muted">
          Versi live diterbitkan {new Date(livePublishedAt).toLocaleString("id-ID")}.
        </p>
      )}
      {saveError && (
        <InlineAlert tone="danger">
          {saveError}
          {issues.length > 0 && (
            <ul className="ce-issue-list">
              {issues.slice(0, 12).map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  <code>{issue.path || "konfigurasi"}</code> — {issue.message}
                </li>
              ))}
            </ul>
          )}
        </InlineAlert>
      )}

      {view === "editor" ? (
        <div className={`ce-layout ${sidebarHidden ? "ce-layout--sidebar-hidden" : ""}`}>
          {/* ════════ LEFT PANEL: STUDIO EDITOR ════════ */}
          <div className="ce-sidebar">
            {/* Top Navigation Tabs */}
            <div className="ce-sidebar-tabs">
              <button
                type="button"
                id="ce-tab-blocks"
                className={`ce-sidebar-tab ${sidebarTab === "blocks" ? "ce-sidebar-tab--active" : ""}`}
                onClick={() => setSidebarTab("blocks")}>
                <Icon name="layout" size={14} /> Susunan Blok ({enabledBlocks.length})
              </button>
              <button
                type="button"
                id="ce-tab-theme"
                className={`ce-sidebar-tab ${sidebarTab === "theme" ? "ce-sidebar-tab--active" : ""}`}
                onClick={() => setSidebarTab("theme")}>
                <Icon name="sliders" size={14} /> Tema &amp; Efek Visual
              </button>
              <button
                type="button"
                id="ce-tab-add"
                className={`ce-sidebar-tab ${sidebarTab === "add" ? "ce-sidebar-tab--active" : ""}`}
                onClick={() => setSidebarTab("add")}>
                <Icon name="plus" size={14} /> Tambah Blok
              </button>
              <button
                type="button"
                id="ce-btn-hide-sidebar"
                className="ce-sidebar-hide-btn"
                title="Sembunyikan panel editor untuk memperluas pratinjau"
                aria-label="Sembunyikan Panel Editor"
                onClick={() => setSidebarHidden(true)}>
                <Icon name="arrow-left" size={14} />
                <span className="ce-hide-btn-label">Sembunyikan</span>
              </button>
            </div>

            {/* Scrollable Editor Body */}
            <div className="ce-sidebar-body">
              {sidebarTab === "blocks" && (
                editingBlock ? (
                  /* ── Inspector Focus View ── */
                  <div className="ce-inspector">
                    <div className="ce-inspector-head">
                      <button
                        type="button"
                        id="ce-inspector-back"
                        className="ce-inspector-back-btn"
                        onClick={() => setEditingBlockId(null)}>
                        <Icon name="arrow-left" size={14} /> Kembali ke Susunan Blok
                      </button>
                      <div className="ce-inspector-title-row">
                        <h3 className="ce-inspector-title">
                          <span aria-hidden="true">{BLOCK_META[editingBlock.type].emoji}</span>
                          {BLOCK_META[editingBlock.type].label}
                        </h3>
                        <div className="cluster" style={{ gap: "6px" }}>
                          <Badge tone={editingBlock.enabled ? "success" : "neutral"}>
                            {editingBlock.enabled ? "Aktif" : "Nonaktif"}
                          </Badge>
                          <button
                            type="button"
                            className={`ce-toggle ${editingBlock.enabled ? "ce-toggle--on" : ""}`}
                            aria-label={`Status ${BLOCK_META[editingBlock.type].label}`}
                            aria-pressed={editingBlock.enabled}
                            onClick={() => toggleBlock(editingBlock.id)}>
                            <span className="ce-toggle-thumb" />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Subtabs for Clean Editing */}
                    <div className="ce-subtabs">
                      <button
                        type="button"
                        id="ce-subtab-content"
                        className={`ce-subtab ${inspectorSubTab === "content" ? "ce-subtab--active" : ""}`}
                        onClick={() => setInspectorSubTab("content")}>
                        📝 Konten &amp; Teks
                      </button>
                      <button
                        type="button"
                        id="ce-subtab-design"
                        className={`ce-subtab ${inspectorSubTab === "design" ? "ce-subtab--active" : ""}`}
                        onClick={() => setInspectorSubTab("design")}>
                        🎨 Tata Letak &amp; Gaya
                      </button>
                      <button
                        type="button"
                        id="ce-subtab-effects"
                        className={`ce-subtab ${inspectorSubTab === "effects" ? "ce-subtab--active" : ""}`}
                        onClick={() => setInspectorSubTab("effects")}>
                        ✨ Efek Visual
                      </button>
                    </div>

                    <div className="ce-inspector-fields">
                      <BlockConfigPanel
                        block={editingBlock}
                        onUpdate={(cfg) => updateConfig(editingBlock.id, cfg)}
                        theme={theme}
                        subTab={inspectorSubTab}
                      />
                    </div>
                  </div>
                ) : (
                  /* ── Clean Block Cards List View ── */
                  <>
                    <div className="ce-sidebar-head">
                      <div>
                        <span className="ce-sidebar-title">Daftar Blok Halaman</span>
                        <p className="text-xs text-muted" style={{ margin: "2px 0 0" }}>
                          {enabledBlocks.length} dari {blocks.length} blok aktif di katalog
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs text-muted"
                        onClick={resetToDefault}
                        title="Atur ulang urutan & tema">
                        <Icon name="rotate" size={12} /> Reset
                      </button>
                    </div>

                    <ul className="ce-block-list" role="list">
                      {blocks.map((block, idx) => {
                        const meta = BLOCK_META[block.type];
                        return (
                          <li
                            key={block.id}
                            className={[
                              "ce-block-card",
                              !block.enabled && "ce-block-card--disabled",
                              isDraggingOver === idx && "ce-block-card--drag-over",
                            ].filter(Boolean).join(" ")}
                            draggable
                            onDragStart={() => onDragStart(idx)}
                            onDragEnter={() => { onDragEnter(idx); setIsDraggingOver(idx); }}
                            onDragOver={(e) => e.preventDefault()}
                            onDragEnd={() => { onDragEnd(); setIsDraggingOver(null); }}
                            onDragLeave={() => setIsDraggingOver(null)}>
                            <div className="ce-block-card-main">
                              <span className="ce-drag-handle" title="Geser untuk memindahkan urutan">
                                <Icon name="grip" size={16} />
                              </span>
                              <span className="ce-block-num">#{idx + 1}</span>
                              <button
                                type="button"
                                className="ce-block-info-btn"
                                id={`ce-block-btn-${block.id}`}
                                onClick={() => {
                                  setEditingBlockId(block.id);
                                  setInspectorSubTab("content");
                                }}>
                                <div className="ce-block-title-row">
                                  <span className="ce-block-emoji">{meta.emoji}</span>
                                  <span className="ce-block-name">{meta.label}</span>
                                </div>
                                <span className="ce-block-desc">{meta.description}</span>
                              </button>

                              {/* Quick Reorder Up & Down */}
                              <div className="ce-reorder-group">
                                <button
                                  type="button"
                                  className="ce-reorder-btn"
                                  title="Pindah ke atas"
                                  disabled={idx === 0}
                                  onClick={() => moveBlock(idx, "up")}>
                                  <Icon name="chevron-up" size={12} />
                                </button>
                                <button
                                  type="button"
                                  className="ce-reorder-btn"
                                  title="Pindah ke bawah"
                                  disabled={idx === blocks.length - 1}
                                  onClick={() => moveBlock(idx, "down")}>
                                  <Icon name="chevron-down" size={12} />
                                </button>
                              </div>

                              {/* Toggle switch */}
                              <button
                                type="button"
                                className={`ce-toggle ${block.enabled ? "ce-toggle--on" : ""}`}
                                aria-label={`${block.enabled ? "Nonaktifkan" : "Aktifkan"} ${meta.label}`}
                                aria-pressed={block.enabled}
                                onClick={() => toggleBlock(block.id)}>
                                <span className="ce-toggle-thumb" />
                              </button>

                              {/* Edit button */}
                              <button
                                type="button"
                                id={`ce-edit-btn-${block.id}`}
                                className="ce-block-edit-btn"
                                onClick={() => {
                                  setEditingBlockId(block.id);
                                  setInspectorSubTab("content");
                                }}>
                                <Icon name="pencil" size={12} />
                                Edit
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )
              )}

              {sidebarTab === "theme" && (
                <>
                  <div className="ce-sidebar-head">
                    <span className="ce-sidebar-title">Tema &amp; Efek Visual Global</span>
                  </div>
                  <ThemePanel theme={theme} onChange={(t) => { setTheme(t); markDirty(); }} />
                </>
              )}

              {sidebarTab === "add" && (
                <div className="ce-add-library">
                  <div className="ce-sidebar-head">
                    <span className="ce-sidebar-title">Pustaka Komponen Blok</span>
                    <span className="text-xs text-muted">Klik untuk mengaktifkan ke katalog</span>
                  </div>

                  {(["main", "promo", "social", "media"] as BlockCategory[]).map((cat) => {
                    const categoryTitles: Record<BlockCategory, string> = {
                      main: "🌟 Bagian Utama Halaman",
                      promo: "📣 Promosi & Pemasaran",
                      social: "⭐ Kepercayaan & Bukti Sosial",
                      media: "📞 Komunikasi & Media Toko",
                    };
                    const catBlocks = blocks.filter((b) => BLOCK_META[b.type].category === cat);
                    return (
                      <div key={cat} className="ce-add-category">
                        <span className="ce-add-cat-title">{categoryTitles[cat]}</span>
                        <div className="ce-add-grid">
                          {catBlocks.map((block) => {
                            const meta = BLOCK_META[block.type];
                            return (
                              <div key={block.id} className="ce-add-item">
                                <div className="ce-add-item-info">
                                  <span className="ce-add-item-emoji">{meta.emoji}</span>
                                  <div className="ce-add-item-text">
                                    <span className="ce-add-item-name">{meta.label}</span>
                                    <span className="ce-add-item-desc">{meta.description}</span>
                                  </div>
                                </div>
                                <Button
                                  variant={block.enabled ? "secondary" : "primary"}
                                  size="sm"
                                  onClick={() => activateAndEditBlock(block.id)}>
                                  {block.enabled ? (
                                    <>
                                      <Icon name="check" size={12} /> Aktif (Edit)
                                    </>
                                  ) : (
                                    <>
                                      <Icon name="plus" size={12} /> Aktifkan
                                    </>
                                  )}
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Sticky Footer Save Bar ── */}
            <div className="ce-sidebar-footer">
              <span className="ce-sidebar-footer-hint">
                {saved ? "✓ Tersimpan" : "Belum disimpan"}
              </span>
              <Button variant="primary" size="sm" onClick={handleSave}>
                <Icon name="check" size={13} /> Simpan
              </Button>
            </div>
          </div>

          {/* ════════ RIGHT PANEL: PINNED STICKY LIVE PREVIEW ════════ */}
          <div className="ce-canvas">
            {/* Canvas Header Bar */}
            <div className="ce-canvas-head">
              <div className="ce-canvas-status">
                {sidebarHidden ? (
                  <button
                    type="button"
                    id="ce-btn-show-sidebar"
                    className="ce-canvas-sidebar-toggle ce-canvas-sidebar-toggle--active"
                    onClick={() => setSidebarHidden(false)}
                    title="Buka kembali panel editor (Susunan Blok, Tema, Tambah Blok)">
                    <Icon name="arrow-right" size={14} />
                    <span>Buka Panel Editor</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    id="ce-btn-collapse-sidebar"
                    className="ce-canvas-sidebar-toggle"
                    onClick={() => setSidebarHidden(true)}
                    title="Sembunyikan panel editor untuk memperluas area pratinjau">
                    <Icon name="arrow-left" size={13} />
                    <span>Perluas Pratinjau</span>
                  </button>
                )}
                <span className="ce-live-dot" />
                <span className="ce-canvas-label">Pratinjau Langsung</span>
                <Badge tone="neutral">{enabledBlocks.length} blok aktif</Badge>
              </div>

              {/* Device Mode Switcher */}
              <div className="ce-device-switcher">
                <button
                  type="button"
                  id="ce-device-desktop"
                  className={`ce-device-btn ${deviceMode === "desktop" ? "ce-device-btn--active" : ""}`}
                  onClick={() => setDeviceMode("desktop")}>
                  <Icon name="monitor" size={14} /> Desktop
                </button>
                <button
                  type="button"
                  id="ce-device-tablet"
                  className={`ce-device-btn ${deviceMode === "tablet" ? "ce-device-btn--active" : ""}`}
                  onClick={() => setDeviceMode("tablet")}>
                  <Icon name="tablet" size={14} /> Tablet
                </button>
                <button
                  type="button"
                  id="ce-device-mobile"
                  className={`ce-device-btn ${deviceMode === "mobile" ? "ce-device-btn--active" : ""}`}
                  onClick={() => setDeviceMode("mobile")}>
                  <Icon name="smartphone" size={14} /> Smartphone
                </button>
              </div>

              <div className="ce-canvas-actions">
                <Link className="btn btn-ghost btn-xs text-muted" href={catalogUrl} target="_blank" rel="noreferrer" title="Buka di tab terpisah">
                  <Icon name="external" size={14} /> Tab Baru
                </Link>
              </div>
            </div>

            {/* Viewport Canvas with Sticky Device Mockup */}
            <div className="ce-canvas-viewport">
              <div className={`ce-device-frame ce-device-frame--${deviceMode}`}>
                {/* Smartphone Notch Bar (only in mobile device mode) */}
                {deviceMode === "mobile" && (
                  <div className="ce-mobile-notch">
                    <span>09:41</span>
                    <span className="ce-mobile-island" />
                    <span>5G 100%</span>
                  </div>
                )}

                {/* Mock Browser URL Bar */}
                <div className="ce-mock-bar">
                  <span className="ce-mock-dot" />
                  <span className="ce-mock-dot" />
                  <span className="ce-mock-dot" />
                  <span className="ce-mock-url">rentalio.my.id{catalogUrl}</span>
                </div>

                {/* Scrollable Mockup Catalog Content */}
                <div
                  className="ce-mock-page"
                  style={{
                    background: theme.pageBgColor || "#f1ede4",
                    fontFamily: theme.fontFamily,
                  }}>
                  {enabledBlocks.length === 0 ? (
                    <div className="ce-empty-preview">
                      <Icon name="eye" size={32} />
                      <p>Semua blok sedang dinonaktifkan.</p>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => activateAndEditBlock("hero")}>
                        <Icon name="plus" size={14} /> Aktifkan Blok Hero
                      </button>
                    </div>
                  ) : (
                    <>
                      {enabledBlocks.map((block) => (
                        <div key={block.id} className="ce-preview-block">
                          <BlockPreview block={block} theme={theme} />
                        </div>
                      ))}
                      <div className="ce-preview-footer">
                        <span className="ce-preview-footer-brand">
                          © 2026 {tenant?.name || "Katalog Toko"} · Didukung oleh <strong>Rentalio</strong>
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Full Preview View Mode */
        <div className="ce-full-preview">
          <div className="ce-full-preview-head cluster" style={{ justifyContent: "space-between" }}>
            <span className="text-sm text-muted">Pratinjau Penuh Layar · {enabledBlocks.length} blok aktif</span>
            <button
              type="button"
              id="ce-btn-exit-full-preview"
              className="btn btn-secondary btn-sm"
              onClick={() => setView("editor")}>
              <Icon name="layout" size={14} /> Kembali ke Mode Studio
            </button>
          </div>
          <div
            className="ce-full-preview-page"
            style={{
              background: theme.pageBgColor || "#f1ede4",
              fontFamily: theme.fontFamily,
            }}>
            {enabledBlocks.map((block) => (
              <div key={block.id} className="ce-full-preview-block">
                <div className="ce-full-preview-block-label">
                  <span aria-hidden="true">{BLOCK_META[block.type].emoji}</span>
                  {BLOCK_META[block.type].label}
                </div>
                <BlockPreview block={block} theme={theme} />
              </div>
            ))}
            <div className="ce-preview-footer">
              <span className="ce-preview-footer-brand">
                © 2026 {tenant?.name || "Katalog Toko"} · Didukung oleh <strong>Rentalio</strong>
              </span>
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        title="Template katalog bawaan"
        description="Template hanya mengubah tampilan (tema & susunan blok). Menerapkan template mengisi draf; katalog publik baru berubah setelah kamu menekan “Terbitkan”."
        wide>
        {templateError && <InlineAlert tone="danger">{templateError}</InlineAlert>}
        {templateLoading ? (
          <p className="text-sm text-muted">Memuat template…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted">Belum ada template yang dapat ditampilkan.</p>
        ) : (
          <div className="ce-template-grid">
            {templates.map((template) => {
              const key = template.key ?? template.name ?? "template";
              const isActive = draftMeta.templateKey === key;
              return (
                <div key={key} className="ce-template-card">
                  <div className="ce-template-card-head">
                    <strong>{template.name}</strong>
                    <Badge tone="neutral">{template.blockCount ?? 0} blok</Badge>
                  </div>
                  <p className="text-xs text-muted">{template.description}</p>
                  <div className="ce-template-swatches" aria-hidden="true">
                    <span style={{ background: String(template.theme?.primaryColor ?? "#2f2a24") }} />
                    <span style={{ background: String(template.theme?.accentColor ?? "#a85f3c") }} />
                    <span style={{ background: String(template.theme?.pageBgColor ?? "#f1ede4") }} />
                    <span className="ce-template-font">{String(template.theme?.fontFamily ?? "")}</span>
                  </div>
                  <Button
                    variant={isActive ? "secondary" : "primary"}
                    onClick={() => void applyTemplate(key)}
                    loading={applyingTemplate === key}>
                    {isActive ? "Terapkan ulang" : "Terapkan"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {templateBlocks.length > 0 && (
          <p className="text-xs text-muted">
            {templateBlocks.length} blok tersedia untuk disusun:{" "}
            {templateBlocks.map((block) => block.type).filter(Boolean).join(", ")}.
          </p>
        )}
      </Dialog>
    </div>
  );
}


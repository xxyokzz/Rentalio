/**
 * Skema konfigurasi presentasi katalog (Notion 06 WEB-07, Notion 04).
 *
 * Kontrak bentuknya SAMA dengan konfigurasi editor katalog
 * (`apps/web/src/features/catalog-editor/catalog-editor-page.tsx`) supaya
 * konfigurasi yang sudah disusun di editor bisa langsung disimpan, bukan
 * dipetakan ulang. Contoh: opasitas dikirim 0–100 (bukan 0–1) dan warna boleh
 * `rgba(...)`.
 *
 * Prinsip yang ditegakkan modul ini:
 * - Editor hanya mengubah PRESENTASI. Tidak ada harga, stok, ketersediaan,
 *   booking, pembayaran, permission, maupun entitlement di dalam konfigurasi.
 * - Allowlist komponen dan properti: key/properti yang tidak dikenal DITOLAK,
 *   bukan diam-diam disimpan.
 * - Tidak ada HTML/JavaScript arbitrer. Teks disimpan apa adanya dan dirender
 *   sebagai text node; teks yang memuat tag atau skema berbahaya ditolak.
 * - URL dibatasi `https://`, path internal (`/…`), anchor (`#…`), atau
 *   `mailto:`/`tel:`; video hanya dari host YouTube/Vimeo.
 * - Nilai keluaran validator adalah SATU-SATUNYA bentuk yang disimpan, jadi
 *   properti di luar allowlist tidak pernah masuk database.
 */

export const CATALOG_SCHEMA_VERSION = 1;

/** Batas ukuran konfigurasi (JSON ternormalisasi) — 64 KiB. */
export const MAX_CONFIG_BYTES = 64 * 1024;

/** Batas jumlah blok per konfigurasi. */
export const MAX_BLOCKS = 30;

/** Batas jumlah item di dalam satu list (mis. FAQ, testimoni, statistik). */
export const MAX_LIST_ITEMS = 20;

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB_COLOR_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/;
const FONT_FAMILY_RE = /^[A-Za-z0-9 ,_-]{1,60}$/;
const SAFE_URL_RE = /^(?:https:\/\/[^\s"'<>\\]+|\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*|#[A-Za-z0-9._-]{1,40}|mailto:[^\s"'<>@]+@[^\s"'<>@]+|tel:[+0-9][0-9\s()-]{5,29})$/;
const DANGEROUS_CONTENT_RE =
  /<\s*\/?\s*(?:script|iframe|object|embed|style|link|meta|base|svg|img)\b|javascript\s*:|data\s*:\s*text\/html|expression\s*\(/i;
const PHONE_RE = /^[+0-9][0-9\s()-]{5,29}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Host yang diizinkan untuk `video_embed.embedUrl`. */
export const ALLOWED_EMBED_HOSTS = [
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
  'vimeo.com',
] as const;

export interface CatalogValidationIssue {
  path: string;
  message: string;
}

export interface CatalogConfigValue {
  theme: Record<string, unknown>;
  branding: Record<string, unknown>;
  blocks: Array<{ id: string; type: string; enabled: boolean; config: Record<string, unknown> }>;
}

export interface CatalogValidationResult {
  ok: boolean;
  errors: CatalogValidationIssue[];
  /** Ada hanya bila `ok` — bentuk ternormalisasi yang boleh disimpan. */
  value?: CatalogConfigValue;
}

type FieldRule =
  | { kind: 'text'; max: number }
  | { kind: 'font' }
  | { kind: 'color' }
  | { kind: 'url' }
  | { kind: 'embedUrl' }
  | { kind: 'phone' }
  | { kind: 'email' }
  | { kind: 'bool' }
  | { kind: 'number'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'list'; max?: number; fields: Record<string, FieldRule> };

/** Rentang opasitas di UI editor: 0–100 (%). */
const OPACITY: FieldRule = { kind: 'number', min: 0, max: 100 };
/** Rentang blur di UI editor: 0–40 px. */
const BLUR: FieldRule = { kind: 'number', min: 0, max: 40 };

interface BlockRule {
  label: string;
  emoji: string;
  description: string;
  category: 'main' | 'promo' | 'social' | 'media';
  fields: Record<string, FieldRule>;
}

/** Blok yang diizinkan beserta propertinya (allowlist tertutup). */
export const CATALOG_BLOCKS: Record<string, BlockRule> = {
  hero: {
    label: 'Hero / Banner Utama',
    emoji: '🖼️',
    category: 'main',
    description: 'Judul besar, subjudul, gambar latar & tombol CTA',
    fields: {
      heading: { kind: 'text', max: 160 },
      subheading: { kind: 'text', max: 400 },
      ctaLabel: { kind: 'text', max: 60 },
      ctaLink: { kind: 'url' },
      bgColor: { kind: 'color' },
      bgImageUrl: { kind: 'url' },
      overlayOpacity: OPACITY,
      textAlign: { kind: 'enum', values: ['left', 'center', 'right'] },
      heightSize: { kind: 'enum', values: ['sm', 'md', 'lg'] },
      showCta: { kind: 'bool' },
      bgBlur: BLUR,
      bgOpacity: OPACITY,
      glassCard: { kind: 'bool' },
      cardBlur: BLUR,
      cardOpacity: OPACITY,
    },
  },
  categories: {
    label: 'Kategori Produk',
    emoji: '🏷️',
    category: 'main',
    description: 'Grid atau chip kategori untuk filter produk',
    fields: {
      style: { kind: 'enum', values: ['chips', 'grid', 'list'] },
      showCount: { kind: 'bool' },
      bgColor: { kind: 'color' },
    },
  },
  featured: {
    label: 'Produk Unggulan',
    emoji: '📦',
    category: 'main',
    description: 'Daftar produk pilihan dengan kontrol kolom & gaya kartu',
    fields: {
      columns: { kind: 'number', min: 2, max: 4 },
      cardStyle: { kind: 'enum', values: ['minimal', 'bordered', 'shadow', 'glass', 'translucent'] },
      showPrice: { kind: 'bool' },
      showCategory: { kind: 'bool' },
      limit: { kind: 'number', min: 1, max: 24 },
      bgColor: { kind: 'color' },
      cardOpacity: OPACITY,
      cardBlur: BLUR,
    },
  },
  promo_banner: {
    label: 'Banner Promosi',
    emoji: '🎉',
    category: 'promo',
    description: 'Strip promo berwarna dengan emoji, teks & tombol CTA',
    fields: {
      title: { kind: 'text', max: 160 },
      body: { kind: 'text', max: 400 },
      emoji: { kind: 'text', max: 8 },
      ctaLabel: { kind: 'text', max: 60 },
      ctaLink: { kind: 'url' },
      bgColor: { kind: 'color' },
      textColor: { kind: 'color' },
      textAlign: { kind: 'enum', values: ['left', 'center'] },
      showCta: { kind: 'bool' },
      bgOpacity: OPACITY,
      backdropBlur: BLUR,
      glassEffect: { kind: 'bool' },
    },
  },
  testimonials: {
    label: 'Testimoni Pelanggan',
    emoji: '💬',
    category: 'social',
    description: 'Kutipan pelanggan, rating bintang, layout stack/grid',
    fields: {
      items: {
        kind: 'list',
        fields: {
          name: { kind: 'text', max: 120 },
          quote: { kind: 'text', max: 600 },
          rating: { kind: 'number', min: 0, max: 5 },
        },
      },
      showStars: { kind: 'bool' },
      layout: { kind: 'enum', values: ['stack', 'grid'] },
      bgColor: { kind: 'color' },
      glassCards: { kind: 'bool' },
      cardOpacity: OPACITY,
      cardBlur: BLUR,
    },
  },
  faq: {
    label: 'FAQ / Tanya Jawab',
    emoji: '❓',
    category: 'social',
    description: 'Pertanyaan & jawaban umum, gaya accordion/flat',
    fields: {
      items: {
        kind: 'list',
        fields: {
          q: { kind: 'text', max: 240 },
          a: { kind: 'text', max: 1200 },
        },
      },
      style: { kind: 'enum', values: ['accordion', 'flat'] },
      bgColor: { kind: 'color' },
      glassEffect: { kind: 'bool' },
      bgOpacity: OPACITY,
      backdropBlur: BLUR,
    },
  },
  how_to_book: {
    label: 'Cara Booking',
    emoji: '📋',
    category: 'social',
    description: 'Langkah-langkah panduan cara memesan barang',
    fields: {
      heading: { kind: 'text', max: 160 },
      bgColor: { kind: 'color' },
      steps: {
        kind: 'list',
        fields: {
          title: { kind: 'text', max: 120 },
          description: { kind: 'text', max: 400 },
        },
      },
    },
  },
  contact_strip: {
    label: 'Strip Kontak / WhatsApp',
    emoji: '📞',
    category: 'media',
    description: 'Tombol kontak & WhatsApp, warna & label kustom',
    fields: {
      label: { kind: 'text', max: 160 },
      ctaLabel: { kind: 'text', max: 60 },
      bgColor: { kind: 'color' },
      textColor: { kind: 'color' },
      glassEffect: { kind: 'bool' },
      bgOpacity: OPACITY,
      backdropBlur: BLUR,
    },
  },
  stats_bar: {
    label: 'Statistik Toko',
    emoji: '📊',
    category: 'social',
    description: '3–4 angka kunci: pelanggan, produk sewa, rating',
    fields: {
      stats: {
        kind: 'list',
        max: 8,
        fields: {
          value: { kind: 'text', max: 40 },
          label: { kind: 'text', max: 80 },
          emoji: { kind: 'text', max: 8 },
        },
      },
      bgColor: { kind: 'color' },
      textColor: { kind: 'color' },
      layout: { kind: 'enum', values: ['row', 'grid'] },
      glassEffect: { kind: 'bool' },
      bgOpacity: OPACITY,
      backdropBlur: BLUR,
    },
  },
  image_banner: {
    label: 'Banner Gambar Besar',
    emoji: '🖼',
    category: 'promo',
    description: 'Gambar full-width dengan link & teks overlay',
    fields: {
      imageUrl: { kind: 'url' },
      altText: { kind: 'text', max: 200 },
      linkUrl: { kind: 'url' },
      height: { kind: 'enum', values: ['sm', 'md', 'lg'] },
      objectFit: { kind: 'enum', values: ['cover', 'contain'] },
      overlayText: { kind: 'text', max: 200 },
      overlayColor: { kind: 'color' },
      blurAmount: BLUR,
      overlayOpacity: OPACITY,
      overlayBlur: BLUR,
    },
  },
  rich_text: {
    label: 'Teks Kustom / Cerita',
    emoji: '📝',
    category: 'promo',
    description: 'Blok teks bebas: pengantar, cerita brand, info penting',
    fields: {
      content: { kind: 'text', max: 4000 },
      bgColor: { kind: 'color' },
      textColor: { kind: 'color' },
      textAlign: { kind: 'enum', values: ['left', 'center', 'right'] },
      maxWidth: { kind: 'enum', values: ['narrow', 'normal', 'wide'] },
      glassCard: { kind: 'bool' },
      bgOpacity: OPACITY,
      backdropBlur: BLUR,
    },
  },
  video_embed: {
    label: 'Embed Video Toko',
    emoji: '▶️',
    category: 'media',
    description: 'Tempelkan video YouTube atau Vimeo profil toko',
    fields: {
      embedUrl: { kind: 'embedUrl' },
      title: { kind: 'text', max: 160 },
      aspectRatio: { kind: 'enum', values: ['16/9', '4/3', '1/1'] },
      bgColor: { kind: 'color' },
    },
  },
  social_links: {
    label: 'Tautan Sosial Media',
    emoji: '🔗',
    category: 'media',
    description: 'Ikon / tombol Instagram, TikTok, Facebook, dll',
    fields: {
      instagram: { kind: 'url' },
      facebook: { kind: 'url' },
      tiktok: { kind: 'url' },
      twitter: { kind: 'url' },
      youtube: { kind: 'url' },
      bgColor: { kind: 'color' },
      textColor: { kind: 'color' },
      style: { kind: 'enum', values: ['icons', 'buttons'] },
      label: { kind: 'text', max: 120 },
    },
  },
  spacer: {
    label: 'Spasi Pemisah',
    emoji: '↕️',
    category: 'main',
    description: 'Pemisah vertikal antar blok komponen',
    fields: {
      height: { kind: 'enum', values: ['xs', 'sm', 'md', 'lg', 'xl'] },
      bgColor: { kind: 'color' },
    },
  },
};

/** Urutan blok default pada konfigurasi kosong. */
export const DEFAULT_BLOCK_ORDER: readonly string[] = [
  'hero',
  'categories',
  'featured',
  'how_to_book',
  'contact_strip',
];

const THEME_FIELDS: Record<string, FieldRule> = {
  primaryColor: { kind: 'color' },
  accentColor: { kind: 'color' },
  pageBgColor: { kind: 'color' },
  fontFamily: { kind: 'font' },
  buttonStyle: { kind: 'enum', values: ['rounded', 'pill', 'square'] },
  cardRadius: { kind: 'enum', values: ['none', 'sm', 'md', 'lg'] },
  glassmorphism: { kind: 'bool' },
  cardOpacity: OPACITY,
  backdropBlur: BLUR,
  glassBorder: { kind: 'enum', values: ['subtle', 'bold', 'glow', 'none'] },
};

const BRANDING_FIELDS: Record<string, FieldRule> = {
  businessName: { kind: 'text', max: 120 },
  tagline: { kind: 'text', max: 200 },
  description: { kind: 'text', max: 2000 },
  logoUrl: { kind: 'url' },
  bannerUrl: { kind: 'url' },
  whatsappNumber: { kind: 'phone' },
  email: { kind: 'email' },
  address: { kind: 'text', max: 300 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Normalizer {
  readonly errors: CatalogValidationIssue[] = [];

  fields(
    input: unknown,
    rules: Record<string, FieldRule>,
    path: string,
  ): Record<string, unknown> | undefined {
    if (input === undefined || input === null) return {};
    if (!isPlainObject(input)) {
      this.fail(path, 'Harus berupa objek.');
      return undefined;
    }

    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input)) {
      const rule = rules[key];
      if (!rule) {
        this.fail(`${path}.${key}`, 'Properti tidak dikenal (di luar allowlist).');
        continue;
      }
      // String kosong = "belum diisi" di editor, bukan nilai; dibiarkan kosong.
      if (raw === undefined || raw === null || raw === '') continue;
      const value = this.field(raw, rule, `${path}.${key}`);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  private fail(path: string, message: string): undefined {
    if (this.errors.length < 50) this.errors.push({ path, message });
    return undefined;
  }

  private text(raw: unknown, max: number, path: string): string | undefined {
    if (typeof raw !== 'string') return this.fail(path, 'Harus berupa teks.');
    const text = raw.trim();
    if (!text) return undefined;
    if (text.length > max) return this.fail(path, `Teks melebihi ${max} karakter.`);
    if (DANGEROUS_CONTENT_RE.test(text)) {
      return this.fail(path, 'Teks memuat tag atau skema yang tidak diizinkan.');
    }
    return text;
  }

  private field(raw: unknown, rule: FieldRule, path: string): unknown {
    switch (rule.kind) {
      case 'text':
        return this.text(raw, rule.max, path);
      case 'font': {
        if (typeof raw !== 'string' || !FONT_FAMILY_RE.test(raw.trim())) {
          return this.fail(path, 'Nama font hanya boleh huruf, angka, spasi, koma, - dan _.');
        }
        return raw.trim();
      }
      case 'color': {
        if (typeof raw !== 'string') return this.fail(path, 'Harus berupa warna.');
        const color = raw.trim();
        if (!HEX_COLOR_RE.test(color) && !RGB_COLOR_RE.test(color)) {
          return this.fail(path, 'Warna harus #RGB/#RRGGBB atau rgb()/rgba().');
        }
        return color.toLowerCase();
      }
      case 'url':
      case 'embedUrl': {
        if (typeof raw !== 'string') return this.fail(path, 'Harus berupa URL.');
        const url = raw.trim();
        if (!url) return undefined;
        if (url.length > 500) return this.fail(path, 'URL terlalu panjang.');
        if (!SAFE_URL_RE.test(url)) {
          return this.fail(
            path,
            'URL harus https://, path internal (/…), anchor (#…), mailto:, atau tel:.',
          );
        }
        if (rule.kind === 'embedUrl') {
          if (!url.startsWith('https://')) {
            return this.fail(path, 'Video harus memakai URL https:// dari YouTube atau Vimeo.');
          }
          let host = '';
          try {
            host = new URL(url).hostname.toLowerCase();
          } catch {
            return this.fail(path, 'URL video tidak valid.');
          }
          if (!(ALLOWED_EMBED_HOSTS as readonly string[]).includes(host)) {
            return this.fail(path, 'Video hanya dari YouTube atau Vimeo.');
          }
        }
        return url;
      }
      case 'phone': {
        if (typeof raw !== 'string' || !PHONE_RE.test(raw.trim())) {
          return this.fail(path, 'Nomor telepon/WhatsApp tidak valid.');
        }
        return raw.trim();
      }
      case 'email': {
        if (typeof raw !== 'string' || !EMAIL_RE.test(raw.trim())) {
          return this.fail(path, 'Alamat email tidak valid.');
        }
        return raw.trim();
      }
      case 'bool': {
        if (typeof raw !== 'boolean') return this.fail(path, 'Harus boolean.');
        return raw;
      }
      case 'number': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          return this.fail(path, 'Harus berupa angka.');
        }
        if (raw < rule.min || raw > rule.max) {
          return this.fail(path, `Nilai harus antara ${rule.min} dan ${rule.max}.`);
        }
        return raw;
      }
      case 'enum': {
        if (typeof raw !== 'string' || !rule.values.includes(raw)) {
          return this.fail(path, `Nilai harus salah satu dari: ${rule.values.join(', ')}.`);
        }
        return raw;
      }
      case 'list': {
        if (!Array.isArray(raw)) return this.fail(path, 'Harus berupa daftar.');
        const max = rule.max ?? MAX_LIST_ITEMS;
        if (raw.length > max) return this.fail(path, `Daftar maksimal ${max} item.`);
        const items: Array<Record<string, unknown>> = [];
        raw.forEach((item, index) => {
          const normalized = this.fields(item, rule.fields, `${path}[${index}]`);
          if (normalized !== undefined) items.push(normalized);
        });
        return items;
      }
      default:
        return this.fail(path, 'Aturan tidak dikenal.');
    }
  }
}

/**
 * Validasi + normalisasi konfigurasi katalog.
 * Keluaran `value` hanya memuat key/properti di allowlist; apa pun yang tidak
 * dikenal menjadi error sehingga tidak pernah tersimpan.
 */
export function validateCatalogConfig(input: unknown): CatalogValidationResult {
  const normalizer = new Normalizer();

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'Konfigurasi harus berupa objek.' }] };
  }

  for (const key of Object.keys(input)) {
    if (!['theme', 'branding', 'blocks'].includes(key)) {
      normalizer.errors.push({
        path: key,
        message: 'Bagian tidak dikenal (hanya theme, branding, blocks).',
      });
    }
  }

  const theme = normalizer.fields(input.theme, THEME_FIELDS, 'theme') ?? {};
  const branding = normalizer.fields(input.branding, BRANDING_FIELDS, 'branding') ?? {};

  const blocks: CatalogConfigValue['blocks'] = [];
  const rawBlocks = input.blocks;
  if (rawBlocks !== undefined && rawBlocks !== null) {
    if (!Array.isArray(rawBlocks)) {
      normalizer.errors.push({ path: 'blocks', message: 'Harus berupa daftar blok.' });
    } else if (rawBlocks.length > MAX_BLOCKS) {
      normalizer.errors.push({ path: 'blocks', message: `Maksimal ${MAX_BLOCKS} blok.` });
    } else {
      const seenIds = new Set<string>();
      rawBlocks.forEach((raw, index) => {
        const path = `blocks[${index}]`;
        if (!isPlainObject(raw)) {
          normalizer.errors.push({ path, message: 'Blok harus berupa objek.' });
          return;
        }
        for (const key of Object.keys(raw)) {
          if (!['id', 'type', 'enabled', 'config'].includes(key)) {
            normalizer.errors.push({
              path: `${path}.${key}`,
              message: 'Properti blok tidak dikenal.',
            });
          }
        }
        const type = typeof raw.type === 'string' ? raw.type : '';
        const rule = CATALOG_BLOCKS[type];
        if (!rule) {
          normalizer.errors.push({
            path: `${path}.type`,
            message: `Jenis blok "${type}" tidak ada di allowlist.`,
          });
          return;
        }
        const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `block-${index + 1}`;
        if (id.length > 64) {
          normalizer.errors.push({ path: `${path}.id`, message: 'ID blok maksimal 64 karakter.' });
          return;
        }
        if (seenIds.has(id)) {
          normalizer.errors.push({ path: `${path}.id`, message: 'ID blok harus unik.' });
          return;
        }
        seenIds.add(id);
        const enabled = raw.enabled === undefined ? true : raw.enabled;
        if (typeof enabled !== 'boolean') {
          normalizer.errors.push({ path: `${path}.enabled`, message: 'Harus boolean.' });
          return;
        }
        const config = normalizer.fields(raw.config ?? {}, rule.fields, `${path}.config`) ?? {};
        blocks.push({ id, type, enabled, config });
      });
    }
  }

  if (normalizer.errors.length > 0) {
    return { ok: false, errors: normalizer.errors };
  }

  const value: CatalogConfigValue = { theme, branding, blocks };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CONFIG_BYTES) {
    return { ok: false, errors: [{ path: '', message: 'Konfigurasi melebihi batas 64 KiB.' }] };
  }
  return { ok: true, errors: [], value };
}

/** Daftar blok yang tersedia (untuk galeri blok/fitur editor). */
export function catalogBlockCatalog(): Array<{
  type: string;
  label: string;
  emoji: string;
  description: string;
  category: string;
  fields: string[];
}> {
  return Object.entries(CATALOG_BLOCKS).map(([type, rule]) => ({
    type,
    label: rule.label,
    emoji: rule.emoji,
    description: rule.description,
    category: rule.category,
    fields: Object.keys(rule.fields),
  }));
}

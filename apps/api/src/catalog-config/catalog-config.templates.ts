/**
 * Galeri template katalog bawaan (Notion 06 WEB-07).
 *
 * Template hanya mengatur PRESENTASI (tema + susunan blok + isi contoh), tidak
 * pernah menyentuh harga, stok, ketersediaan, maupun data transaksi. Semua
 * template di sini wajib lolos `validateCatalogConfig` — diuji di
 * `apps/api/test/integration/catalog-config.integration.test.ts`.
 *
 * Bentuk konfigurasi mengikuti editor katalog (`catalog-editor-page.tsx`):
 * warna boleh `rgba(...)`, opasitas 0–100, blur 0–40.
 */

export type TemplateCategory = 'umum' | 'retail' | 'kreatif' | 'event' | 'outdoor' | 'proyek';

export interface CatalogTemplate {
  key: string;
  name: string;
  description: string;
  category: TemplateCategory;
  theme: Record<string, unknown>;
  blocks: Array<{ id: string; type: string; enabled: boolean; config: Record<string, unknown> }>;
}

type BlockInput = { type: string; enabled?: boolean; config?: Record<string, unknown> };

function template(
  key: string,
  name: string,
  description: string,
  category: TemplateCategory,
  theme: Record<string, unknown>,
  blocks: BlockInput[],
): CatalogTemplate {
  return {
    key,
    name,
    description,
    category,
    theme,
    blocks: blocks.map((block, index) => ({
      id: `${block.type}-${index + 1}`,
      type: block.type,
      enabled: block.enabled ?? true,
      config: block.config ?? {},
    })),
  };
}

export const CATALOG_TEMPLATES: readonly CatalogTemplate[] = [
  template(
    'klasik-hangat',
    'Klasik Hangat',
    'Nuansa krem hangat dengan blok lengkap: hero, kategori, produk unggulan, cara booking, dan kontak.',
    'umum',
    {
      primaryColor: '#2f2a24',
      accentColor: '#a85f3c',
      pageBgColor: '#f1ede4',
      fontFamily: 'Inter Variable',
      buttonStyle: 'rounded',
      cardRadius: 'md',
      glassmorphism: false,
      cardOpacity: 100,
      backdropBlur: 0,
      glassBorder: 'none',
    },
    [
      {
        type: 'hero',
        config: {
          heading: 'Sewa barang pilihan, mudah & cepat',
          subheading: 'Cek ketersediaan dan booking online langsung dari sini.',
          ctaLabel: 'Lihat Produk',
          ctaLink: '#produk',
          bgColor: '#2f2a24',
          overlayOpacity: 60,
          textAlign: 'center',
          heightSize: 'md',
          showCta: true,
        },
      },
      { type: 'categories', config: { style: 'chips', showCount: true } },
      {
        type: 'featured',
        config: { columns: 3, cardStyle: 'bordered', showPrice: true, showCategory: true, limit: 6 },
      },
      {
        type: 'rich_text',
        config: {
          content:
            'Kami melayani penyewaan harian dan mingguan dengan barang yang selalu dirawat dan siap pakai.',
          textAlign: 'center',
          maxWidth: 'normal',
        },
      },
      { type: 'how_to_book', config: { heading: 'Cara booking dalam 3 langkah' } },
      {
        type: 'faq',
        config: {
          style: 'accordion',
          items: [
            { q: 'Bagaimana cara booking?', a: 'Pilih produk, tentukan tanggal, lalu ajukan booking melalui halaman ini.' },
            { q: 'Apakah bisa bayar di tempat?', a: 'Ya. Metode pembayaran dikonfirmasi admin setelah booking disetujui.' },
          ],
        },
      },
      { type: 'contact_strip', config: { label: 'Butuh bantuan? Hubungi kami langsung!', ctaLabel: 'Tanya via WhatsApp' } },
    ],
  ),
  template(
    'glass-minimalis',
    'Glass Minimalis',
    'Tampilan frosted glass halus dengan tipografi ringan, cocok untuk brand modern.',
    'retail',
    {
      primaryColor: '#1f2430',
      accentColor: '#4f7cff',
      pageBgColor: '#eef2f9',
      fontFamily: 'Poppins',
      buttonStyle: 'pill',
      cardRadius: 'lg',
      glassmorphism: true,
      cardOpacity: 85,
      backdropBlur: 10,
      glassBorder: 'subtle',
    },
    [
      {
        type: 'hero',
        config: {
          heading: 'Ruang sewa, tampil lebih rapi',
          subheading: 'Katalog transparan, harga jelas, proses cepat.',
          ctaLabel: 'Mulai Cari',
          ctaLink: '#produk',
          bgColor: '#1f2430',
          overlayOpacity: 45,
          textAlign: 'left',
          heightSize: 'lg',
          showCta: true,
          glassCard: true,
          cardBlur: 12,
          cardOpacity: 85,
        },
      },
      { type: 'categories', config: { style: 'grid', showCount: false } },
      {
        type: 'featured',
        config: {
          columns: 3,
          cardStyle: 'glass',
          showPrice: true,
          showCategory: true,
          limit: 6,
          cardOpacity: 80,
          cardBlur: 10,
        },
      },
      {
        type: 'stats_bar',
        config: {
          layout: 'row',
          glassEffect: true,
          bgOpacity: 70,
          backdropBlur: 12,
          stats: [
            { value: '500+', label: 'Pelanggan puas', emoji: '🤝' },
            { value: '100+', label: 'Produk sewa', emoji: '📦' },
            { value: '4.9', label: 'Rating rata-rata', emoji: '⭐' },
          ],
        },
      },
      { type: 'how_to_book', config: { heading: 'Alur sewa yang simpel' } },
      { type: 'testimonials', config: { layout: 'grid', showStars: true, glassCards: true, cardOpacity: 80, cardBlur: 10 } },
      { type: 'contact_strip', config: { label: 'Ada pertanyaan? Tim kami siap membantu.', ctaLabel: 'Hubungi Kami', glassEffect: true, bgOpacity: 80, backdropBlur: 10 } },
    ],
  ),
  template(
    'elektronik-modern',
    'Elektronik Modern',
    'Kontras gelap-tegas untuk gadget dan alat elektronik, menonjolkan spesifikasi dan harga.',
    'retail',
    {
      primaryColor: '#0f1720',
      accentColor: '#00b8a9',
      pageBgColor: '#f4f7f8',
      fontFamily: 'Roboto',
      buttonStyle: 'square',
      cardRadius: 'sm',
      glassmorphism: false,
      cardOpacity: 100,
      backdropBlur: 0,
      glassBorder: 'none',
    },
    [
      {
        type: 'hero',
        config: {
          heading: 'Gadget siap pakai, garansi jelas',
          subheading: 'Unit diuji sebelum diserahkan dan dicek kembali saat pengembalian.',
          ctaLabel: 'Cek Unit',
          ctaLink: '#produk',
          bgColor: '#0f1720',
          overlayOpacity: 70,
          textAlign: 'center',
          heightSize: 'md',
          showCta: true,
        },
      },
      { type: 'featured', config: { columns: 4, cardStyle: 'shadow', showPrice: true, showCategory: true, limit: 8 } },
      { type: 'categories', config: { style: 'chips', showCount: true } },
      {
        type: 'rich_text',
        config: { content: 'Semua unit dicek fungsi dan kelengkapan aksesori sebelum diserahkan.', maxWidth: 'normal' },
      },
      {
        type: 'video_embed',
        config: { embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ', title: 'Cara pakai unit', aspectRatio: '16/9' },
      },
      {
        type: 'faq',
        config: {
          style: 'flat',
          items: [
            { q: 'Apakah termasuk charger?', a: 'Kelengkapan tercantum pada deskripsi tiap unit.' },
            { q: 'Bagaimana kalau unit rusak?', a: 'Pemeriksaan kondisi dilakukan bersama saat pengembalian.' },
          ],
        },
      },
      { type: 'contact_strip', config: { label: 'Ingin tanya spesifikasi dulu?', ctaLabel: 'Tanya via WhatsApp' } },
    ],
  ),
  template(
    'foto-kreatif',
    'Fotografi Kreatif',
    'Gelap sinematik dengan banner besar untuk kamera, lensa, dan alat produksi konten.',
    'kreatif',
    {
      primaryColor: '#161412',
      accentColor: '#e0a458',
      pageBgColor: '#f7f3ec',
      fontFamily: 'Playfair Display',
      buttonStyle: 'rounded',
      cardRadius: 'md',
      glassmorphism: true,
      cardOpacity: 65,
      backdropBlur: 20,
      glassBorder: 'glow',
    },
    [
      {
        type: 'hero',
        config: {
          heading: 'Lengkapi produksi kontenmu',
          subheading: 'Kamera, lensa, lighting, dan audio untuk harian maupun proyek.',
          ctaLabel: 'Lihat Koleksi',
          ctaLink: '#produk',
          bgColor: '#161412',
          overlayOpacity: 75,
          textAlign: 'center',
          heightSize: 'lg',
          showCta: true,
        },
      },
      {
        type: 'image_banner',
        config: { imageUrl: '', altText: 'Koleksi kamera kami', height: 'md', objectFit: 'cover', overlayColor: 'rgba(0,0,0,0.3)' },
      },
      { type: 'featured', config: { columns: 3, cardStyle: 'glass', showPrice: true, showCategory: true, limit: 6, cardOpacity: 70, cardBlur: 14 } },
      { type: 'testimonials', config: { layout: 'stack', showStars: true, glassCards: true, cardOpacity: 70, cardBlur: 14 } },
      { type: 'social_links', config: { style: 'icons', label: 'Lihat hasil karya kami', instagram: 'https://instagram.com/', tiktok: 'https://www.tiktok.com/' } },
      { type: 'contact_strip', config: { label: 'Butuh paket lengkap?', ctaLabel: 'Konsultasi Gratis', glassEffect: true, bgOpacity: 75, backdropBlur: 14 } },
    ],
  ),
  template(
    'pesta-event',
    'Sewa Pesta & Event',
    'Ceria dan mencolok untuk tenda, kursi, dekorasi, dan perlengkapan acara.',
    'event',
    {
      primaryColor: '#3a1d4f',
      accentColor: '#e8455e',
      pageBgColor: '#fdf3f6',
      fontFamily: 'Montserrat',
      buttonStyle: 'pill',
      cardRadius: 'lg',
      glassmorphism: false,
      cardOpacity: 100,
      backdropBlur: 0,
      glassBorder: 'none',
    },
    [
      {
        type: 'hero',
        config: {
          heading: 'Semua kebutuhan acara, satu tempat',
          subheading: 'Tenda, kursi, dekorasi, dan sound system siap antar.',
          ctaLabel: 'Pesan Sekarang',
          ctaLink: '#produk',
          bgColor: '#3a1d4f',
          overlayOpacity: 55,
          textAlign: 'center',
          heightSize: 'md',
          showCta: true,
        },
      },
      {
        type: 'promo_banner',
        config: {
          title: 'Promo paket hemat akhir pekan',
          body: 'Sewa 3 item sekaligus, dapat potongan biaya antar.',
          emoji: '🎉',
          ctaLabel: 'Hubungi Kami',
          bgColor: '#e8455e',
          textColor: '#fffdf9',
          textAlign: 'center',
          showCta: true,
        },
      },
      { type: 'categories', config: { style: 'grid', showCount: true } },
      { type: 'featured', config: { columns: 3, cardStyle: 'bordered', showPrice: true, showCategory: true, limit: 6 } },
      {
        type: 'stats_bar',
        config: {
          layout: 'grid',
          stats: [
            { value: '250+', label: 'Acara terlayani', emoji: '🎊' },
            { value: '40', label: 'Kota jangkauan', emoji: '🚚' },
            { value: '4.8', label: 'Rating pelanggan', emoji: '⭐' },
          ],
        },
      },
      { type: 'faq', config: { style: 'accordion', items: [{ q: 'Berapa minimal order?', a: 'Minimal 1 hari sewa dengan biaya antar sesuai jarak.' }] } },
      { type: 'contact_strip', config: { label: 'Rencanakan acaramu bersama kami.', ctaLabel: 'Chat via WhatsApp', bgColor: '#f6e7db' } },
    ],
  ),
  template(
    'outdoor-alam',
    'Outdoor & Alam',
    'Segar dan lapang untuk alat camping, sepeda, dan kegiatan luar ruang.',
    'outdoor',
    {
      primaryColor: '#1d3b2a',
      accentColor: '#4f8f4a',
      pageBgColor: '#f0f6ef',
      fontFamily: 'Lato',
      buttonStyle: 'rounded',
      cardRadius: 'md',
      glassmorphism: false,
      cardOpacity: 100,
      backdropBlur: 0,
      glassBorder: 'none',
    },
    [
      {
        type: 'hero',
        config: {
          heading: 'Siapkan petualanganmu',
          subheading: 'Tenda, carrier, dan alat outdoor terawat untuk dipakai berkali-kali.',
          ctaLabel: 'Lihat Alat',
          ctaLink: '#produk',
          bgColor: '#1d3b2a',
          overlayOpacity: 60,
          textAlign: 'left',
          heightSize: 'md',
          showCta: true,
        },
      },
      { type: 'categories', config: { style: 'list', showCount: false } },
      { type: 'featured', config: { columns: 3, cardStyle: 'shadow', showPrice: true, showCategory: true, limit: 6 } },
      { type: 'how_to_book', config: { heading: 'Tiga langkah menyewa' } },
      {
        type: 'rich_text',
        config: { content: 'Semua alat dibersihkan dan diperiksa setelah setiap penggunaan.', textAlign: 'left', maxWidth: 'normal' },
      },
      { type: 'contact_strip', config: { label: 'Tanya stok untuk tanggal tertentu.', ctaLabel: 'Tanya via WhatsApp' } },
    ],
  ),
  template(
    'alat-proyek',
    'Alat Proyek & Bangunan',
    'Tegas dan teknis untuk mesin, scaffolding, dan peralatan kerja proyek.',
    'proyek',
    {
      primaryColor: '#1c1c1c',
      accentColor: '#f0a202',
      pageBgColor: '#f5f5f2',
      fontFamily: 'Merriweather',
      buttonStyle: 'square',
      cardRadius: 'none',
      glassmorphism: false,
      cardOpacity: 100,
      backdropBlur: 0,
      glassBorder: 'none',
    },
    [
      {
        type: 'hero',
        config: {
          heading: 'Alat kerja siap proyek',
          subheading: 'Mesin dan peralatan terawat dengan jadwal sewa yang jelas.',
          ctaLabel: 'Cek Alat',
          ctaLink: '#produk',
          bgColor: '#1c1c1c',
          overlayOpacity: 65,
          textAlign: 'left',
          heightSize: 'sm',
          showCta: true,
        },
      },
      { type: 'featured', config: { columns: 4, cardStyle: 'minimal', showPrice: true, showCategory: false, limit: 8 } },
      { type: 'categories', config: { style: 'chips', showCount: true } },
      {
        type: 'stats_bar',
        config: {
          layout: 'row',
          stats: [
            { value: '120+', label: 'Unit alat', emoji: '🛠️' },
            { value: '3 thn', label: 'Pengalaman', emoji: '🏗️' },
            { value: '98%', label: 'Tepat waktu', emoji: '⏱️' },
          ],
        },
      },
      { type: 'faq', config: { style: 'flat', items: [{ q: 'Apakah bisa sewa bulanan?', a: 'Bisa. Hubungi kami untuk skema sewa jangka panjang.' }] } },
      { type: 'contact_strip', config: { label: 'Butuh penawaran proyek?', ctaLabel: 'Minta Penawaran', bgColor: '#f0e3c9' } },
    ],
  ),
  template(
    'fashion-studio',
    'Fashion & Kostum',
    'Elegan untuk sewa busana, kostum panggung, dan aksesori gaya.',
    'kreatif',
    {
      primaryColor: '#2b1b2e',
      accentColor: '#c08497',
      pageBgColor: '#fbf5f7',
      fontFamily: 'Instrument Serif',
      buttonStyle: 'pill',
      cardRadius: 'lg',
      glassmorphism: true,
      cardOpacity: 90,
      backdropBlur: 8,
      glassBorder: 'subtle',
    },
    [
      {
        type: 'hero',
        config: {
          heading: 'Tampil memukau di setiap momen',
          subheading: 'Koleksi busana dan kostum yang selalu bersih dan siap dipakai.',
          ctaLabel: 'Telusuri Koleksi',
          ctaLink: '#produk',
          bgColor: '#2b1b2e',
          overlayOpacity: 50,
          textAlign: 'center',
          heightSize: 'lg',
          showCta: true,
          glassCard: true,
          cardBlur: 10,
          cardOpacity: 88,
        },
      },
      { type: 'featured', config: { columns: 3, cardStyle: 'translucent', showPrice: true, showCategory: true, limit: 6, cardOpacity: 88, cardBlur: 8 } },
      { type: 'categories', config: { style: 'grid', showCount: false } },
      { type: 'testimonials', config: { layout: 'grid', showStars: true, glassCards: true, cardOpacity: 88, cardBlur: 8 } },
      { type: 'social_links', config: { style: 'buttons', label: 'Ikuti koleksi terbaru kami', instagram: 'https://instagram.com/' } },
      { type: 'contact_strip', config: { label: 'Butuh ukuran khusus?', ctaLabel: 'Tanya via WhatsApp', glassEffect: true, bgOpacity: 88, backdropBlur: 8 } },
    ],
  ),
];

/** Template berdasarkan key. */
export function findCatalogTemplate(key: string): CatalogTemplate | undefined {
  return CATALOG_TEMPLATES.find((item) => item.key === key);
}

/** Daftar template tanpa konfigurasi (untuk galeri). */
export function catalogTemplateSummaries(): Array<{
  key: string;
  name: string;
  description: string;
  category: TemplateCategory;
  blockCount: number;
  theme: Record<string, unknown>;
}> {
  return CATALOG_TEMPLATES.map(({ key, name, description, category, theme, blocks }) => ({
    key,
    name,
    description,
    category,
    blockCount: blocks.length,
    theme,
  }));
}

/** Konfigurasi blok default untuk tenant baru (belum memakai template). */
export function defaultCatalogBlocks(): CatalogTemplate['blocks'] {
  const blocks: CatalogTemplate['blocks'] = [
    {
      id: 'hero-1',
      type: 'hero',
      enabled: true,
      config: {
        heading: 'Sewa barang pilihan, mudah & cepat',
        subheading: 'Cek ketersediaan dan booking online langsung dari sini.',
        ctaLabel: 'Lihat Produk',
        ctaLink: '#produk',
        bgColor: '#2f2a24',
        overlayOpacity: 60,
        textAlign: 'center',
        heightSize: 'md',
        showCta: true,
      },
    },
    { id: 'categories-2', type: 'categories', enabled: true, config: { style: 'chips', showCount: false } },
    {
      id: 'featured-3',
      type: 'featured',
      enabled: true,
      config: { columns: 3, cardStyle: 'bordered', showPrice: true, showCategory: true, limit: 6 },
    },
    { id: 'how_to_book-4', type: 'how_to_book', enabled: true, config: {} },
    { id: 'contact_strip-5', type: 'contact_strip', enabled: true, config: { label: 'Butuh bantuan? Hubungi kami langsung!', ctaLabel: 'Tanya via WhatsApp' } },
  ];
  return blocks;
}

/** Tema default untuk tenant baru. */
export const DEFAULT_CATALOG_THEME: Record<string, unknown> = {
  primaryColor: '#2f2a24',
  accentColor: '#a85f3c',
  pageBgColor: '#f1ede4',
  fontFamily: 'Inter Variable',
  buttonStyle: 'rounded',
  cardRadius: 'md',
  glassmorphism: false,
  cardOpacity: 100,
  backdropBlur: 0,
  glassBorder: 'none',
};

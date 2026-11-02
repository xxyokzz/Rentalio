import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PublicCatalogBlocks,
  catalogAccent,
  catalogBlockList,
  catalogPrimary,
  catalogThemeStyle,
  catalogThemeVars,
  isGlassTheme,
  type CatalogBlock,
} from "./public-catalog-blocks";

// Vitest tanpa `globals` tidak memicu auto-cleanup React Testing Library,
// sehingga DOM dibersihkan eksplisit antar test.
afterEach(() => cleanup());

const block = (type: string, config: Record<string, unknown> = {}, enabled = true): CatalogBlock => ({
  id: `${type}-1`,
  type,
  enabled,
  config,
});

describe("catalogBlockList", () => {
  it("membuang blok nonaktif dan bentuk yang tidak dikenal", () => {
    const blocks = catalogBlockList({
      blocks: [
        { id: "a", type: "hero", enabled: true, config: { heading: "Halo" } },
        { id: "b", type: "faq", enabled: false, config: {} },
        { type: "spacer", enabled: true, config: {} },
        { type: "tidak-ada", enabled: true, config: {} },
        "bukan objek",
      ],
    } as never);

    expect(blocks.map((item) => item.type)).toEqual(["hero", "spacer"]);
    // ID hilang diganti agar tetap stabil sebagai key React.
    expect(blocks[1]?.id).toBe("spacer-3");
  });

  it("mengembalikan daftar kosong bila konfigurasi belum termuat", () => {
    expect(catalogBlockList(undefined)).toEqual([]);
    expect(catalogBlockList({} as never)).toEqual([]);
  });
});

describe("tema tenant", () => {
  it("memakai warna aksen tenant dan menolak nilai berbahaya", () => {
    expect(catalogAccent({ accentColor: "#00b8a9" })).toBe("#00b8a9");
    expect(catalogAccent({ accentColor: "rgba(1,2,3,1)" })).toBe("rgba(1,2,3,1)");
    expect(catalogAccent({ accentColor: "javascript:alert(1)" })).toBe("#a85f3c");
    expect(catalogAccent(undefined)).toBe("#a85f3c");
  });

  it("menerapkan latar dan tipografi dari konfigurasi", () => {
    const style = catalogThemeStyle({ pageBgColor: "#f1ede4", fontFamily: "Poppins" });
    expect(style.background).toBe("#f1ede4");
    expect(style.fontFamily).toContain("Poppins");
  });

  it("hanya mengaktifkan gaya kaca bila diminta tenant", () => {
    expect(isGlassTheme({ glassmorphism: true })).toBe(true);
    expect(isGlassTheme({ glassmorphism: false })).toBe(false);
    expect(isGlassTheme(undefined)).toBe(false);
  });

  it("meneruskan radius kartu/tombol dan warna primer sebagai var CSS", () => {
    const vars = catalogThemeVars({
      cardRadius: "lg",
      buttonStyle: "square",
      primaryColor: "#123456",
    }) as unknown as Record<string, string>;

    expect(vars["--pcat-card-radius"]).toBe("14px");
    expect(vars["--pcat-btn-radius"]).toBe("0");
    expect(vars["--pcat-primary"]).toBe("#123456");
    // Kaca mati: var kaca tidak ada sehingga CSS memakai tampilan default.
    expect(vars["--pcat-card-bg"]).toBeUndefined();
    expect(vars["--pcat-card-blur"]).toBeUndefined();
    expect(catalogThemeVars(undefined)).toEqual({});
  });

  it("membawa opasitas, blur, dan border kaca hanya saat glassmorphism aktif", () => {
    const vars = catalogThemeVars({
      glassmorphism: true,
      cardOpacity: 60,
      backdropBlur: 8,
      glassBorder: "glow",
    }) as unknown as Record<string, string>;

    expect(vars["--pcat-card-bg"]).toBe("rgba(255,255,255,0.6)");
    expect(vars["--pcat-card-blur"]).toBe("blur(8px)");
    expect(vars["--pcat-card-border-color"]).toBe("rgba(255,255,255,0.6)");
    expect(vars["--pcat-card-shadow"]).toContain("0 0 12px");
  });

  it("menolak nilai warna primer yang tidak aman", () => {
    expect(catalogPrimary({ primaryColor: "javascript:alert(1)" })).toBe("#2f2a24");
    expect(catalogPrimary(undefined)).toBe("#2f2a24");
  });
});

describe("PublicCatalogBlocks", () => {
  it("merender blok sesuai urutan konfigurasi tenant", () => {
    render(
      <PublicCatalogBlocks
        blocks={[
          block("hero", { heading: "Sewa kamera murah", subheading: "Stok lengkap", ctaLabel: "Pesan", ctaLink: "#produk" }),
          block("promo_banner", { title: "Diskon akhir tahun" }),
        ]}
        tenantName="Toko A"
        renderProducts={() => <p>grid-produk</p>}
      />,
    );

    expect(screen.getByText("Sewa kamera murah")).toBeInTheDocument();
    expect(screen.getByText("Diskon akhir tahun")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pesan" })).toHaveAttribute("href", "#produk");
    // Tanpa blok "featured", grid produk tetap tampil agar booking tetap bisa.
    expect(screen.getByText("grid-produk")).toBeInTheDocument();
  });

  it("memakai slot produk di posisi blok featured", () => {
    render(
      <PublicCatalogBlocks
        blocks={[block("featured", { showPrice: true })]}
        tenantName="Toko A"
        renderProducts={() => <p>grid-produk</p>}
      />,
    );
    expect(screen.getAllByText("grid-produk")).toHaveLength(1);
  });

  it("merender FAQ, statistik, dan mengabaikan tautan berskema berbahaya", () => {
    render(
      <PublicCatalogBlocks
        blocks={[
          block("faq", { style: "flat", items: [{ q: "Bisa sewa harian?", a: "Bisa." }] }),
          block("stats_bar", { stats: [{ value: "500+", label: "Pelanggan" }] }),
          block("hero", { heading: "Judul", ctaLabel: "Klik", ctaLink: "javascript:alert(1)" }),
        ]}
        tenantName="Toko A"
      />,
    );

    expect(screen.getByText("Bisa sewa harian?")).toBeInTheDocument();
    expect(screen.getByText("500+")).toBeInTheDocument();
    // CTA dengan skema berbahaya tidak pernah dirender sebagai tautan.
    expect(screen.queryByRole("link", { name: "Klik" })).toBeNull();
  });

  it("menampilkan teks konfigurasi sebagai teks, bukan HTML", () => {
    const heading = "<b>Gratis</b> sewa pertama";
    render(
      <PublicCatalogBlocks blocks={[block("hero", { heading })]} tenantName="Toko A" />,
    );
    expect(screen.getByText(heading)).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("memasang var tema di pembungkus agar kendali editor berlaku di live", () => {
    render(
      <PublicCatalogBlocks
        blocks={[block("faq", { items: [{ q: "Q?", a: "A." }] })]}
        tenantName="Toko A"
        theme={{ cardRadius: "none", buttonStyle: "pill", glassmorphism: true, cardOpacity: 50 }}
      />,
    );

    const root = document.querySelector(".pcat-blocks") as HTMLElement;
    expect(root.style.getPropertyValue("--pcat-card-radius")).toBe("0");
    expect(root.style.getPropertyValue("--pcat-btn-radius")).toBe("999px");
    expect(root.style.getPropertyValue("--pcat-card-bg")).toBe("rgba(255,255,255,0.5)");
  });

  it("memakai warna primer tenant sebagai latar hero bila blok tidak menentukan warna", () => {
    render(
      <PublicCatalogBlocks
        blocks={[block("hero", { heading: "Judul" })]}
        tenantName="Toko A"
        theme={{ primaryColor: "#123456" }}
      />,
    );

    const hero = document.querySelector(".pcat-hero") as HTMLElement;
    expect(hero.style.backgroundColor).toBe("rgb(18, 52, 86)");
  });
});

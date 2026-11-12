import { expect, test } from "@playwright/test";
import path from "node:path";

// Sesi hasil project "setup" (login sekali per suite) — lihat e2e/auth.setup.ts.
const AUTH_STATE = path.join(__dirname, ".auth", "state.json");

test.describe("Audit Menyeluruh Fitur Rentalio End-to-End", () => {
  test.use({ viewport: { width: 1280, height: 800 }, storageState: AUTH_STATE });

  test("Menjalankan tur audit lengkap satu per satu untuk semua fitur Rentalio", async ({ page }, testInfo) => {
    test.setTimeout(90000);

    // 1. RINGKASAN (sesi tersimpan; form login diuji di e2e/login-form.spec.ts)
    console.log("--> 1. Membuka Ringkasan dengan sesi tersimpan...");
    await page.goto("/app");
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_03_dashboard.png"), fullPage: true });

    // Nama tenant tidak di-hardcode agar spec bisa dijalankan pada seed lokal
    // maupun staging dengan tenant berbeda.
    const tenantName = page.locator(".tenant-name");
    await expect(tenantName).toBeVisible();
    await expect(tenantName).not.toHaveText(/Memuat tenant/);
    // Status langganan bukan fixture tetap: tenant demo bisa masih trial,
    // trial habis (mode terbatas), atau sudah berlangganan. Yang diuji adalah
    // sidebar menampilkan salah satu status yang dikenal — bukan nilai tertentu.
    await expect(page.locator(".tenant-state")).toHaveText(
      /Coba gratis \d+ hari lagi|Masa coba habis hari ini|Paket aktif|Toko ditangguhkan/,
    );
    await expect(page.getByRole("link", { name: "Kasir (POS)" }).first()).toBeVisible();

    // 2. INVENTARIS
    console.log("--> 2. Mengaudit Modul Inventaris & Produk...");
    await page.getByRole("link", { name: "Inventaris" }).first().click();
    await page.waitForURL(/\/app\/inventory/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_04_inventory.png"), fullPage: true });

    await expect(page.getByText("Canon EOS R50")).toBeVisible();
    await expect(page.getByText("DJI Mic 2")).toBeVisible();
    await expect(page.getByText("Sony A7 III")).toBeVisible();

    // 3. DETAIL PRODUK & ASET
    console.log("--> 3. Memeriksa Detail Produk & Unit Fisik Aset...");
    await page.getByRole("link", { name: "Detail" }).first().click();
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_05_product_detail.png"), fullPage: true });

    // 4. KATEGORI PRODUK
    console.log("--> 4. Mengaudit Modul Kategori Produk...");
    await page.getByRole("link", { name: "Kategori" }).first().click();
    await page.waitForURL(/\/app\/categories/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_06_categories.png"), fullPage: true });

    await expect(page.getByText("Kamera").first()).toBeVisible();
    await expect(page.getByText("Audio & Aksesori").first()).toBeVisible();

    // 5. PESANAN / ORDERS
    console.log("--> 5. Mengaudit Modul Pesanan (Orders)...");
    await page.getByRole("link", { name: "Pesanan" }).first().click();
    await page.waitForURL(/\/app\/orders/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_07_orders.png"), fullPage: true });

    // 6. POS (KASIR LANGSUNG)
    console.log("--> 6. Mengaudit Modul Kasir (POS)...");
    await page.getByRole("link", { name: "Kasir (POS)" }).first().click();
    await page.waitForURL(/\/app\/pos/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_08_pos.png"), fullPage: true });

    // 7. PENGEMBALIAN & INSPEKSI
    console.log("--> 7. Mengaudit Modul Pengembalian (Returns)...");
    await page.getByRole("link", { name: "Pengembalian" }).first().click();
    await page.waitForURL(/\/app\/returns/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_09_returns.png"), fullPage: true });

    // 8. REKAP OPERASIONAL & LAPORAN
    console.log("--> 8. Mengaudit Modul Rekap & Laporan...");
    await page.getByRole("link", { name: "Rekap operasional" }).first().click();
    await page.waitForURL(/\/app\/reports/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_10_reports.png"), fullPage: true });

    // 9. PENGATURAN USAHA
    console.log("--> 9. Mengaudit Pengaturan Usaha / Tenant...");
    await page.getByRole("link", { name: /Pengaturan (usaha|toko)/ }).first().click();
    await page.waitForURL(/\/app\/settings/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_11_settings_business.png"), fullPage: true });

    // 10. PENGATURAN METODE PEMBAYARAN
    console.log("--> 10. Mengaudit Pengaturan Metode Pembayaran...");
    await page.getByRole("link", { name: "Metode pembayaran" }).first().click();
    await page.waitForURL(/\/app\/settings\/payment-methods/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_12_settings_payments.png"), fullPage: true });

    // 11. TEMPLATE WHATSAPP
    console.log("--> 11. Mengaudit Modul Template WhatsApp...");
    await page.getByRole("link", { name: "Template WhatsApp" }).first().click();
    await page.waitForURL(/\/app\/settings\/whatsapp-templates/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_13_settings_whatsapp.png"), fullPage: true });

    // 12. STAF & HAK AKSES
    console.log("--> 12. Mengaudit Modul Staf & Hak Akses...");
    await page.getByRole("link", { name: /(Staf & akses|Tim & hak akses)/ }).first().click();
    await page.waitForURL(/\/app\/settings\/staff/);
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_14_settings_staff.png"), fullPage: true });

    // 13. KATALOG PUBLIK
    console.log("--> 13. Mengaudit Katalog Publik Pelanggan...");
    await page.goto("/katalog");
    await page.waitForLoadState("load");
    await page.screenshot({ path: testInfo.outputPath("audit_15_public_catalog.png"), fullPage: true });

    console.log("==> Seluruh 13 titik audit berhasil diuji dan didokumentasikan!");
  });
});

import { expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

const ARTIFACT_DIR = "C:/Users/LENOVO/.gemini/antigravity-ide/brain/fd8b1bef-d3d0-4cac-a7ac-16ac46b8aa6f";
// Sesi hasil project "setup" (login sekali per suite) — lihat e2e/auth.setup.ts.
const AUTH_STATE = path.join(__dirname, ".auth", "state.json");

test.describe.configure({ mode: "serial" });

let sharedContext: BrowserContext;

test.describe("Audit E2E Halaman Lihat & Kustomisasi Katalog", () => {
  test.use({ viewport: { width: 1440, height: 900 }, storageState: AUTH_STATE });

  /* ── SETUP: pakai sesi bersama, tanpa login ulang per project ── */
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120000);
    sharedContext = await browser.newContext({
      storageState: AUTH_STATE,
      viewport: { width: 1440, height: 900 },
    });
    console.log("==> Auth context siap untuk 12 test (storageState)");
  });

  test.afterAll(async () => {
    await sharedContext?.close().catch(() => {});
  });

  /* Helper: buka halaman catalog editor dengan sesi yang sudah ada */
  async function openEditor() {
    const page = await sharedContext.newPage();
    await page.goto("http://localhost:3001/app/catalog-editor", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    return page;
  }

  /* ── 1. HEADER & ELEMEN UTAMA ── */
  test("1. Header dan elemen utama halaman", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15000 });
      await expect(page.locator("#ce-btn-view-toggle")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("#ce-btn-save")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_01_header.png") });
      console.log("1 PASS: Header OK");
    } finally {
      await page.close();
    }
  });

  /* ── 2. SPLIT-VIEW STUDIO ── */
  test("2. Studio Split-View: Sidebar & Canvas keduanya tampil", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await expect(page.locator(".ce-sidebar")).toBeVisible({ timeout: 15000 });
      await expect(page.locator(".ce-canvas")).toBeVisible();
      await expect(page.locator(".ce-live-dot")).toBeVisible();
      await expect(page.locator(".ce-canvas-label")).toContainText("Pratinjau");
      await expect(page.locator(".ce-canvas-status .badge")).toBeVisible();
      await expect(page.locator("#ce-tab-blocks")).toBeVisible();
      await expect(page.locator("#ce-tab-theme")).toBeVisible();
      await expect(page.locator("#ce-tab-add")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_02_split_view.png") });
      console.log("2 PASS: Split-View OK");
    } finally {
      await page.close();
    }
  });

  /* ── 3. HIDE & SHOW SIDEBAR ── */
  test("3. Fitur sembunyikan & tampilkan panel sidebar", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      const hideBtn = page.locator("#ce-btn-hide-sidebar");
      await expect(hideBtn).toBeVisible({ timeout: 15000 });
      await hideBtn.click();
      await page.waitForTimeout(500);
      await expect(page.locator(".ce-layout")).toHaveClass(/ce-layout--sidebar-hidden/);
      await expect(page.locator(".ce-sidebar")).not.toBeVisible();
      const showBtn = page.locator("#ce-btn-show-sidebar");
      await expect(showBtn).toBeVisible();
      await expect(showBtn).toContainText("Buka Panel Editor");
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_03a_hidden.png") });
      await showBtn.click();
      await page.waitForTimeout(500);
      await expect(page.locator(".ce-sidebar")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_03b_restored.png") });
      console.log("3 PASS: Hide/Show Sidebar OK");
    } finally {
      await page.close();
    }
  });

  /* ── 4. DEVICE MODE SWITCHER ── */
  test("4. Device mode switcher: Desktop, Tablet, Mobile", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await expect(page.locator("#ce-device-tablet")).toBeVisible({ timeout: 15000 });
      await page.locator("#ce-device-tablet").click();
      await page.waitForTimeout(400);
      await expect(page.locator("#ce-device-tablet")).toHaveClass(/ce-device-btn--active/);
      await expect(page.locator(".ce-device-frame")).toHaveClass(/ce-device-frame--tablet/);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_04a_tablet.png") });
      await page.locator("#ce-device-mobile").click();
      await page.waitForTimeout(400);
      await expect(page.locator("#ce-device-mobile")).toHaveClass(/ce-device-btn--active/);
      await expect(page.locator(".ce-mobile-notch")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_04b_mobile.png") });
      await page.locator("#ce-device-desktop").click();
      await page.waitForTimeout(400);
      await expect(page.locator("#ce-device-desktop")).toHaveClass(/ce-device-btn--active/);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_04c_desktop.png") });
      console.log("4 PASS: Device Mode Switcher OK");
    } finally {
      await page.close();
    }
  });

  /* ── 5. TAB SUSUNAN BLOK ── */
  test("5. Tab Susunan Blok: list, toggle & reorder", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await page.locator("#ce-tab-blocks").click();
      await page.waitForTimeout(500);
      const blockCards = page.locator(".ce-block-card");
      const count = await blockCards.count();
      expect(count).toBeGreaterThan(0);
      console.log(`   ${count} blok ditemukan`);
      const badgeBefore = await page.locator(".ce-canvas-status .badge").innerText();
      await blockCards.nth(1).locator(".ce-toggle").click();
      await page.waitForTimeout(400);
      const badgeAfter = await page.locator(".ce-canvas-status .badge").innerText();
      expect(badgeBefore).not.toEqual(badgeAfter);
      await blockCards.nth(1).locator(".ce-toggle").click();
      await page.waitForTimeout(400);
      await blockCards.first().locator('.ce-reorder-btn[title="Pindah ke bawah"]').click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_05_blocks.png") });
      console.log("5 PASS: Susunan Blok OK");
    } finally {
      await page.close();
    }
  });

  /* ── 6. INSPECTOR EDIT BLOK HERO ── */
  test("6. Inspector fokus edit blok Hero", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await page.locator("#ce-tab-blocks").click();
      await page.waitForTimeout(400);
      // Id blok memakai sufiks urutan (mis. `ce-edit-btn-hero-1`), jadi cocokkan lewat awalan.
      await page.locator('[id^="ce-edit-btn-hero"]').first().click();
      await page.waitForTimeout(700);
      const inspector = page.locator(".ce-inspector");
      await expect(inspector).toBeVisible({ timeout: 10000 });
      await expect(page.locator("#ce-inspector-back")).toBeVisible();
      await expect(page.locator("#ce-subtab-content")).toBeVisible();
      await expect(page.locator("#ce-subtab-design")).toBeVisible();
      await expect(page.locator("#ce-subtab-effects")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_06a_inspector.png") });
      const headingInput = inspector.getByLabel("Judul utama");
      await headingInput.clear();
      await headingInput.fill("Rental Gear Bandung Juara");
      await page.waitForTimeout(600);
      await expect(page.locator(".ce-mock-page").getByText("Rental Gear Bandung Juara")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_06b_live_edit.png") });
      await page.locator("#ce-subtab-design").click();
      await page.waitForTimeout(300);
      await expect(inspector.getByText("Tinggi banner")).toBeVisible();
      await page.locator("#ce-subtab-effects").click();
      await page.waitForTimeout(300);
      await expect(inspector.locator(".ce-config-fields")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_06c_effects.png") });
      await page.locator("#ce-inspector-back").click();
      await page.waitForTimeout(400);
      await expect(page.locator(".ce-block-list")).toBeVisible();
      console.log("6 PASS: Inspector Edit OK");
    } finally {
      await page.close();
    }
  });

  /* ── 7. TAB TEMA ── */
  test("7. Tab Tema & Efek Visual", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await page.locator("#ce-tab-theme").click();
      await page.waitForTimeout(400);
      await expect(page.getByText("Tema & Efek Visual Global")).toBeVisible({ timeout: 10000 });
      await expect(page.getByText(/Preset Cepat/i)).toBeVisible();
      const presetDeep = page.locator("#ce-preset-deep");
      await expect(presetDeep).toBeVisible();
      await presetDeep.click();
      await page.waitForTimeout(500);
      await expect(presetDeep).toHaveClass(/ce-preset-btn--active/);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_07_theme.png") });
      console.log("7 PASS: Tab Tema OK");
    } finally {
      await page.close();
    }
  });

  /* ── 8. TAB TAMBAH BLOK ── */
  test("8. Tab Tambah Blok: pustaka komponen", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await page.locator("#ce-tab-add").click();
      await page.waitForTimeout(400);
      await expect(page.locator(".ce-add-library")).toBeVisible({ timeout: 10000 });
      await expect(page.getByText("Pustaka Komponen Blok")).toBeVisible();
      await expect(page.getByText("Bagian Utama Halaman")).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_08_add_blocks.png") });
      console.log("8 PASS: Tab Tambah Blok OK");
    } finally {
      await page.close();
    }
  });

  /* ── 9. SAVE BAR ── */
  test("9. Footer save bar dan proses penyimpanan", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await expect(page.locator(".ce-sidebar-footer")).toBeVisible({ timeout: 15000 });
      await expect(page.locator(".ce-sidebar-footer-hint")).toContainText(/Belum disimpan|Tersimpan/);
      await page.locator("#ce-btn-save").click();
      await page.waitForTimeout(1000);
      await expect(page.getByText(/Draf tersimpan di server/i)).toBeVisible({ timeout: 8000 });
      await expect(page.locator(".ce-sidebar-footer-hint")).toContainText("Tersimpan");
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_09_saved.png") });
      console.log("9 PASS: Penyimpanan OK");
    } finally {
      await page.close();
    }
  });

  /* ── 10. FULL PREVIEW ── */
  test("10. Mode Pratinjau Penuh: toggle masuk & keluar", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      // Pastikan mode editor aktif
      await expect(page.locator(".ce-sidebar")).toBeVisible({ timeout: 15000 });
      const viewToggle = page.locator("#ce-btn-view-toggle");
      await expect(viewToggle).toBeVisible();
      
      // Scroll ke tombol view-toggle agar pasti dalam viewport, lalu klik
      await viewToggle.scrollIntoViewIfNeeded();
      await viewToggle.click();
      await page.waitForTimeout(1000);

      // Verifikasi mode preview: .ce-full-preview ada di DOM dan sidebar tidak tampil
      const fullPreview = page.locator(".ce-full-preview");
      await expect(fullPreview).toBeAttached({ timeout: 10000 });
      await expect(page.locator(".ce-sidebar")).not.toBeVisible();

      // Screenshot mode pratinjau penuh
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_10a_full_preview.png") });

      // Klik tombol exit yang ada di ce-full-preview-head (sticky header)
      const exitBtn = page.locator("#ce-btn-exit-full-preview");
      await expect(exitBtn).toBeAttached({ timeout: 8000 });
      await exitBtn.scrollIntoViewIfNeeded();
      await expect(exitBtn).toBeVisible({ timeout: 5000 });
      await exitBtn.click();
      await page.waitForTimeout(1000);

      // Verifikasi kembali ke mode studio
      await expect(page.locator(".ce-sidebar")).toBeVisible({ timeout: 10000 });
      await expect(fullPreview).not.toBeAttached();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_10b_back_studio.png") });
      console.log("10 PASS: Full Preview OK");
    } finally {
      await page.close();
    }
  });


  /* ── 11. CANVAS SELALU TERLIHAT ── */
  test("11. Canvas pratinjau selalu tampil di semua tab", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      const canvas = page.locator(".ce-canvas");
      await expect(canvas).toBeVisible({ timeout: 15000 });
      for (const tabId of ["#ce-tab-blocks", "#ce-tab-theme", "#ce-tab-add"]) {
        await page.locator(tabId).click();
        await page.waitForTimeout(300);
        await expect(canvas).toBeVisible();
        console.log(`   Canvas terlihat di ${tabId}`);
      }
      await page.locator("#ce-tab-blocks").click();
      await page.waitForTimeout(300);
      // Id blok memakai sufiks urutan (mis. `ce-edit-btn-hero-1`), jadi cocokkan lewat awalan.
      await page.locator('[id^="ce-edit-btn-hero"]').first().click();
      await page.waitForTimeout(600);
      await expect(canvas).toBeVisible();
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_11_canvas_visible.png") });
      console.log("11 PASS: Canvas Selalu Terlihat OK");
    } finally {
      await page.close();
    }
  });

  /* ── 12. KATALOG PUBLIK ── */
  test("12. Halaman publik /katalog dapat diakses", async () => {
    test.setTimeout(60000);
    const page = await openEditor();
    try {
      await page.locator("#ce-btn-save").click();
      await page.waitForTimeout(1000);
      await expect(page.getByText(/Draf tersimpan di server/i)).toBeVisible({ timeout: 8000 });
      await page.goto("http://localhost:3001/katalog", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "audit3_12_public.png"), fullPage: true });
      const title = await page.evaluate(() => document.title);
      expect(title).toBeTruthy();
      console.log("12 PASS: Katalog Publik OK, judul:", title);
    } finally {
      await page.close();
    }
  });
});

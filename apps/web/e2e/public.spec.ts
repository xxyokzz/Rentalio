import { expect, test } from "@playwright/test";

test.describe("halaman publik", () => {
  test("landing menampilkan nilai utama dan CTA", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Operasional penyewaan");
    await expect(page.getByRole("link", { name: "Mulai trial 72 jam" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Syarat Layanan/ })).toBeVisible();
    // Landing bukan etalase katalog: tautan katalog tidak ditampilkan di sini.
    await expect(page.getByRole("link", { name: "Katalog" })).toHaveCount(0);
    // Komposisi tidak boleh bergantung pada data dummy.
    await expect(page.getByText(/testimoni/i)).toHaveCount(0);
    await expect(page.getByText(/bukan data nyata/i)).toBeVisible();
  });

  test("manifest PWA tersedia dan valid secara bentuk", async ({ request }) => {
    const response = await request.get("/manifest.webmanifest");
    expect(response.status()).toBe(200);
    const manifest = await response.json();
    expect(manifest.name).toContain("Rentalio");
    expect(manifest.start_url).toBe("/app");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
  });

  test("halaman offline memberi peringatan tanpa klaim sukses", async ({ page }) => {
    await page.goto("/offline");
    await expect(page.getByRole("heading", { name: "Anda sedang offline" })).toBeVisible();
    await expect(page.getByText(/tidak dianggap berhasil tanpa konfirmasi server/)).toBeVisible();
  });

  test("login menampilkan validasi email di klien tanpa mengirim password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("bukan-email");
    await page.getByLabel("Kata sandi").fill("password-panjang-123");
    await page.getByRole("button", { name: "Masuk" }).click();
    await expect(page.getByText("Format email tidak valid.")).toBeVisible();
  });

  test("halaman masuk dan daftar memakai layout split dengan jalan kembali", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Masuk ke Rentalio" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Kembali ke beranda/ })).toBeVisible();
    await expect(page.locator(".auth-split")).toHaveCount(1);

    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "Daftar sebagai owner" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Kembali ke beranda/ })).toBeVisible();
  });

  test("registrasi mewajibkan persetujuan syarat layanan", async ({ page }) => {
    await page.goto("/register");
    await page.getByLabel("Email").fill("owner@contoh.com");
    // Label wajib memuat tanda "*" (aria-hidden) sehingga dicocokkan dengan regex
    // berjangkar agar tidak ikut menangkap "Konfirmasi kata sandi".
    await page.getByLabel(/^Kata sandi/).fill("password-panjang-123");
    await page.getByLabel("Konfirmasi kata sandi").fill("password-panjang-123");
    await page.getByRole("button", { name: "Kirim kode verifikasi" }).click();
    // Pesan validasi harus diumumkan sebagai alert dan terhubung ke input.
    await expect(
      page.getByRole("alert").filter({ hasText: "Anda harus menyetujui" }),
    ).toHaveText("Anda harus menyetujui Syarat Layanan dan Kebijakan Privasi.");
    await expect(page.getByLabel(/menyetujui Syarat Layanan/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  test("katalog tanpa sesi menjelaskan pembatasan kontrak, bukan data palsu", async ({ page }) => {
    await page.goto("/katalog");
    await expect(
      page.getByRole("heading", { name: "Buka katalog toko" }),
    ).toBeVisible();

    // Katalog hanya disajikan di host tenant: path platform dialihkan ke subdomain.
    await page.goto("/t/demo/katalog");
    await expect(page).toHaveURL(/\/\/demo\.localhost:\d+\/katalog$/);
    await expect(
      page.getByText(/Memuat katalog|Katalog tidak ditemukan|tidak dapat dimuat/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("alur masuk dan dashboard", () => {
  test.skip(
    !process.env.E2E_EMAIL || !process.env.E2E_PASSWORD,
    "Butuh E2E_EMAIL dan E2E_PASSWORD serta backend berjalan untuk uji alur masuk.",
  );

  test("masuk lalu melihat ringkasan operasional", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(process.env.E2E_EMAIL!);
    await page.getByLabel("Kata sandi").fill(process.env.E2E_PASSWORD!);
    await page.getByRole("button", { name: "Masuk" }).click();
    await page.waitForURL(/\/app/);
    await expect(page.getByRole("heading", { name: "Ringkasan operasional" })).toBeVisible();
    await expect(page.getByText("Status pembayaran terpisah dari status booking")).toHaveCount(0);
  });
});

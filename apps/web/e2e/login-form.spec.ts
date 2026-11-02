import { expect, test } from "@playwright/test";

/**
 * Uji form masuk **tanpa** sesi tersimpan.
 *
 * Tur audit (`audit_all_features.spec.ts`) kini memakai `storageState` dari
 * project `setup`, sehingga tidak lagi login sendiri. Pengujian halaman masuk
 * dipindah ke sini, dan sengaja tidak mengirim kredensial valid: setiap login
 * memakan kuota 5 percobaan per akun / 15 menit pada `POST /auth/sessions`.
 * Alur masuk yang berhasil tetap dicakup project `setup` (dan `public.spec.ts`
 * bila `E2E_EMAIL`/`E2E_PASSWORD` diisi).
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Form masuk", () => {
  test("menampilkan field dan menahan submit saat email tidak valid", async ({ page }) => {
    const sessionPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/auth/sessions")) {
        sessionPosts.push(request.url());
      }
    });

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Masuk ke Rentalio" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Kata sandi")).toBeVisible();
    await expect(page.getByRole("button", { name: "Masuk" })).toBeVisible();

    await page.getByLabel("Email").fill("bukan-email");
    await page.getByLabel("Kata sandi").fill("password-panjang-123");
    await page.getByRole("button", { name: "Masuk" }).click();

    await expect(page.getByText("Format email tidak valid.")).toBeVisible();
    expect(sessionPosts).toHaveLength(0);
  });
});

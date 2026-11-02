import { expect, test } from "@playwright/test";
import path from "node:path";

const ARTIFACT_DIR = "C:/Users/LENOVO/.gemini/antigravity-ide/brain/fd8b1bef-d3d0-4cac-a7ac-16ac46b8aa6f";

test.describe("Fitur Toggle Tampilkan/Sembunyikan Kata Sandi pada Login", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Menampilkan icon mata dan dapat toggle visibility password", async ({ page }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    const passwordInput = page.getByLabel("Kata sandi");
    const eyeBtn = page.getByRole("button", { name: "Tampilkan password" });

    // 1. Awal: type="password" dan tombol mata terlihat
    await expect(passwordInput).toHaveAttribute("type", "password");
    await expect(eyeBtn).toBeVisible();

    // 2. Isi password
    await passwordInput.fill("DemoRentalio2026!");
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "login_eye_01_masked.png") });

    // 3. Klik icon mata -> password terlihat (type="text")
    await eyeBtn.click();
    await expect(passwordInput).toHaveAttribute("type", "text");
    const hideBtn = page.getByRole("button", { name: "Sembunyikan password" });
    await expect(hideBtn).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "login_eye_02_revealed.png") });

    // 4. Klik lagi -> password tersembunyi kembali (type="password")
    await hideBtn.click();
    await expect(passwordInput).toHaveAttribute("type", "password");
    await expect(page.getByRole("button", { name: "Tampilkan password" })).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "login_eye_03_remasked.png") });

    console.log("==> Test toggle icon mata berhasil!");
  });
});

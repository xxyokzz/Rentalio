import path from "node:path";
import { expect, test as setup } from "@playwright/test";

/**
 * Login **sekali** per suite, lalu simpan sesi ke `storageState`.
 *
 * Sebelumnya setiap project (desktop & mobile) login sendiri-sendiri di
 * `beforeAll`, padahal API membatasi login ke 5 percobaan per akun per 15
 * menit (`loginAccount`) — project kedua karena itu bisa gagal `429` sebelum
 * satu tes pun berjalan. Spec yang membutuhkan sesi kini memakai
 * `test.use({ storageState: AUTH_STATE })` dan tidak login lagi.
 *
 * Kredensial fixture development dapat ditimpa lewat `E2E_EMAIL` /
 * `E2E_PASSWORD` (nilai default sama dengan yang dipakai spec audit lama).
 */
export const AUTH_STATE = path.join(__dirname, ".auth", "state.json");

const email = process.env.E2E_EMAIL ?? "demo@rentalio.test";
const password = process.env.E2E_PASSWORD ?? "DemoRentalio2026!";

setup("masuk sekali lalu simpan state sesi", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(password);
  await page.getByRole("button", { name: "Masuk" }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
  await expect(page.getByRole("navigation", { name: "Menu aplikasi" })).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE });
});

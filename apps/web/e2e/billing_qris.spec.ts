import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * E2E: billing langganan QRIS dari sisi tenant.
 *
 * Alur yang diuji lewat UI nyata (bukan mock):
 *   1. daftar owner baru → verifikasi OTP (dibaca dari outbox dev-file) → login,
 *   2. onboarding tenant,
 *   3. halaman Pengaturan → "Tampilkan QR pembayaran",
 *   4. QRIS dinamis tampil beserta nominal, dan API mengembalikan payload
 *      ber-tag 54 sesuai harga langganan.
 *
 * Status `PAID` sengaja TIDAK diuji di sini: QRIS tidak punya callback dan
 * penyelesaian hanya lewat Admin Platform (diuji di integration test API).
 */

const PW = "KataSandiE2E2026!aman";
const PRICE = 149_000;
const ARTIFACTS = path.join(__dirname, ".artifacts");
const MAILBOX = path.join(__dirname, "..", "..", "api", ".dev-mailbox", "outbox.jsonl");

function readOtp(email: string): string {
  const lines = fs
    .readFileSync(MAILBOX, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = JSON.parse(lines[i]!) as { to?: string; body?: string };
    if (entry.to?.toLowerCase() !== email.toLowerCase()) continue;
    const match = String(entry.body ?? "").match(/\b(\d{6})\b/);
    if (match?.[1]) return match[1];
  }
  throw new Error(`OTP tidak ditemukan di outbox untuk ${email}`);
}

function cookieHeader(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

test.describe.configure({ mode: "serial" });
test.use({ storageState: { cookies: [], origins: [] } });

test("owner baru dapat menampilkan QRIS langganan bernominal", async ({ page, context, request }, testInfo) => {
  // OTP dibaca dari outbox adapter `dev-file`. Di lingkungan yang memakai
  // adapter in-memory, file ini tidak ada sehingga tes dilewati (bukan gagal).
  test.skip(!fs.existsSync(MAILBOX), "Butuh EMAIL_PROVIDER=dev-file untuk membaca OTP dari mailbox lokal.");
  test.setTimeout(120_000);
  const stamp = Date.now();
  const email = `e2e-qris-${stamp}@contoh.com`;
  const slug = `e2e-qris-${stamp}`;

  // 1. Registrasi lewat UI.
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Nama lengkap").fill("Owner E2E QRIS");
  await page.getByLabel("Nama toko / rental").fill("Rental E2E QRIS");
  await page.getByLabel(/^Kata sandi/).fill(PW);
  await page.getByLabel(/^Konfirmasi kata sandi/).fill(PW);
  await page.getByLabel(/Saya menyetujui/).check();
  await page.getByRole("button", { name: "Kirim kode verifikasi" }).click();
  await page.waitForURL(/\/register\/verify/);

  // 2. Verifikasi OTP (dev-file adapter menulis ke outbox JSONL).
  await page.getByLabel("Kode verifikasi").fill(readOtp(email));
  await page.getByRole("button", { name: "Verifikasi email" }).click();

  // 3. Login.
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Kata sandi").fill(PW);
  await page.getByRole("button", { name: "Masuk" }).click();

  // 4. Onboarding tenant (akun baru belum punya tenant) lalu buka Pengaturan.
  // Redirect ke onboarding terjadi di klien *setelah* halaman sempat dirender,
  // jadi tunggu sinyal stabil: judul onboarding ATAU tombol QR Langganan.
  await page.goto("/app/settings");
  const onboardingHeading = page.getByRole("heading", { name: "Yuk, lengkapi data tokomu" });
  const payButton = page.getByRole("button", { name: "Tampilkan QR pembayaran" });
  await expect(onboardingHeading.or(payButton)).toBeVisible({ timeout: 30_000 });

  if (await onboardingHeading.isVisible()) {
    const slugInput = page.getByLabel("Link katalog (subdomain)");
    await slugInput.fill(slug);
    await expect(slugInput).toHaveValue(slug);
    await page.getByRole("button", { name: "Buka toko sekarang" }).click();
    await page.waitForURL(/\/app$/, { timeout: 30_000 });
    await page.goto("/app/settings");
  }

  // 5. Minta QR dari panel Langganan.
  await expect(page.getByText("Rp 149.000").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Tampilkan QR pembayaran" }).click();

  await expect(page.getByText(/Pindai QR di bawah/)).toBeVisible({ timeout: 30_000 });
  const qr = page.getByRole("img", { name: "QRIS pembayaran langganan Rentalio" });
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute("src", /^\/_next\/image\?url=|^data:image\/png;base64,/);
  await expect(page.getByRole("button", { name: "Salin kode QRIS" })).toBeVisible();

  fs.mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: path.join(ARTIFACTS, "qris-panel.png"), fullPage: true });

  // 6. Verifikasi kontrak API: payload memuat tag 54 dengan nominal langganan.
  const cookie = cookieHeader(await context.cookies());
  const tenantsRes = await request.get("/api/v1/tenants", { headers: { cookie } });
  expect(tenantsRes.ok()).toBeTruthy();
  const tenants = (await tenantsRes.json()) as { data: Array<{ id: string; slug: string }> };
  const tenant = tenants.data.find((row) => row.slug === slug);
  expect(tenant).toBeTruthy();

  const invoicesRes = await request.get(
    `/api/v1/tenants/${tenant!.id}/subscription-invoices`,
    { headers: { cookie } },
  );
  expect(invoicesRes.ok()).toBeTruthy();
  const invoices = (await invoicesRes.json()) as {
    data: Array<{ status: string; provider: string; amount: string; qrPayload: string | null; qrImageDataUrl: string | null }>;
  };
  expect(invoices.data).toHaveLength(1);
  const invoice = invoices.data[0]!;
  expect(invoice.status).toBe("PENDING");
  expect(invoice.provider).toBe("qris");
  expect(invoice.amount).toBe(String(PRICE));
  // Tag 54 (Transaction Amount): "54" + panjang 2 digit + nominal.
  expect(invoice.qrPayload).toContain(`5406${PRICE}`);
  expect(invoice.qrImageDataUrl).toMatch(/^data:image\/png;base64,/);

  await testInfo.attach("qr-payload-check", {
    body: JSON.stringify(
      {
        tenantSlug: tenant!.slug,
        status: invoice.status,
        provider: invoice.provider,
        amount: invoice.amount,
        hasQrPayload: Boolean(invoice.qrPayload),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

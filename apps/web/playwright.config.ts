import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3001";
const hasExternalServer = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // Login sekali per suite; spec yang butuh sesi memakai storageState-nya
    // (lihat `e2e/auth.setup.ts`) agar tidak login ulang per project.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      dependencies: ["setup"],
    },
  ],
  webServer: hasExternalServer
    ? undefined
    : {
        command: "pnpm dev",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});

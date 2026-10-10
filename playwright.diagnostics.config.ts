import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/runtime-diagnostics",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 90000,
  reporter: "line",
  use: {
    baseURL: process.env.M5_WEB_URL ?? "http://127.0.0.1:4173",
    trace: "off",
    screenshot: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});

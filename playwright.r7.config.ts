import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/v1.8/r7",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: process.env.M5_WEB_URL ?? "http://127.0.0.1:4173",
    actionTimeout: 15000,
    navigationTimeout: 20000,
    trace: "off", // Authenticated requests contain tokens; use safe assertions/screenshots.
    screenshot: "off", // This suite exercises one-time credential display.
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});

import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/production/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "https://127.0.0.1:8443",
    ignoreHTTPSErrors: true, // Isolated CI self-signed TLS edge only.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});

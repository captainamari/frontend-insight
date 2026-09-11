import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/v1.8/r0",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: process.env.FI_API_URL ?? "http://127.0.0.1:3000",
    extraHTTPHeaders: { origin: "http://localhost:4173" },
    trace: "retain-on-failure",
  },
});

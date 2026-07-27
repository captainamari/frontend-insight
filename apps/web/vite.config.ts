import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/v1/events": "http://127.0.0.1:3000",
    },
  },
  preview: { host: "0.0.0.0", port: 4173 },
});

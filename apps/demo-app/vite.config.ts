import { requestFixture } from "./src/request-fixture";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vue(),
    {
      name: "diagnostic-fixtures",
      configureServer(server) {
        server.middlewares.use(requestFixture);
      },
      configurePreviewServer(server) {
        server.middlewares.use(requestFixture);
      },
    },
  ],
  server: {
    port: 4174,
    proxy: { "/v1/events": "http://127.0.0.1:3000" },
  },
  preview: { host: "0.0.0.0", port: 4174 },
});

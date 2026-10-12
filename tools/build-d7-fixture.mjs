import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const { build } = createRequire(
  new URL("../packages/web-tracker/package.json", import.meta.url),
)("esbuild");
const vue = createRequire(
  new URL("../apps/demo-app/package.json", import.meta.url),
).resolve("vue/dist/vue.esm-bundler.js");
await mkdir("apps/demo-app/public/d7", { recursive: true });
await build({
  entryPoints: ["examples/diagnostics/d7-framework.ts"],
  outfile: "apps/demo-app/public/d7/framework.js",
  bundle: true,
  minify: true,
  format: "esm",
  alias: { vue },
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
});

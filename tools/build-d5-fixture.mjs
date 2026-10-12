import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const { build } = createRequire(
  new URL("../packages/web-tracker/package.json", import.meta.url),
)("esbuild");
const out = root + "artifacts/d5-build",
  publicDir = root + "apps/demo-app/public/d5";
await mkdir(out, { recursive: true });
await mkdir(publicDir, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["examples/sourcemaps/源码场景.ts"],
  outfile: out + "/fixture.js",
  bundle: true,
  minify: true,
  keepNames: true,
  format: "esm",
  sourcemap: "external",
  sourcesContent: true,
  charset: "utf8",
});
const js = await readFile(out + "/fixture.js");
const manifest = {
  release: "d5-lab-v1",
  build: createHash("sha256").update(js).digest("hex"),
  assets: [
    { url: "/d5/fixture.js", sha256: createHash("sha256").update(js).digest("hex") },
  ],
};
await copyFile(out + "/fixture.js", publicDir + "/fixture.js");
await writeFile(publicDir + "/manifest.json", JSON.stringify(manifest) + "\n");
await writeFile(out + "/manifest.json", JSON.stringify(manifest) + "\n");

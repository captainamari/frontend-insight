import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const maximumGzipBytes = 12 * 1024;
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  legalComments: "none",
});
const bundle = await readFile("dist/index.js");
const report = {
  rawBytes: bundle.byteLength,
  gzipBytes: gzipSync(bundle).byteLength,
  maximumGzipBytes,
  passed: gzipSync(bundle).byteLength <= maximumGzipBytes,
};
await writeFile("dist/bundle-report.json", `${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) {
  throw new Error(
    `SDK gzip budget exceeded: ${report.gzipBytes} > ${maximumGzipBytes}`,
  );
}
console.log(JSON.stringify(report));

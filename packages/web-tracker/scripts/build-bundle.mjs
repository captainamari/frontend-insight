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

await build({
  entryPoints: ["src/quality.ts"],
  outfile: "dist/quality.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
});
const qualityBytes = gzipSync(await readFile("dist/quality.js")).byteLength;
if (qualityBytes > maximumGzipBytes) throw new Error("QUALITY_BUNDLE_BUDGET");
console.log(JSON.stringify({ qualityGzipBytes: qualityBytes, maximumGzipBytes }));

if (process.env.GITHUB_SHA) {
  await mkdir("../../artifacts", { recursive: true });
  await writeFile(
    "../../artifacts/r5a-sdk-bundle.json",
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        base: report,
        optionalQualityGzipBytes: qualityBytes,
        combinedGzipBytes: report.gzipBytes + qualityBytes,
        note: "Base entrypoint retains its existing 12KiB cap; optional extension is a separate explicit download, not free or included in the base figure.",
      },
      null,
      2,
    ),
  );
}

await build({
  entryPoints: ["src/errors.ts"],
  outfile: "dist/errors.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
});
const errorsBytes = gzipSync(await readFile("dist/errors.js")).byteLength;
await writeFile(
  "dist/diagnostics-bundle-report.json",
  JSON.stringify(
    {
      baseGzipBytes: report.gzipBytes,
      diagnosticsGzipBytes: errorsBytes,
      combinedGzipBytes: report.gzipBytes + errorsBytes,
      withQualityGzipBytes: report.gzipBytes + errorsBytes + qualityBytes,
      note: "Optional errors and quality are separate explicit downloads; base cap unchanged.",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    diagnosticsGzipBytes: errorsBytes,
    combinedGzipBytes: report.gzipBytes + errorsBytes,
  }),
);

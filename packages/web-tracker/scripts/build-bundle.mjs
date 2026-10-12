import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const maximumGzipBytes = 12 * 1024;
// Public wire fields must never enter the private-property compression allowlist.
const privateProperties =
  /^(originalFetch|instrumentedFetch|qualityPayload|activeLongViews|visibleStartedAt|flushTimer|lastActivityAt|installFetchInstrumentation|handleUnhandledRejection|resolvePageRoute|settleVisiblePage|refreshSession|loadOrCreateDevice|nextBatch|makeBatch|stopLongViews|businessInFlight|installedHistory|originalHistory|errorCleanup|associatedOperation|reportError|sessionStorageKey|handlePageRouteChange|handleVisibilityChange|handlePageHide|handlePageShow|installLifecycle|uninstallLifecycle|diagnosticWindow|flushing|destroyed|isVisible|errorCleanup|listen|safe|eventQueue|trackerConfig|emitCustom)$/;
const wireSchema = JSON.parse(
  await readFile("../event-contract/schema/event-batch-v3.schema.json", "utf8"),
);
function checkWireNames(node) {
  if (!node || typeof node !== "object") return;
  for (const key of Object.keys(node.properties ?? {})) {
    if (privateProperties.test(key))
      throw new Error(`PRIVATE_MANGLE_WIRE_COLLISION: ${key}`);
  }
  for (const child of Object.values(node)) checkWireNames(child);
}
checkWireNames(wireSchema);
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  // These identifiers are private BrowserTracker / BrowserObservability members only; never public
  // config, event keys, collector ports or string-indexed methods. Keep the allowlist narrow.
  mangleProps: privateProperties,
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

await build({
  entryPoints: ["src/console.ts"],
  outfile: "dist/console.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  external: ["./errors.js"],
  legalComments: "none",
});
const consoleBytes = gzipSync(await readFile("dist/console.js")).byteLength;
const consoleReport = {
  baseGzipBytes: report.gzipBytes,
  errorsGzipBytes: errorsBytes,
  consoleGzipBytes: consoleBytes,
  qualityGzipBytes: qualityBytes,
  baseAndErrors: report.gzipBytes + errorsBytes,
  baseErrorsConsole: report.gzipBytes + errorsBytes + consoleBytes,
  baseErrorsConsoleQuality:
    report.gzipBytes + errorsBytes + consoleBytes + qualityBytes,
  note: "console imports shared errors.js; all downloaded modules are counted once. Base 12KiB cap unchanged.",
};
await writeFile(
  "dist/console-bundle-report.json",
  JSON.stringify(consoleReport, null, 2),
);
console.log(JSON.stringify(consoleReport));

await build({
  entryPoints: ["src/requests.ts"],
  outfile: "dist/requests.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  external: ["./console.js", "./errors.js"],
  legalComments: "none",
});
const requestsBytes = gzipSync(await readFile("dist/requests.js")).byteLength;
const requestReport = {
  ...consoleReport,
  requestsGzipBytes: requestsBytes,
  baseErrorsConsoleRequests: consoleReport.baseErrorsConsole + requestsBytes,
  baseErrorsConsoleQualityRequests:
    consoleReport.baseErrorsConsoleQuality + requestsBytes,
};
await writeFile(
  "dist/requests-bundle-report.json",
  JSON.stringify(requestReport, null, 2),
);
console.log(JSON.stringify(requestReport));

await build({
  entryPoints: ["src/policy.ts"],
  outfile: "dist/policy.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  external: ["./requests.js", "./errors.js"],
  legalComments: "none",
});
const policyBytes = gzipSync(await readFile("dist/policy.js")).byteLength;
await writeFile(
  "dist/policy-bundle-report.json",
  JSON.stringify(
    {
      ...requestReport,
      policyGzipBytes: policyBytes,
      baseErrorsConsoleRequestsPolicy:
        requestReport.baseErrorsConsoleRequests + policyBytes,
      withQuality: requestReport.baseErrorsConsoleQualityRequests + policyBytes,
    },
    null,
    2,
  ),
);

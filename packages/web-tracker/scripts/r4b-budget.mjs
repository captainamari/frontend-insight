import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const base = "76a96dea8aeb00db9088e2547250aaa59034a629";
const temp = await mkdtemp(join(tmpdir(), "fi-r4b-sdk-"));
try {
  const files = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", base, "packages/web-tracker/src"],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  for (const file of files) {
    const target = join(temp, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      execFileSync("git", ["show", `${base}:${file}`], { cwd: root }),
    );
  }
  await build({
    entryPoints: [join(temp, "packages/web-tracker/src/index.ts")],
    outfile: join(temp, "baseline.js"),
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    legalComments: "none",
    nodePaths: [join(root, "packages/web-tracker/node_modules")],
  });
  const old = await readFile(join(temp, "baseline.js")),
    current = await readFile(join(root, "packages/web-tracker/dist/index.js"));
  const gzip = gzipSync(current).length;
  if (gzip > 12288) throw new Error("SDK_EXISTING_BUDGET_EXCEEDED");
  const result = {
    testedCommit:
      process.env.GITHUB_SHA ??
      (spawnSync("git", ["diff", "--quiet", "HEAD"], { cwd: root }).status === 0
        ? execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim()
        : null),
    baselineCommit: base,
    node: process.version,
    baseline: { rawBytes: old.length, gzipBytes: gzipSync(old).length },
    current: { rawBytes: current.length, gzipBytes: gzip },
    gzipDifference: gzip - gzipSync(old).length,
    maximumGzipBytes: 12288,
    note: "Both builds use the same installed bundler and contract v3 dependency; no production host capacity claim.",
  };
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(
    join(root, "artifacts/r4b-sdk-bundle.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await rm(temp, { recursive: true, force: true });
}

import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "packages/event-contract/canonical-names.json"), "utf8"),
);
const sourceRoots = ["apps", "packages", "infra", "scripts", "tests", "tools"];
const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".vue",
  ".sql",
  ".json",
]);
const allowlist = [
  /^docs\//,
  /^packages\/event-contract\/canonical-names\.json$/,
  /^packages\/event-contract\/scripts\/generate-types\.mjs$/,
  /^packages\/event-contract\/src\/generated\/canonical-names\.ts$/,
  /^packages\/test-fixtures\/fixtures\/invalid\//,
  /^tools\/check-canonical-names\.mjs$/,
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["node_modules", "dist", "coverage", ".git"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (extensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const unambiguousFields = manifest.forbiddenAliases.publicFields.filter(
  (value) => !["route", "properties"].includes(value),
);
const obsoleteStorageNames = [
  "project_key",
  "event_name",
  "event_time",
  "visitor_id",
  "account_ref",
  "account_id",
  "release_version",
  "deployment_environment",
  "browser_family",
  "os_family",
  "properties_json",
];
const alwaysForbiddenEvents = manifest.forbiddenAliases.eventNames.filter(
  (value) => !value.startsWith("feature_"),
);
const featureAliases = manifest.forbiddenAliases.eventNames.filter((value) =>
  value.startsWith("feature_"),
);
const patterns = [
  ...unambiguousFields.map((value) => ({
    label: value,
    regex: new RegExp(`\\b${escaped(value)}\\b`),
  })),
  ...obsoleteStorageNames.map((value) => ({
    label: value,
    regex: new RegExp(`\\b${escaped(value)}\\b`),
  })),
  ...alwaysForbiddenEvents.map((value) => ({
    label: value,
    regex: new RegExp(`\\b${escaped(value)}\\b`),
  })),
  ...manifest.forbiddenAliases.metricKeys.map((value) => ({
    label: value,
    regex: new RegExp(`\\b${escaped(value)}\\b`),
  })),
  ...featureAliases.map((value) => ({
    label: `event=${value}`,
    regex: new RegExp(
      `(?:\\bevent\\s*[:=]|\\bevent\\s*=\\s*)\\s*["']${escaped(value)}["']`,
    ),
  })),
];

const violations = [];
for (const sourceRoot of sourceRoots) {
  for (const file of await filesBelow(resolve(root, sourceRoot))) {
    const path = relative(root, file);
    if (allowlist.some((rule) => rule.test(path))) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const pattern of patterns) {
        if (pattern.regex.test(line)) {
          violations.push(`${path}:${index + 1}: ${pattern.label}`);
        }
      }
    }
  }
}

if (violations.length) {
  console.error("Canonical-name check failed:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Canonical-name check passed.");
}

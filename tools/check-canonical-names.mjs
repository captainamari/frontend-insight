import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(resolve(root, "packages/event-contract/canonical-names.json"), "utf8"),
);
const sourceRoots = ["apps", "packages", "infra", "scripts", "tests", "tools", "docs"];
const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".vue",
  ".sql",
  ".json",
  ".md",
  ".sh",
  "",
]);
const allowlist = JSON.parse(
  await readFile(resolve(root, "tools/canonical-allowlist.json"), "utf8"),
);
const allowedPaths = new Set(allowlist.map((entry) => entry.path));
if (
  allowedPaths.size !== allowlist.length ||
  allowlist.some((entry) => !entry.reason || /[*^$]/.test(entry.path))
)
  throw new Error("CANONICAL_ALLOWLIST_INVALID");

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
  {
    label: "business-domain synonym",
    regex: /\b(?:businessDomain|business_domain|domainId|domainKey)\b|业务域/u,
  },
  { label: "old positive contract", regex: /schemaVersion["']?\s*:\s*[12]\b/u },
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

export function findViolations(source) {
  return source
    .split(/\r?\n/u)
    .flatMap((line, index) =>
      patterns
        .filter((p) => p.regex.test(line))
        .map((p) => ({ line: index + 1, label: p.label })),
    );
}

const violations = [];
if (process.argv[1] === fileURLToPath(import.meta.url))
  for (const sourceRoot of sourceRoots) {
    for (const file of await filesBelow(resolve(root, sourceRoot))) {
      const path = relative(root, file);
      if (allowedPaths.has(path)) continue;
      for (const item of findViolations(await readFile(file, "utf8"))) {
        violations.push(`${path}:${item.line}: ${item.label}`);
      }
    }
  }

if (violations.length) {
  console.error("Canonical-name check failed:\n" + violations.join("\n"));
  process.exitCode = 1;
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("Canonical-name check passed.");
}

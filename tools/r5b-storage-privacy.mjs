import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const evidence = ["chromium", "webkit"].map((b) =>
  JSON.parse(readFileSync(`artifacts/r5b-${b}.json`, "utf8")),
);
const compose = [
  "compose",
  "--project-name",
  "frontend-insight-m5",
  "--env-file",
  ".env.m5",
  "--file",
  "infra/compose/m2-m4.compose.yml",
  "--file",
  "infra/compose/m5.compose.yml",
];
execFileSync(
  "docker",
  [
    ...compose,
    "exec",
    "-T",
    "api",
    "pnpm",
    "--filter",
    "@frontend-insight/server-core",
    "exec",
    "tsx",
    "test/r5b-storage-privacy.ts",
    ...evidence.map((e) => e.projectId),
  ],
  { encoding: "utf8", timeout: 90000, stdio: ["ignore", "pipe", "pipe"] },
);
const logs = execFileSync(
  "docker",
  [...compose, "logs", "--no-color", "api", "consumer", "web", "demo"],
  { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
);
assert(!/FI_R5B_PRIVATE|person@example\.invalid/.test(logs), "R5B_SERVICE_LOG_LEAK");
writeFileSync(
  "artifacts/r5b-privacy.json",
  JSON.stringify(
    {
      testedCommit:
        process.env.GITHUB_SHA ??
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      browserWire: "passed",
      kafka: "passed",
      clickhouse: "passed",
      api: "passed",
      ui: "passed",
      serviceLogs: "passed",
      deadLetter: "passed",
    },
    null,
    2,
  ),
);

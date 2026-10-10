import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const logs = execFileSync(
  "docker",
  [
    "compose",
    "--project-name",
    "frontend-insight-m5",
    "--env-file",
    ".env.m5",
    "--file",
    "infra/compose/m2-m4.compose.yml",
    "--file",
    "infra/compose/m5.compose.yml",
    "logs",
    "--no-color",
    "api",
    "consumer",
    "web",
    "demo",
  ],
  { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
);
assert(!logs.includes("FI_D0_SYNTHETIC"), "D0_SERVICE_LOG_LEAK");
writeFileSync(
  "artifacts/d0-logs.json",
  JSON.stringify({ testedCommit: process.env.GITHUB_SHA, serviceLogs: "passed" }),
);

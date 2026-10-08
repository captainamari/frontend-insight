import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cpus, totalmem, platform, arch } from "node:os";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const checkout = git("rev-parse", "HEAD");
assert.equal(checkout, process.env.GITHUB_SHA);
const r = await fetch(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/pulls?state=open&head=${encodeURIComponent(process.env.GITHUB_REPOSITORY_OWNER + ":" + process.env.GITHUB_REF_NAME)}`,
  {
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  },
);
assert(r.ok, "PR_READ_FAILED");
const prs = await r.json();
assert.equal(prs.length, 1);
const pr = prs[0];
assert(pr.draft && pr.head.sha === checkout, "PR_HEAD_OR_DRAFT_MISMATCH");
assert(["agent/v1-8-r7-settings", "refactor"].includes(pr.base.ref), "UNEXPECTED_BASE");
git("fetch", "origin", pr.base.ref);
git("merge-base", "--is-ancestor", pr.base.sha, checkout);
git(
  "merge-base",
  "--is-ancestor",
  "f0c92a1be0e8c0f6f720f9fa4dd82a60c5e3bf20",
  checkout,
);
const resources = execFileSync(
  "docker",
  ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}} {{.CPUPerc}}"],
  { encoding: "utf8" },
);
writeFileSync(
  "artifacts/r8-evidence.json",
  JSON.stringify(
    {
      testedCommit: checkout,
      prHead: pr.head.sha,
      pr: pr.number,
      base: pr.base.ref,
      baseSha: pr.base.sha,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      automation: "passed",
      realIntegration: "passed",
      browsers: ["chromium", "webkit"],
      runner: {
        os: platform(),
        arch: arch(),
        cpus: cpus().length,
        memoryBytes: totalmem(),
        node: process.version,
        docker: execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
          encoding: "utf8",
        }).trim(),
        compose: execFileSync("docker", ["compose", "version", "--short"], {
          encoding: "utf8",
        }).trim(),
        resources,
      },
      manualAcceptance: "R6 pending friend; R8 not performed",
      ruleApproval: "pending actual management/security approval",
      missingFacts: ["multi_ip", "permission_denied"],
      finalGo: false,
      automaticMerge: false,
    },
    null,
    2,
  ),
);

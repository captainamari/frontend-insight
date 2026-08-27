import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { SYSTEM_METRIC_SEED } from "../src/generated/system-metric-seed.js";
import { m5Fixture } from "./m5-fixture.js";
import { m6Fixture, seedM6Fixture } from "./m6-fixture.js";

const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("MYSQL_URL_REQUIRED");

const origins = (
  process.env.M5_PROJECT_ORIGINS ??
  "http://localhost:4173,http://127.0.0.1:4173,http://localhost:4174,http://127.0.0.1:4174"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function stableUuid(namespace: string, key: string): string {
  const hex = createHash("sha256").update(`${namespace}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const libraryId = stableUuid("r0", "metric-library-v1");
const workflowId = stableUuid("r0", "workflow-energy-response");
const workflowVersionId = stableUuid("r0", "workflow-energy-response-v1");

await seedM6Fixture(mysqlUrl, { origins });
const pool = mysql.createPool(mysqlUrl);
try {
  await pool.execute(
    `INSERT INTO workflow_definitions
       (id, project_id, module_id, workflow_key, name, status)
     VALUES (?, ?, ?, 'energy_response', '能耗异常处置', 'active')
     ON DUPLICATE KEY UPDATE
       module_id = VALUES(module_id), name = VALUES(name), status = 'active',
       disabled_at = NULL`,
    [workflowId, m5Fixture.projectId, m6Fixture.modules.operations],
  );
  await pool.execute(
    `INSERT INTO workflow_definition_versions
       (id, workflow_definition_id, version, start_policy, terminal_policy,
        timeout_seconds, status, activated_at)
     VALUES (?, ?, 1, 'explicit_sdk', ?, 1800, 'active',
             '2026-08-01 00:00:00.000')
     ON DUPLICATE KEY UPDATE id = id`,
    [
      workflowVersionId,
      workflowId,
      JSON.stringify({
        completedStepKey: "resolved",
        failedStepKey: null,
        canceledStepKey: null,
        timeoutState: "approximate_abandoned",
      }),
    ],
  );
  for (const [key, name, order] of [
    ["opened", "发现异常", 1],
    ["acknowledged", "确认处置", 2],
    ["resolved", "完成处置", 3],
  ] as const) {
    await pool.execute(
      `INSERT INTO workflow_steps
       (id, workflow_definition_version_id, step_key, name, step_order,
          trigger_kind, trigger_config)
       VALUES (?, ?, ?, ?, ?, 'explicit_sdk', JSON_OBJECT('actionKey', ?))
       ON DUPLICATE KEY UPDATE id = id`,
      [stableUuid("r0-workflow-step", key), workflowVersionId, key, name, order, key],
    );
  }

  await pool.execute(
    `INSERT INTO metric_library_versions
       (id, version, status, manifest_version, activated_at)
     VALUES (?, 1, 'active', '1.8.0', '2026-08-01 00:00:00.000')
     ON DUPLICATE KEY UPDATE id = id`,
    [libraryId],
  );
  for (const metric of SYSTEM_METRIC_SEED) {
    await pool.execute(
      `INSERT INTO metric_definitions
         (id, library_version_id, metric_key, category, display_name, unit,
          implementation_status, formula_ast, denominator_definition,
          minimum_sample)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
       ON DUPLICATE KEY UPDATE id = id`,
      [
        stableUuid("r0-metric", metric.metricKey),
        libraryId,
        metric.metricKey,
        metric.category,
        metric.displayName,
        metric.category === "score" ? "score" : "count_or_rate",
        metric.implementationStatus,
      ],
    );
  }

  for (const score of [
    {
      key: "operational_score",
      name: "运营分",
      gate: { type: "threshold", metricKey: "operational_score", value: 80 },
      bands: { good: 85, warning: 60 },
      dimensions: [
        ["usage_coverage", "使用覆盖", 0.3, "uv"],
        ["continuity_depth", "持续深度", 0.2, "vv"],
        ["task_completion", "任务完成", 0.3, "task_duration"],
        ["usage_efficiency", "使用效率", 0.2, "avg_usage_duration"],
      ],
    },
    {
      key: "quality_score",
      name: "质量分",
      gate: {
        type: "minimum_sample",
        metricKey: "pv",
        value: 100,
        missingResult: "insufficient",
      },
      bands: { good: 85, warning: 60 },
      dimensions: [
        ["stability", "稳定性", 0.6, "js_error_rate"],
        ["performance", "性能", 0.4, "lcp"],
      ],
    },
  ] as const) {
    const scoreId = stableUuid("r0-score", score.key);
    await pool.execute(
      `INSERT INTO score_definitions
         (id, library_version_id, score_key, display_name, version, gate_ast,
          color_bands, status, activated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, 'active', '2026-08-01 00:00:00.000')
       ON DUPLICATE KEY UPDATE id = id`,
      [
        scoreId,
        libraryId,
        score.key,
        score.name,
        JSON.stringify(score.gate),
        JSON.stringify(score.bands),
      ],
    );
    for (const [dimensionKey, dimensionName, weight, metricKey] of score.dimensions) {
      const dimensionId = stableUuid(`r0-score-dimension:${score.key}`, dimensionKey);
      await pool.execute(
        `INSERT INTO score_dimensions
           (id, score_definition_id, dimension_key, display_name, weight)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [dimensionId, scoreId, dimensionKey, dimensionName, weight],
      );
      await pool.execute(
        `INSERT INTO score_items
           (id, score_dimension_id, metric_definition_id, weight,
            target_config, required)
         VALUES (?, ?, ?, 1, JSON_OBJECT('strategy', 'versioned_target'), TRUE)
         ON DUPLICATE KEY UPDATE id = id`,
        [
          stableUuid(`r0-score-item:${score.key}`, metricKey),
          dimensionId,
          stableUuid("r0-metric", metricKey),
        ],
      );
    }
  }
} finally {
  await pool.end();
}

console.log(
  JSON.stringify({
    status: "seeded",
    milestone: "R0",
    contractVersion: 3,
    projectId: m5Fixture.projectId,
    appId: m5Fixture.appId,
    modules: Object.values(m6Fixture.modules),
    pages: Object.values(m6Fixture.pages),
    workflowKey: "energy_response",
    metrics: SYSTEM_METRIC_SEED.length,
    scores: ["operational_score", "quality_score"],
  }),
);

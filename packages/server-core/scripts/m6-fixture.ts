import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { m5Fixture, seedM5Fixture } from "./m5-fixture.js";

export const m6Fixture = {
  modules: {
    analytics: "10111111-1111-4111-8111-111111111111",
    operations: "10222222-2222-4222-8222-222222222222",
  },
  pages: {
    reports: "20111111-1111-4111-8111-111111111111",
    operations: "20222222-2222-4222-8222-222222222222",
    wallboard: "20333333-3333-4333-8333-333333333333",
  },
  settingsId: "30111111-1111-4111-8111-111111111111",
} as const;

function stableUuid(namespace: string, key: string): string {
  const hex = createHash("sha256").update(`${namespace}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function seedM6Fixture(
  mysqlUrl: string,
  options: { origins: string[] },
): Promise<void> {
  await seedM5Fixture(mysqlUrl, options);
  const pool = mysql.createPool(mysqlUrl);
  try {
    for (const [id, key, name, order] of [
      [m6Fixture.modules.analytics, "analysis", "数据分析", 10],
      [m6Fixture.modules.operations, "operations", "业务操作", 20],
    ] as const) {
      await pool.execute(
        `INSERT INTO modules
           (id, project_id, module_key, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
           status = 'active',
           disabled_at = NULL,
           archived_at = NULL`,
        [id, m5Fixture.projectId, key],
      );
      await pool.execute(
        `INSERT INTO module_revisions
           (id, module_id, revision, name, display_order, status,
            effective_from, created_by_user_id)
         VALUES (?, ?, 1, ?, ?, 'active', '2026-07-01 00:00:00.000', ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           display_order = VALUES(display_order),
           status = 'active',
           effective_to = NULL`,
        [stableUuid("m6-module-revision", id), id, name, order, m5Fixture.admin.id],
      );
    }

    for (const [id, moduleId, route, name, template, core, weight, frequency] of [
      [
        m6Fixture.pages.reports,
        m6Fixture.modules.analytics,
        "/reports",
        "经营分析",
        "analysis_view",
        true,
        1.2,
        "daily",
      ],
      [
        m6Fixture.pages.operations,
        m6Fixture.modules.operations,
        "/action",
        "业务操作",
        "task_operation",
        true,
        1.5,
        "daily",
      ],
      [
        m6Fixture.pages.wallboard,
        m6Fixture.modules.operations,
        "/wallboard",
        "运营驾驶舱",
        "monitoring_dashboard",
        true,
        1,
        "daily",
      ],
    ] as const) {
      await pool.execute(
        `INSERT INTO page_definitions
           (id, project_id, page_route, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
           status = 'active',
           disabled_at = NULL,
           archived_at = NULL`,
        [id, m5Fixture.projectId, route],
      );
      await pool.execute(
        `INSERT INTO page_definition_revisions
           (id, page_definition_id, revision, module_id, name, template_key,
            is_core, criticality_weight, expected_frequency, status,
            effective_from, created_by_user_id)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'active',
                 '2026-07-01 00:00:00.000', ?)
         ON DUPLICATE KEY UPDATE
           module_id = VALUES(module_id),
           name = VALUES(name),
           template_key = VALUES(template_key),
           is_core = VALUES(is_core),
           criticality_weight = VALUES(criticality_weight),
           expected_frequency = VALUES(expected_frequency),
           status = 'active',
           effective_to = NULL`,
        [
          stableUuid("m6-page-revision", id),
          id,
          moduleId,
          name,
          template,
          core,
          weight,
          frequency,
          m5Fixture.admin.id,
        ],
      );
    }

    await pool.execute(
      `UPDATE features
       SET page_definition_id = ?,
           configuration_effective_from = '2026-07-01 00:00:00.000'
       WHERE project_id = ? AND feature_key = 'sales_dashboard'`,
      [m6Fixture.pages.reports, m5Fixture.projectId],
    );
    await pool.execute(
      `UPDATE features
       SET page_definition_id = ?,
           is_key_task = TRUE,
           task_weight = CASE feature_key
             WHEN 'command_dispatch' THEN 1.5
             WHEN 'settings_save' THEN 1.2
             ELSE 1
           END,
           task_timeout_seconds = 120,
           operation_lifecycle_enabled = TRUE,
           configuration_effective_from = '2026-07-01 00:00:00.000'
       WHERE project_id = ?
         AND feature_key IN
           ('report_export', 'data_import', 'settings_save', 'command_dispatch')`,
      [m6Fixture.pages.operations, m5Fixture.projectId],
    );
    await pool.execute(
      `UPDATE features
       SET page_definition_id = ?,
           configuration_effective_from = '2026-07-01 00:00:00.000'
       WHERE project_id = ? AND feature_key = 'operations_wallboard'`,
      [m6Fixture.pages.wallboard, m5Fixture.projectId],
    );

    await pool.execute(
      `INSERT INTO project_operational_settings
         (id, project_id, version, target_users, expected_active_weekdays,
          status, effective_from, created_by_user_id)
       VALUES (?, ?, 1, 12, '[1,2,3,4,5]', 'active',
               '2026-07-01 00:00:00.000', ?)
       ON DUPLICATE KEY UPDATE
         target_users = VALUES(target_users),
         expected_active_weekdays = VALUES(expected_active_weekdays),
         status = 'active',
         effective_to = NULL`,
      [m6Fixture.settingsId, m5Fixture.projectId, m5Fixture.admin.id],
    );
  } finally {
    await pool.end();
  }
}

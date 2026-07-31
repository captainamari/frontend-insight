import mysql from "mysql2/promise";
import { DEFAULT_OPERATIONAL_PROFILE_ITEMS } from "../src/metrics.js";
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
  profileId: "40111111-1111-4111-8111-111111111111",
  assignmentId: "50111111-1111-4111-8111-111111111111",
} as const;

const itemIds = [
  "60111111-1111-4111-8111-111111111111",
  "60222222-2222-4222-8222-222222222222",
  "60333333-3333-4333-8333-333333333333",
  "60444444-4444-4444-8444-444444444444",
  "60555555-5555-4555-8555-555555555555",
  "60666666-6666-4666-8666-666666666666",
  "60777777-7777-4777-8777-777777777777",
  "60888888-8888-4888-8888-888888888888",
  "60999999-9999-4999-8999-999999999999",
  "60aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
] as const;

export async function seedM6Fixture(
  mysqlUrl: string,
  options: { origins: string[] },
): Promise<void> {
  await seedM5Fixture(mysqlUrl, options);
  const pool = mysql.createPool(mysqlUrl);
  try {
    for (const [id, key, name, weight, order] of [
      [m6Fixture.modules.analytics, "analysis", "数据分析", 1, 10],
      [m6Fixture.modules.operations, "operations", "业务操作", 1.2, 20],
    ] as const) {
      await pool.execute(
        `INSERT INTO project_modules
           (id, project_id, module_key, name, criticality_weight, display_order,
            status, effective_from)
         VALUES (?, ?, ?, ?, ?, ?, 'active', '2026-07-01 00:00:00.000')
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           criticality_weight = VALUES(criticality_weight),
           display_order = VALUES(display_order),
           status = 'active',
           disabled_at = NULL`,
        [id, m5Fixture.projectId, key, name, weight, order],
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
           (id, project_id, module_id, normalized_route, name, template_key,
            is_core, criticality_weight, expected_frequency, status, effective_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
                 '2026-07-01 00:00:00.000')
         ON DUPLICATE KEY UPDATE
           module_id = VALUES(module_id),
           name = VALUES(name),
           template_key = VALUES(template_key),
           is_core = VALUES(is_core),
           criticality_weight = VALUES(criticality_weight),
           expected_frequency = VALUES(expected_frequency),
           status = 'active',
           disabled_at = NULL`,
        [
          id,
          m5Fixture.projectId,
          moduleId,
          route,
          name,
          template,
          core,
          weight,
          frequency,
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
         (id, project_id, version, target_accounts, expected_active_weekdays,
          status, effective_from, created_by_user_id)
       VALUES (?, ?, 1, 12, '[1,2,3,4,5]', 'active',
               '2026-07-01 00:00:00.000', ?)
       ON DUPLICATE KEY UPDATE
         target_accounts = VALUES(target_accounts),
         expected_active_weekdays = VALUES(expected_active_weekdays),
         status = 'active',
         effective_to = NULL`,
      [m6Fixture.settingsId, m5Fixture.projectId, m5Fixture.admin.id],
    );
    await pool.execute(
      `INSERT INTO metric_profiles
         (id, project_id, profile_key, name, version, status, effective_from,
          created_by_user_id)
       VALUES (?, ?, 'operational_v1', '智慧园区运营指数 v1', 1, 'active',
               '2026-07-01 00:00:00.000', ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         status = 'active',
         effective_from = VALUES(effective_from)`,
      [m6Fixture.profileId, m5Fixture.projectId, m5Fixture.admin.id],
    );
    for (const [index, item] of DEFAULT_OPERATIONAL_PROFILE_ITEMS.entries()) {
      await pool.execute(
        `INSERT INTO metric_profile_items
           (id, profile_id, metric_key, dimension_key, dimension_weight,
            metric_weight, target_value, floor_value, ceiling_value,
            target_min, target_max, tolerance_min, tolerance_max,
            minimum_sample, enabled, required)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           dimension_key = VALUES(dimension_key),
           dimension_weight = VALUES(dimension_weight),
           metric_weight = VALUES(metric_weight),
           target_value = VALUES(target_value),
           floor_value = VALUES(floor_value),
           ceiling_value = VALUES(ceiling_value),
           target_min = VALUES(target_min),
           target_max = VALUES(target_max),
           tolerance_min = VALUES(tolerance_min),
           tolerance_max = VALUES(tolerance_max),
           minimum_sample = VALUES(minimum_sample),
           enabled = VALUES(enabled),
           required = VALUES(required)`,
        [
          itemIds[index]!,
          m6Fixture.profileId,
          item.metricKey,
          item.dimensionKey,
          item.dimensionWeight,
          item.metricWeight,
          item.targetValue,
          item.floorValue,
          item.ceilingValue,
          item.targetMin,
          item.targetMax,
          item.toleranceMin,
          item.toleranceMax,
          item.minimumSample,
          item.enabled,
          item.required,
        ],
      );
    }
    await pool.execute(
      `INSERT INTO metric_profile_assignments
         (id, project_id, entity_type, entity_id, profile_id, effective_from,
          created_by_user_id)
       VALUES (?, ?, 'project', ?, ?, '2026-07-01 00:00:00.000', ?)
       ON DUPLICATE KEY UPDATE
         profile_id = VALUES(profile_id),
         effective_from = VALUES(effective_from),
         effective_to = NULL`,
      [
        m6Fixture.assignmentId,
        m5Fixture.projectId,
        m5Fixture.projectId,
        m6Fixture.profileId,
        m5Fixture.admin.id,
      ],
    );
  } finally {
    await pool.end();
  }
}

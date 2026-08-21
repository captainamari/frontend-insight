import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import mysql from "mysql2/promise";

export const m5Fixture = {
  projectId: "11111111-1111-4111-8111-111111111111",
  appId: "fi_public_m1demo001",
  admin: {
    id: "55555555-5555-4555-8555-555555555555",
    identityId: "66666666-6666-4666-8666-666666666666",
    email: "admin@example.invalid",
    password: "LocalAdmin-1234",
    displayName: "Local Admin",
  },
  viewer: {
    id: "88888888-8888-4888-8888-888888888888",
    identityId: "99999999-9999-4999-8999-999999999999",
    email: "viewer@example.invalid",
    password: "LocalViewer-1234",
    displayName: "Local Viewer",
  },
  featureIds: {
    sales_dashboard: "22222222-2222-4222-8222-222222222222",
    report_export: "33333333-3333-4333-8333-333333333333",
    operations_wallboard: "44444444-4444-4444-8444-444444444444",
    data_import: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    settings_save: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    command_dispatch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  },
} as const;

const featureRows = [
  [
    m5Fixture.featureIds.sales_dashboard,
    "sales_dashboard",
    "销售数据看板",
    "data_view",
    "主要数据请求成功且图表完成渲染",
  ],
  [
    m5Fixture.featureIds.report_export,
    "report_export",
    "报告导出",
    "action",
    "文件下载真正开始",
  ],
  [
    m5Fixture.featureIds.data_import,
    "data_import",
    "数据导入",
    "action",
    "服务端确认导入完成",
  ],
  [
    m5Fixture.featureIds.settings_save,
    "settings_save",
    "配置保存",
    "action",
    "配置持久化成功",
  ],
  [
    m5Fixture.featureIds.command_dispatch,
    "command_dispatch",
    "指令下发",
    "action",
    "服务端接受指令",
  ],
  [
    m5Fixture.featureIds.operations_wallboard,
    "operations_wallboard",
    "运营大屏",
    "long_view",
    "前台连续可见达到阈值",
  ],
] as const;

export async function seedM5Fixture(
  mysqlUrl: string,
  options: { origins: string[] },
): Promise<void> {
  const pool = mysql.createPool(mysqlUrl);
  const adminHash = await hash(m5Fixture.admin.password, 12);
  const viewerHash = await hash(m5Fixture.viewer.password, 12);
  try {
    for (const [user, role, passwordHash] of [
      [m5Fixture.admin, "admin", adminHash],
      [m5Fixture.viewer, "viewer", viewerHash],
    ] as const) {
      await pool.execute(
        `INSERT INTO users (id, display_name, email, status, global_role)
         VALUES (?, ?, ?, 'active', ?)
         ON DUPLICATE KEY UPDATE
           display_name = VALUES(display_name),
           status = 'active',
           global_role = VALUES(global_role)`,
        [user.id, user.displayName, user.email, role],
      );
      await pool.execute(
        `INSERT INTO identities (id, user_id, provider, subject, password_hash)
         VALUES (?, ?, 'local', ?, ?)
         ON DUPLICATE KEY UPDATE
           user_id = VALUES(user_id),
           password_hash = VALUES(password_hash)`,
        [user.identityId, user.id, user.email, passwordHash],
      );
    }

    await pool.execute(
      `INSERT INTO projects
         (id, app_id, name, timezone, status, retention_days, created_by_user_id)
       VALUES (?, ?, 'Frontend Insight M5 Demo', 'UTC', 'active', 90, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         status = 'active',
         disabled_at = NULL`,
      [m5Fixture.projectId, m5Fixture.appId, m5Fixture.admin.id],
    );

    for (const origin of [...new Set(options.origins)]) {
      await pool.execute(
        `INSERT INTO project_origins (id, project_id, origin, enabled)
         VALUES (?, ?, ?, TRUE)
         ON DUPLICATE KEY UPDATE enabled = TRUE`,
        [randomUUID(), m5Fixture.projectId, origin],
      );
    }

    for (const [userId, role] of [
      [m5Fixture.admin.id, "owner"],
      [m5Fixture.viewer.id, "viewer"],
    ] as const) {
      await pool.execute(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
        [m5Fixture.projectId, userId, role],
      );
    }

    for (const [id, key, name, type, description] of featureRows) {
      await pool.execute(
        `INSERT INTO features
           (id, project_id, feature_key, name, description, feature_type,
            long_view_success_after_ms, heartbeat_interval_ms, launched_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 30000, 60000, CURRENT_TIMESTAMP(3), 'active')
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           description = VALUES(description),
           status = 'active',
           disabled_at = NULL`,
        [id, m5Fixture.projectId, key, name, description, type],
      );
    }

    await pool.execute(
      `INSERT INTO project_data_status (project_id) VALUES (?)
       ON DUPLICATE KEY UPDATE project_id = VALUES(project_id)`,
      [m5Fixture.projectId],
    );
  } finally {
    await pool.end();
  }
}

// Isolated R7 database/HTTP security fixtures; never production rule approval.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { MySqlStore } from "../src/mysql-store.js";
import { SettingsService, exportTokenHash } from "../src/settings.js";
import type { RowDataPacket } from "mysql2/promise";
const base = process.env.FI_API_URL ?? "http://api:3000";
if (!process.env.MYSQL_URL) throw new Error("MYSQL_URL_REQUIRED");
const mysql = new MySqlStore(process.env.MYSQL_URL),
  secondMysql = new MySqlStore(process.env.MYSQL_URL),
  one = new SettingsService(mysql),
  two = new SettingsService(secondMysql);
async function call(
  path: string,
  token: string,
  method = "GET",
  body?: unknown,
  status = 200,
) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(r.status, status, `${path}: ${r.status}`);
  return r.json() as Promise<Record<string, unknown>>;
}
try {
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "admin@example.invalid",
      password: "LocalAdmin-1234",
    }),
  });
  assert.equal(login.status, 200);
  const admin = (await login.json()) as {
    accessToken: string;
    user: { userId: string };
  };
  const project = await call(
    "/api/projects",
    admin.accessToken,
    "POST",
    {
      name: "R7 TEST ONLY shared services " + randomUUID(),
      timezone: "UTC",
      origins: ["http://127.0.0.1:4173"],
    },
    201,
  );
  const pid = String(project.id),
    actor = admin.user.userId,
    requestId = randomUUID();
  const now = Date.now(),
    scope = {
      env: "dev" as const,
      from: new Date(now - 3600000).toISOString(),
      to: new Date(now + 86400000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
      maxRangeDays: 1,
      rateLimit: 3,
    };
  const created = await one.createInterface(
    pid,
    actor,
    "metric_snapshot",
    scope,
    requestId,
  );
  assert.equal(created.enabled, false);
  const issued = await one.changeInterface(
    pid,
    actor,
    created.id,
    "enable",
    randomUUID(),
  );
  assert(issued.token);
  const token = issued.token;
  const [rows] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT token_hash,token_prefix,expires_at FROM export_credentials WHERE export_interface_id=?",
    [created.id],
  );
  assert.equal(rows[0]!.token_hash, exportTokenHash(token));
  assert.notEqual(rows[0]!.token_hash, token);
  assert.equal(rows[0]!.token_prefix, token.slice(0, 10));
  assert(!JSON.stringify(await one.interfaces(pid, 1)).includes(token));
  const q = { env: "dev", from: scope.from, to: new Date(now).toISOString() };
  // Six concurrent authorizations across separate service/store/pool instances share exactly three admissions.
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      (i % 2 ? one : two).authorizeExport(
        pid,
        "metric_snapshot",
        token,
        q,
        randomUUID(),
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert(
    results
      .filter((r) => r.status === "rejected")
      .every((r) => r.reason.code === "EXPORT_RATE_LIMITED"),
  );
  await mysql.pool.execute(
    "DELETE FROM export_rate_windows WHERE export_interface_id=?",
    [created.id],
  );
  const rotated = await two.changeInterface(
    pid,
    actor,
    created.id,
    "rotate",
    randomUUID(),
  );
  assert(rotated.token);
  await assert.rejects(
    () => one.authorizeExport(pid, "metric_snapshot", token, q, randomUUID()),
    { code: "EXPORT_REVOKED" },
  );
  await one.authorizeExport(pid, "metric_snapshot", rotated.token, q, randomUUID());
  await two.changeInterface(pid, actor, created.id, "disable", randomUUID());
  await assert.rejects(
    () => one.authorizeExport(pid, "metric_snapshot", rotated.token!, q, randomUUID()),
    { code: "EXPORT_DISABLED" },
  );
  await mysql.pool.execute(
    "DELETE FROM export_rate_windows WHERE export_interface_id=?",
    [created.id],
  );
  const renewed = await one.changeInterface(
    pid,
    actor,
    created.id,
    "enable",
    randomUUID(),
  );
  assert(renewed.token);
  await mysql.pool.execute(
    "UPDATE export_credentials SET expires_at=CURRENT_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE token_hash=?",
    [exportTokenHash(renewed.token)],
  );
  await assert.rejects(
    () => two.authorizeExport(pid, "metric_snapshot", renewed.token!, q, randomUUID()),
    { code: "EXPORT_EXPIRED" },
  );
  await mysql.pool.execute(
    "DELETE FROM export_rate_windows WHERE export_interface_id=?",
    [created.id],
  );
  for (let i = 0; i < 3; i++)
    await assert.rejects(
      () =>
        one.authorizeExport(
          pid,
          "metric_snapshot",
          "fi_" + "x".repeat(43),
          q,
          randomUUID(),
        ),
      { code: "EXPORT_CREDENTIAL_INVALID" },
    );
  await assert.rejects(
    () =>
      two.authorizeExport(
        pid,
        "metric_snapshot",
        "fi_" + "x".repeat(43),
        q,
        randomUUID(),
      ),
    { code: "EXPORT_RATE_LIMITED" },
  );
  const [audit] = await mysql.pool.query<RowDataPacket[]>(
    "SELECT action,metadata,request_id FROM audit_logs WHERE project_id=? AND entity_type='settings'",
    [pid],
  );
  const serialized = JSON.stringify(audit);
  for (const t of [token, rotated.token, renewed.token])
    assert(!serialized.includes(t));
  assert(audit.some((r) => r.action === "export.rotate"));
  assert(audit.every((r) => /^[a-f0-9-]{36}$/.test(r.request_id)));
  // Actual HTTP expiration and hashed storage are independently verified; no old success claim is reused.
  await mysql.pool.execute(
    "DELETE FROM export_rate_windows WHERE export_interface_id=?",
    [created.id],
  );
  const http = await fetch(
    base + `/api/external/projects/${pid}/metric_snapshot?` + new URLSearchParams(q),
    { headers: { authorization: `Bearer ${renewed.token}` } },
  );
  assert.equal(http.status, 403);
  assert.equal(((await http.json()) as { code: string }).code, "EXPORT_EXPIRED");
  const directory = process.env.FI_EVIDENCE_DIR ?? "../../artifacts";
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    directory + "/r7-integration.json",
    JSON.stringify(
      {
        testedCommit: process.env.GITHUB_SHA,
        realMySql: true,
        realHttp: true,
        credentialHashOnly: true,
        plaintextNotInAuditOrLists: true,
        expiredRejected: true,
        rotationImmediatelyRevokes: true,
        disabledImmediatelyRejected: true,
        sharedServiceInstances: 2,
        concurrentAttempts: 6,
        accepted: 3,
        limitPerMinute: 3,
        invalidCredentialRateLimited: true,
        cache: "No authorization or revocation cache",
        productionCapacityClaim: false,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([mysql.close(), secondMysql.close()]);
}

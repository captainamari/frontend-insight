import { m5Fixture, seedM5Fixture } from "./m5-fixture.js";

const mysqlUrl = process.env.MYSQL_URL;
if (!mysqlUrl) throw new Error("MYSQL_URL_REQUIRED");

const origins = (
  process.env.M5_PROJECT_ORIGINS ??
  "http://localhost:4173,http://127.0.0.1:4173,http://localhost:4174,http://127.0.0.1:4174"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

await seedM5Fixture(mysqlUrl, { origins });
console.log(
  JSON.stringify({
    status: "seeded",
    projectId: m5Fixture.projectId,
    projectKey: m5Fixture.projectKey,
    origins,
    users: [m5Fixture.admin.email, m5Fixture.viewer.email],
  }),
);

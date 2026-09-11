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

await seedM6Fixture(mysqlUrl, { origins });
console.log(
  JSON.stringify({
    status: "seeded",
    milestone: "M6",
    projectId: m5Fixture.projectId,
    appId: m5Fixture.appId,
    modules: Object.values(m6Fixture.modules),
    pages: Object.values(m6Fixture.pages),
    profileId: m6Fixture.profileId,
    origins,
    users: [m5Fixture.admin.email, m5Fixture.viewer.email],
  }),
);

import { loadMigrationEnvironment } from "@frontend-insight/shared-config";
import {
  runClickHouseMigrations,
  runMySqlMigrations,
  type MigrationEngine,
} from "./migrations.js";

const target = process.argv[2] ?? "all";
if (!(["all", "mysql", "clickhouse"] as const).includes(target as "all")) {
  console.error("Usage: pnpm migrate [all|mysql|clickhouse]");
  process.exitCode = 1;
} else {
  const environment = loadMigrationEnvironment();
  const engines: MigrationEngine[] =
    target === "all" ? ["mysql", "clickhouse"] : [target as MigrationEngine];
  const results = [];

  for (const engine of engines) {
    if (engine === "mysql") {
      results.push(await runMySqlMigrations({ mysqlUrl: environment.MYSQL_URL }));
    } else {
      results.push(
        await runClickHouseMigrations({
          url: environment.CLICKHOUSE_URL,
          username: environment.CLICKHOUSE_USERNAME,
          password: environment.CLICKHOUSE_PASSWORD,
          database: environment.CLICKHOUSE_DATABASE,
        }),
      );
    }
  }
  console.log(JSON.stringify({ status: "passed", results }, null, 2));
}

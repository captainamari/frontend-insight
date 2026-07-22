import { pathToFileURL } from "node:url";
import { CURRENT_SCHEMA_VERSION } from "@frontend-insight/event-contract";
import { loadApiEnvironment } from "@frontend-insight/shared-config";

export const apiModuleBoundaries = Object.freeze([
  "ingestion",
  "analytics",
  "admin",
  "system",
]);

export function bootstrapApiSkeleton(): void {
  const environment = loadApiEnvironment();
  console.log(
    JSON.stringify({
      service: "api",
      phase: "m1-skeleton",
      port: environment.API_PORT,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      modules: apiModuleBoundaries,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapApiSkeleton();
}

import { pathToFileURL } from "node:url";
import { CURRENT_SCHEMA_VERSION } from "@frontend-insight/event-contract";
import { loadConsumerEnvironment } from "@frontend-insight/shared-config";

export function bootstrapConsumerSkeleton(): void {
  const environment = loadConsumerEnvironment();
  console.log(
    JSON.stringify({
      service: "consumer",
      phase: "m1-skeleton",
      groupId: environment.CONSUMER_GROUP_ID,
      batchSize: environment.CONSUMER_BATCH_SIZE,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapConsumerSkeleton();
}

import type { FrontendInsightEventBatchV1 } from "@frontend-insight/event-contract";
import { loadWebEnvironment } from "@frontend-insight/shared-config";

export interface WebSkeletonConfiguration {
  apiBaseUrl: string;
  contractExample?: FrontendInsightEventBatchV1;
}

export function createWebSkeletonConfiguration(
  source: Record<string, string | undefined>,
): WebSkeletonConfiguration {
  const environment = loadWebEnvironment(source);
  return { apiBaseUrl: environment.PUBLIC_API_BASE_URL };
}

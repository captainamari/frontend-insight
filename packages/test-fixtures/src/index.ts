import type { FrontendInsightEventBatchV3 } from "@frontend-insight/event-contract";
import pageUsageGoldenJson from "../fixtures/golden/page-usage-v3.expected.json" with { type: "json" };
import qualityGoldenJson from "../fixtures/golden/quality-v3.expected.json" with { type: "json" };
import workflowGoldenJson from "../fixtures/golden/workflow-v3.expected.json" with { type: "json" };
import legacyV1Json from "../fixtures/invalid/legacy-v1.json" with { type: "json" };
import legacyV2Json from "../fixtures/invalid/legacy-v2.json" with { type: "json" };
import oldEventAliasJson from "../fixtures/invalid/old-event-alias-v3.json" with { type: "json" };
import oldFieldsJson from "../fixtures/invalid/old-fields-v3.json" with { type: "json" };
import privacyJson from "../fixtures/invalid/privacy-v3.json" with { type: "json" };
import pageUsageJson from "../fixtures/valid/page-usage-v3.json" with { type: "json" };
import qualityJson from "../fixtures/valid/quality-v3.json" with { type: "json" };
import workflowJson from "../fixtures/valid/workflow-v3.json" with { type: "json" };

export interface GoldenExpectation {
  scenario: "page_usage_v3" | "quality_v3" | "workflow_v3";
  eventCount: number;
  events: string[];
  customEvents?: string[];
}

export interface ContractScenario {
  name: GoldenExpectation["scenario"];
  valid: FrontendInsightEventBatchV3;
  invalid: unknown;
  golden: GoldenExpectation;
  invalidRejectionCode: string;
}

export const contractScenarios: ContractScenario[] = [
  {
    name: "page_usage_v3",
    valid: pageUsageJson as FrontendInsightEventBatchV3,
    invalid: legacyV1Json,
    golden: pageUsageGoldenJson as GoldenExpectation,
    invalidRejectionCode: "SCHEMA_VERSION_UNSUPPORTED",
  },
  {
    name: "quality_v3",
    valid: qualityJson as FrontendInsightEventBatchV3,
    invalid: oldEventAliasJson,
    golden: qualityGoldenJson as GoldenExpectation,
    invalidRejectionCode: "SCHEMA_INVALID",
  },
  {
    name: "workflow_v3",
    valid: workflowJson as FrontendInsightEventBatchV3,
    invalid: oldFieldsJson,
    golden: workflowGoldenJson as GoldenExpectation,
    invalidRejectionCode: "SCHEMA_INVALID",
  },
];

export const invalidLegacyBatches = Object.freeze([legacyV1Json, legacyV2Json]);
export const invalidPrivacyBatch = privacyJson;
export const validBatches = Object.freeze(
  contractScenarios.map((scenario) => scenario.valid),
);

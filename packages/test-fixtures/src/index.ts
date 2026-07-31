import type {
  FrontendInsightEventBatch,
  FrontendInsightEventBatchV1,
  FrontendInsightEventBatchV2,
} from "@frontend-insight/event-contract";
import actionGoldenJson from "../fixtures/golden/action.expected.json" with { type: "json" };
import dataViewGoldenJson from "../fixtures/golden/data-view.expected.json" with { type: "json" };
import longViewGoldenJson from "../fixtures/golden/long-view.expected.json" with { type: "json" };
import operationV2GoldenJson from "../fixtures/golden/operation-v2.expected.json" with { type: "json" };
import invalidActionJson from "../fixtures/invalid/action.json" with { type: "json" };
import invalidDataViewJson from "../fixtures/invalid/data-view.json" with { type: "json" };
import invalidLongViewJson from "../fixtures/invalid/long-view.json" with { type: "json" };
import invalidOperationV2Json from "../fixtures/invalid/operation-v2.json" with { type: "json" };
import validActionJson from "../fixtures/valid/action.json" with { type: "json" };
import validDataViewJson from "../fixtures/valid/data-view.json" with { type: "json" };
import validLongViewJson from "../fixtures/valid/long-view.json" with { type: "json" };
import validOperationV2Json from "../fixtures/valid/operation-v2.json" with { type: "json" };

export interface GoldenExpectation {
  scenario: "data_view" | "action" | "long_view" | "operation_v2";
  eventCount: number;
  featureKey: string;
  eventNames: string[];
}

export interface ContractScenario {
  name: GoldenExpectation["scenario"];
  valid: FrontendInsightEventBatch;
  invalid: unknown;
  golden: GoldenExpectation;
  invalidRejectionCode?: string;
}

export const contractScenarios: ContractScenario[] = [
  {
    name: "data_view",
    valid: validDataViewJson as unknown as FrontendInsightEventBatchV1,
    invalid: invalidDataViewJson,
    golden: dataViewGoldenJson as GoldenExpectation,
  },
  {
    name: "action",
    valid: validActionJson as unknown as FrontendInsightEventBatchV1,
    invalid: invalidActionJson,
    golden: actionGoldenJson as GoldenExpectation,
  },
  {
    name: "long_view",
    valid: validLongViewJson as unknown as FrontendInsightEventBatchV1,
    invalid: invalidLongViewJson,
    golden: longViewGoldenJson as GoldenExpectation,
  },
  {
    name: "operation_v2",
    valid: validOperationV2Json as unknown as FrontendInsightEventBatchV2,
    invalid: invalidOperationV2Json,
    golden: operationV2GoldenJson as GoldenExpectation,
    invalidRejectionCode: "OPERATION_INSTANCE_INVALID",
  },
];

export const validBatches = Object.freeze(
  contractScenarios.map((scenario) => scenario.valid),
);

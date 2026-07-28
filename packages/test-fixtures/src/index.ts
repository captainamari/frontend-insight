import type { FrontendInsightEventBatchV1 } from "@frontend-insight/event-contract";
import actionGoldenJson from "../fixtures/golden/action.expected.json" with { type: "json" };
import dataViewGoldenJson from "../fixtures/golden/data-view.expected.json" with { type: "json" };
import longViewGoldenJson from "../fixtures/golden/long-view.expected.json" with { type: "json" };
import invalidActionJson from "../fixtures/invalid/action.json" with { type: "json" };
import invalidDataViewJson from "../fixtures/invalid/data-view.json" with { type: "json" };
import invalidLongViewJson from "../fixtures/invalid/long-view.json" with { type: "json" };
import validActionJson from "../fixtures/valid/action.json" with { type: "json" };
import validDataViewJson from "../fixtures/valid/data-view.json" with { type: "json" };
import validLongViewJson from "../fixtures/valid/long-view.json" with { type: "json" };

export interface GoldenExpectation {
  scenario: "data_view" | "action" | "long_view";
  eventCount: number;
  featureKey: string;
  eventNames: string[];
}

export interface ContractScenario {
  name: GoldenExpectation["scenario"];
  valid: FrontendInsightEventBatchV1;
  invalid: unknown;
  golden: GoldenExpectation;
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
];

export const validBatches = Object.freeze(
  contractScenarios.map((scenario) => scenario.valid),
);

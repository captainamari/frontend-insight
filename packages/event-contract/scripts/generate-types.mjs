import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../", import.meta.url);
const repositoryRoot = new URL("../../../", import.meta.url);
const manifestPath = new URL("canonical-names.json", packageRoot);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const check = process.argv.includes("--check");

function quoteList(values) {
  return values.map((value) => JSON.stringify(value)).join(" | ");
}

function asConst(values) {
  return JSON.stringify(values, null, 2).replace(/\n/g, "\n") + " as const";
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`Canonical manifest contains duplicate ${label}`);
  }
}

assertUnique(
  manifest.publicFields.map(({ key }) => key),
  "public fields",
);
assertUnique(manifest.eventNames, "event names");
assertUnique(manifest.customEventNames, "custom event names");
assertUnique(
  manifest.metricKeys.map(({ key }) => key),
  "metric keys",
);
assertUnique(Object.values(manifest.uiChineseNames), "UI Chinese names");
if (manifest.contractVersion !== 3) {
  throw new Error("R0 only generates contract v3");
}

const commonEventProperties = {
  diagnostic: { $ref: "#/$defs/diagnostic" },
  eventId: { type: "string", pattern: "^evt_[A-Za-z0-9_-]{8,64}$" },
  appId: { type: "string", pattern: "^[a-z][a-z0-9_-]{2,63}$" },
  env: { enum: manifest.environments },
  release: {
    type: "string",
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
  },
  pageUrl: {
    type: "string",
    format: "uri",
    maxLength: 1024,
    pattern: "^[^?#]+$",
  },
  pageRoute: { type: "string", pattern: "^/[^?#]*$", maxLength: 512 },
  userId: {
    type: ["string", "null"],
    minLength: 1,
    maxLength: 128,
  },
  deptId: {
    type: ["string", "null"],
    minLength: 1,
    maxLength: 128,
  },
  roleId: {
    type: ["string", "null"],
    minLength: 1,
    maxLength: 128,
  },
  sessionId: { type: "string", pattern: "^ses_[A-Za-z0-9_-]{8,64}$" },
  deviceId: { type: "string", pattern: "^dev_[A-Za-z0-9_-]{8,64}$" },
  pageViewId: { type: "string", pattern: "^pv_[A-Za-z0-9_-]{8,64}$" },
  ua: { type: "string", minLength: 1, maxLength: 256 },
  os: { type: "string", minLength: 1, maxLength: 64 },
  browser: { type: "string", minLength: 1, maxLength: 64 },
  timestamp: { type: "integer", minimum: 0 },
};
const commonRequired = [
  "eventId",
  ...manifest.publicFields.map(({ key }) => key).filter((key) => key !== "event"),
  "pageViewId",
];

function eventVariant(event, payloadRef) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["event", ...commonRequired],
    properties: {
      ...commonEventProperties,
      event: { const: event },
      payload: { $ref: `#/$defs/${payloadRef}` },
    },
  };
}

const propertyValue = {
  oneOf: [
    { type: "string", maxLength: 256 },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
};

const qualityProperties = {
  viewportBucket: { enum: ["small", "medium", "large"] },
  qualityVersion: { const: "r5a-1" },
  qualityMask: { type: "integer", minimum: 0, maximum: 255 },
  qualityVitals: { type: "integer", minimum: 0, maximum: 31 },
  qualitySampleRate: { type: "number", minimum: 0, maximum: 1 },
};
const qualityCounters = Object.fromEntries(
  [
    "qualitySequence",
    "qualityDropped",
    "qualityFailed",
    "qualitySuppressed",
    "apiStarted",
    "apiCompleted",
    "resourceStarted",
    "resourceCompleted",
    "resourceFailed",
    "longtaskCount",
    "longtaskTotal",
  ].map((key) => [key, { type: "integer", minimum: 0, maximum: 86400000 }]),
);
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://frontend-insight.internal/schemas/event-batch-v3.json",
  title: "Frontend Insight Event Batch v3",
  description:
    "Canonical Pre-1.0 browser-to-ingestion contract. Every event is self-describing.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "sentAt", "sdk", "events"],
  properties: {
    schemaVersion: { const: manifest.contractVersion },
    sentAt: { type: "integer", minimum: 0 },
    sdk: { $ref: "#/$defs/sdk" },
    events: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { $ref: "#/$defs/event" },
    },
  },
  $defs: {
    diagnostic: {
      type: "object",
      additionalProperties: false,
      required: [
        "diagnosticVersion",
        "contentType",
        "source",
        "policyVersion",
        "status",
        "omittedBytes",
        "suppressed",
        "correlation",
        "raw",
      ],
      properties: {
        diagnosticVersion: { const: 1 },
        contentType: { const: "application/json" },
        source: { enum: ["explicit", "global", "promise", "vue", "react", "unknown"] },
        policyVersion: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
        status: {
          enum: ["complete", "truncated", "rate_limited", "too_large", "unavailable"],
        },
        omittedBytes: { type: "integer", minimum: 0, maximum: 2147483647 },
        suppressed: { type: "integer", minimum: 0, maximum: 2147483647 },
        correlation: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            [
              "requestId",
              "traceId",
              "operationInstanceId",
              "workflowInstanceId",
              "stepKey",
            ].map((key) => [
              key,
              { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
            ]),
          ),
        },
        raw: { type: "object", maxProperties: 100 },
      },
    },
    sdk: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
        usageCoverage: {
          type: "object",
          additionalProperties: false,
          required: ["droppedEvents", "failedBatches", "businessSampleRate"],
          properties: {
            businessSampleRate: { type: "number", minimum: 0, maximum: 1 },
            droppedEvents: { type: "integer", minimum: 0, maximum: 1000000 },
            failedBatches: { type: "integer", minimum: 0, maximum: 1000000 },
          },
        },
        collectors: {
          type: "array",
          uniqueItems: true,
          maxItems: 3,
          items: { enum: ["forms", "business_results", "repeated_operations"] },
        },
        version: {
          type: "string",
          pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$",
        },
      },
    },
    event: {
      oneOf: [
        eventVariant("page_view", "emptyPayload"),
        eventVariant("page_leave", "pageLeavePayload"),
        eventVariant("performance", "performancePayload"),
        eventVariant("api", "apiPayload"),
        eventVariant("error", "errorPayload"),
        eventVariant("custom", "customPayload"),
      ],
    },
    emptyPayload: {
      type: "object",
      additionalProperties: false,
      properties: { ...qualityProperties, usageVersion: { const: "r6-1" } },
    },
    pageLeavePayload: {
      type: "object",
      additionalProperties: false,
      required: ["visibleDurationMs"],
      properties: {
        ...qualityProperties,
        ...qualityCounters,
        usageVersion: { const: "r6-1" },
        usageSequence: { type: "integer", minimum: 1, maximum: 1000000 },
        usageClosed: { type: "boolean" },
        qualityClosed: { type: "boolean" },
        blankScreen: { type: "boolean" },
        blankRule: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" },
        visibleDurationMs: {
          type: "integer",
          minimum: 0,
          maximum: 604800000,
        },
      },
    },
    performancePayload: {
      type: "object",
      additionalProperties: false,
      required: ["metric", "value", "navigationType"],
      allOf: [
        {
          if: {
            properties: { metric: { enum: ["lcp", "inp", "cls", "fcp", "ttfb"] } },
            required: ["metric"],
          },
          then: { required: ["rating"], properties: { rating: true } },
        },
      ],
      properties: {
        ...qualityProperties,
        qualitySequence: { type: "integer", minimum: 1, maximum: 86400000 },
        sampleId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
        rowBucket: { enum: ["lt100", "100to1000", "gt1000"] },
        metric: { enum: manifest.performanceMetrics },
        value: { type: "number", minimum: 0, maximum: 86400000 },
        rating: { enum: ["good", "needs_improvement", "poor"] },
        navigationType: {
          enum: ["navigate", "reload", "back_forward", "prerender", "unknown"],
        },
      },
    },
    apiPayload: {
      type: "object",
      additionalProperties: false,
      required: ["success", "requestMethod", "requestPath", "statusCode", "durationMs"],
      properties: {
        ...qualityProperties,
        apiRequestId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
        success: { type: "boolean" },
        requestMethod: {
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OTHER"],
        },
        requestPath: { type: "string", pattern: "^/[^?#]*$", maxLength: 256 },
        statusCode: { type: "integer", minimum: 0, maximum: 599 },
        durationMs: { type: "integer", minimum: 0, maximum: 86400000 },
        failureType: {
          enum: ["http", "network", "timeout", "aborted", "business", "none"],
        },
      },
    },
    errorPayload: {
      type: "object",
      additionalProperties: false,
      required: ["errorType", "errorCategory"],
      properties: {
        ...qualityProperties,
        breadcrumb: {
          type: "object",
          maxProperties: 50,
          propertyNames: { pattern: "^b[0-9]{1,2}$" },
          additionalProperties: {
            enum: [
              "navigation",
              "action",
              "api_success",
              "api_failure",
              "visible",
              "hidden",
            ],
          },
        },
        errorType: { enum: ["js", "resource"] },
        errorCategory: {
          enum: ["resource", "vue", "react", "promise", "js", "other"],
        },
        errorName: { type: "string", minLength: 1, maxLength: 120 },
        errorMessage: { type: "string", minLength: 1, maxLength: 256 },
        stackTopFrame: { type: "string", maxLength: 256 },
        resourceType: {
          enum: ["script", "stylesheet", "image", "font", "media", "other"],
        },
        requestPath: { type: "string", pattern: "^/[^?#]*$", maxLength: 256 },
      },
      allOf: [
        {
          if: {
            properties: { errorType: { const: "js" } },
            required: ["errorType"],
          },
          then: {
            required: ["errorName", "errorMessage", "stackTopFrame"],
            properties: {
              errorName: true,
              errorMessage: true,
              stackTopFrame: true,
            },
          },
        },
        {
          if: {
            properties: { errorType: { const: "resource" } },
            required: ["errorType"],
          },
          then: {
            required: ["resourceType", "requestPath"],
            properties: { resourceType: true, requestPath: true },
          },
        },
      ],
    },
    customPayload: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      allOf: [
        {
          if: {
            anyOf: [
              "workflowKey",
              "workflowDefinitionVersion",
              "workflowStepKey",
              "workflowStepOrder",
            ].map((key) => ({ required: [key], properties: { [key]: true } })),
          },
          then: {
            required: [
              "workflowInstanceId",
              "workflowKey",
              "workflowDefinitionVersion",
            ],
            properties: {
              workflowInstanceId: true,
              workflowKey: true,
              workflowDefinitionVersion: true,
            },
          },
        },
        {
          if: {
            properties: {
              name: {
                enum: [
                  "workflow_started",
                  "workflow_completed",
                  "workflow_failed",
                  "workflow_canceled",
                ],
              },
            },
            required: ["name"],
          },
          then: {
            properties: {
              workflowStepKey: false,
              workflowStepOrder: false,
              operationInstanceId: false,
              interactionType: false,
            },
          },
        },
        {
          if: {
            properties: { name: { type: "string", pattern: "^workflow_" } },
            required: ["name"],
          },
          then: {
            required: [
              "workflowInstanceId",
              "workflowKey",
              "workflowDefinitionVersion",
            ],
            properties: {
              workflowInstanceId: true,
              workflowKey: true,
              workflowDefinitionVersion: true,
              labels: false,
              featureKey: false,
              visibleDurationMs: false,
            },
          },
        },
        {
          if: {
            properties: { name: { const: "workflow_step_reached" } },
            required: ["name"],
          },
          then: {
            required: ["workflowStepKey", "workflowStepOrder"],
            properties: { workflowStepKey: true, workflowStepOrder: true },
          },
        },
        {
          if: {
            required: ["workflowInstanceId"],
            properties: { workflowInstanceId: true },
          },
          then: {
            required: ["workflowKey", "workflowDefinitionVersion"],
            properties: {
              workflowKey: true,
              workflowDefinitionVersion: true,
              labels: false,
              reasonCode: false,
              visibleDurationMs: false,
            },
          },
        },
      ],
      properties: {
        name: { enum: manifest.customEventNames },
        featureKey: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        reasonCode: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
        visibleDurationMs: {
          type: "integer",
          minimum: 0,
          maximum: 604800000,
        },
        operationInstanceId: {
          type: "string",
          pattern: "^op_[A-Za-z0-9_-]{16,64}$",
        },
        workflowInstanceId: {
          type: "string",
          pattern: "^wf_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$",
        },
        workflowKey: {
          type: "string",
          pattern: "^[a-z][a-z0-9_]{0,63}$",
        },
        workflowDefinitionVersion: { type: "integer", minimum: 1 },
        workflowStepKey: {
          type: "string",
          pattern: "^[a-z][a-z0-9_]{0,63}$",
        },
        workflowStepOrder: { type: "integer", minimum: 1, maximum: 20 },
        interactionType: {
          enum: ["click", "submit", "keyboard", "programmatic", "automatic"],
        },
        labels: {
          type: "object",
          maxProperties: 12,
          propertyNames: { pattern: "^[a-z][A-Za-z0-9_]{0,63}$" },
          additionalProperties: propertyValue,
        },
      },
    },
  },
};

// R4-C summaries use exact fields. No labels, DOM values or arbitrary objects.
const formFields = {
  formId: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
  formInstanceId: { type: "string", pattern: "^frm_[0-9a-f]{32}$" },
  changeCount: { type: "integer", minimum: 0, maximum: 10000 },
  resetCount: { type: "integer", minimum: 0, maximum: 10000 },
  submitCount: { type: "integer", minimum: 0, maximum: 10000 },
  validationFailureCount: { type: "integer", minimum: 0, maximum: 10000 },
  counterOverflow: { type: "boolean" },
  sampleRate: { type: "number", exclusiveMinimum: 0, maximum: 1 },
};
Object.assign(schema.$defs.customPayload.properties, formFields, {
  objectReference: {
    type: "string",
    maxLength: 2048,
    pattern: "^or1_[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$",
  },
  repeatedEligible: { const: true },
  businessSampleRate: { type: "number", exclusiveMinimum: 0, maximum: 1 },
  businessAdapter: { const: true },
  businessResult: {
    enum: ["success", "rejected", "technical_failure", "canceled", "unknown"],
  },
});
schema.$defs.customPayload.allOf.push(
  {
    if: {
      anyOf: [
        { required: ["objectReference"], properties: { objectReference: true } },
        { required: ["repeatedEligible"], properties: { repeatedEligible: true } },
      ],
    },
    then: { properties: { name: { const: "feature_started" } } },
  },
  {
    if: { properties: { name: { const: "form_summary" } }, required: ["name"] },
    then: {
      required: Object.keys(formFields),
      properties: Object.fromEntries(Object.keys(formFields).map((k) => [k, true])),
      propertyNames: { enum: ["name", ...Object.keys(formFields)] },
    },
    else: {
      properties: Object.fromEntries(Object.keys(formFields).map((k) => [k, false])),
    },
  },
  {
    if: {
      anyOf: [
        "businessAdapter",
        "businessResult",
        "businessSampleRate",
        "objectReference",
        "repeatedEligible",
      ].map((k) => ({
        required: [k],
        properties: { [k]: true },
      })),
    },
    then: {
      required: ["businessAdapter", "featureKey", "operationInstanceId"],
      properties: {
        businessAdapter: true,
        featureKey: true,
        operationInstanceId: true,
        name: {
          enum: [
            "feature_started",
            "feature_succeeded",
            "feature_failed",
            "feature_canceled",
          ],
        },
        labels: false,
      },
    },
  },
);

const canonicalTypes = `/* AUTO-GENERATED from canonical-names.json. Do not edit directly. */

export const CANONICAL_PUBLIC_FIELDS = ${asConst(manifest.publicFields.map(({ key }) => key))};
export const CANONICAL_EVENT_NAMES = ${asConst(manifest.eventNames)};
export const CANONICAL_CUSTOM_EVENT_NAMES = ${asConst(manifest.customEventNames)};
export const CANONICAL_ENVIRONMENTS = ${asConst(manifest.environments)};
export const CANONICAL_PERFORMANCE_METRICS = ${asConst(manifest.performanceMetrics)};
export const CANONICAL_METRIC_KEYS = ${asConst(manifest.metricKeys.map(({ key }) => key))};
export const CANONICAL_UI_CHINESE_NAMES = ${JSON.stringify(manifest.uiChineseNames, null, 2)} as const;
export const CANONICAL_ROUTES = ${JSON.stringify(manifest.routes, null, 2)} as const;
export const CANONICAL_API_NAMES = ${JSON.stringify(manifest.apiNames, null, 2)} as const;
export const CANONICAL_RANGES = ${JSON.stringify(manifest.ranges, null, 2)} as const;
export const FORBIDDEN_ALIASES = ${JSON.stringify(manifest.forbiddenAliases, null, 2)} as const;

export type CanonicalPublicField = (typeof CANONICAL_PUBLIC_FIELDS)[number];
export type CanonicalEventName = (typeof CANONICAL_EVENT_NAMES)[number];
export type CanonicalCustomEventName = (typeof CANONICAL_CUSTOM_EVENT_NAMES)[number];
export type CanonicalEnvironment = (typeof CANONICAL_ENVIRONMENTS)[number];
export type CanonicalMetricKey = (typeof CANONICAL_METRIC_KEYS)[number];
`;

const eventTypes = `/* AUTO-GENERATED from canonical-names.json. Do not edit directly. */

export type FrontendInsightEnvironment = ${quoteList(manifest.environments)};
export type FrontendInsightEventName = ${quoteList(manifest.eventNames)};
export type FrontendInsightCustomEventName = ${quoteList(manifest.customEventNames)};

export type PayloadValue = string | number | boolean | null;

export interface FrontendInsightSdk {
  name: string;
  version: string;
  usageCoverage?: { droppedEvents: number; failedBatches: number; businessSampleRate: number };
  collectors?: ("forms" | "business_results" | "repeated_operations")[];
}

export interface DiagnosticEnvelope {
  diagnosticVersion: 1;
  contentType: "application/json";
  source: "explicit" | "global" | "promise" | "vue" | "react" | "unknown";
  policyVersion: string;
  status: "complete" | "truncated" | "rate_limited" | "too_large" | "unavailable";
  omittedBytes: number;
  suppressed: number;
  correlation: { requestId?: string; traceId?: string; operationInstanceId?: string; workflowInstanceId?: string; stepKey?: string };
  raw: Record<string, unknown>;
}

export interface FrontendInsightEventV3 {
  diagnostic?: DiagnosticEnvelope;
  eventId: string;
  event: FrontendInsightEventName;
  appId: string;
  env: FrontendInsightEnvironment;
  release: string;
  pageUrl: string;
  pageRoute: string;
  userId: string | null;
  deptId: string | null;
  roleId: string | null;
  sessionId: string;
  deviceId: string;
  pageViewId: string;
  ua: string;
  os: string;
  browser: string;
  timestamp: number;
  payload: Record<string, PayloadValue | Record<string, PayloadValue>>;
}

export interface FrontendInsightEventBatchV3 {
  schemaVersion: 3;
  sentAt: number;
  sdk: FrontendInsightSdk;
  events: FrontendInsightEventV3[];
}
`;

const metricSeed = `/* AUTO-GENERATED from packages/event-contract/canonical-names.json. Do not edit directly. */

export type SystemMetricImplementationStatus = "implemented" | "partial" | "not_collected";

export interface SystemMetricSeed {
  metricKey: string;
  displayName: string;
  category: "usage" | "operation" | "performance" | "stability" | "organization" | "score";
  implementationStatus: SystemMetricImplementationStatus;
  milestone: string;
}

export const SYSTEM_METRIC_SEED: readonly SystemMetricSeed[] = Object.freeze(
  ${JSON.stringify(
    manifest.metricKeys.map(
      ({ key, label, category, milestone, implementationStatus }) => ({
        metricKey: key,
        displayName: label,
        category,
        implementationStatus,
        milestone,
      }),
    ),
    null,
    2,
  )},
);
`;

const docs = `# v1.8 规范名（生成文件）

> 来源：\`packages/event-contract/canonical-names.json\`。请勿直接编辑本文件。

## 公共事件字段

| 字段 | 中文名 |
| --- | --- |
${manifest.publicFields.map(({ key, label }) => `| \`${key}\` | ${label} |`).join("\n")}

## 事件类型

${manifest.eventNames.map((name) => `- \`${name}\``).join("\n")}

## UI 中文名

| key | 中文名 |
| --- | --- |
${Object.entries(manifest.uiChineseNames)
  .map(([key, label]) => `| \`${key}\` | ${label} |`)
  .join("\n")}

## 附件保留指标 key

| key | 中文名 | 类别 | 实施状态 | 交付里程碑 |
| --- | --- | --- | --- | --- |
${manifest.metricKeys.map((metric) => `| \`${metric.key}\` | ${metric.label} | ${metric.category} | \`${metric.implementationStatus}\` | ${metric.milestone} |`).join("\n")}
`;

const outputs = [
  [new URL("src/generated/canonical-names.ts", packageRoot), canonicalTypes],
  [new URL("src/generated/event-batch-v3.ts", packageRoot), eventTypes],
  [
    new URL("schema/event-batch-v3.schema.json", packageRoot),
    `${JSON.stringify(schema, null, 2)}\n`,
  ],
  [
    new URL("packages/server-core/src/generated/system-metric-seed.ts", repositoryRoot),
    metricSeed,
  ],
  [new URL("docs/contracts/canonical-names-v1.8.md", repositoryRoot), docs],
];

for (const [url, content] of outputs) {
  const path = fileURLToPath(url);
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== content) {
      console.error(`Generated artifact is stale: ${path}`);
      process.exitCode = 1;
    }
  } else {
    await mkdir(new URL("./", url), { recursive: true });
    await writeFile(path, content, "utf8");
    console.log(`Generated ${path}`);
  }
}

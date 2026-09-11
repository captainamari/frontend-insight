import { readFileSync } from "node:fs";
import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");
const logLevel = z.enum(["debug", "info", "warn", "error"]);
const nodeEnvironment = z.enum(["development", "test", "production"]);

const serverBase = {
  NODE_ENV: nodeEnvironment,
  LOG_LEVEL: logLevel.default("info"),
};

const apiEnvironmentSchema = z.object({
  ...serverBase,
  API_PORT: positiveInteger.max(65535),
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((value) => value.split(",").map((item) => item.trim()))
    .refine((items) => items.every(Boolean), "must contain valid broker hosts"),
  MYSQL_URL: z.string().url(),
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_USERNAME: z.string().min(1).default("default"),
  CLICKHOUSE_PASSWORD: z.string(),
  CLICKHOUSE_DATABASE: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  ACCOUNT_HMAC_KEY: z.string().min(32),
  AUTH_TOKEN_SECRET: z.string().min(32),
  KAFKA_EVENTS_TOPIC: z.string().min(1).default("frontend-insight.events.v1"),
  KAFKA_DLQ_TOPIC: z.string().min(1).default("frontend-insight.events.dlq.v1"),
  PROJECT_CACHE_TTL_MS: positiveInteger.max(300_000).default(30_000),
  INGESTION_RATE_LIMIT_PER_MINUTE: positiveInteger.max(100_000).default(600),
  REFRESH_COOKIE_SECURE: booleanString.default(true),
});

const consumerEnvironmentSchema = z.object({
  ...serverBase,
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((value) => value.split(",").map((item) => item.trim()))
    .refine((items) => items.every(Boolean), "must contain valid broker hosts"),
  CONSUMER_GROUP_ID: z.string().min(1).max(128),
  CONSUMER_BATCH_SIZE: positiveInteger.max(5000),
  CONSUMER_FLUSH_TIMEOUT_MS: positiveInteger.max(60_000).default(5_000),
  CONSUMER_MAX_RETRIES: positiveInteger.max(10).default(3),
  CONSUMER_RETRY_PAUSE_MS: positiveInteger.max(300_000).default(30_000),
  CONSUMER_HEALTH_PORT: positiveInteger.max(65535).default(3200),
  KAFKA_EVENTS_TOPIC: z.string().min(1).default("frontend-insight.events.v1"),
  KAFKA_DLQ_TOPIC: z.string().min(1).default("frontend-insight.events.dlq.v1"),
  MYSQL_URL: z.string().url(),
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_USERNAME: z.string().min(1).default("default"),
  CLICKHOUSE_PASSWORD: z.string(),
  CLICKHOUSE_DATABASE: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
});

const webEnvironmentSchema = z.object({
  PUBLIC_API_BASE_URL: z.string().url(),
});

const migrationEnvironmentSchema = z.object({
  MYSQL_URL: z.string().url(),
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_USERNAME: z.string().min(1).default("m1"),
  CLICKHOUSE_PASSWORD: z.string().min(1),
  CLICKHOUSE_DATABASE: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
});

export class EnvironmentValidationError extends Error {
  readonly missingOrInvalidKeys: string[];

  constructor(scope: string, issues: z.core.$ZodIssue[]) {
    const keys = [...new Set(issues.map((issue) => String(issue.path[0] ?? "$")))];
    super(`${scope} environment is invalid: ${keys.join(", ")}`);
    this.name = "EnvironmentValidationError";
    this.missingOrInvalidKeys = keys;
  }
}

export class EnvironmentSecretFileError extends Error {
  constructor(readonly key: string) {
    super(`environment secret file is unreadable or empty: ${key}_FILE`);
    this.name = "EnvironmentSecretFileError";
  }
}

function hydrateSecretFiles(
  source: Record<string, string | undefined>,
  keys: string[],
): Record<string, string | undefined> {
  const hydrated = { ...source };
  for (const key of keys) {
    if (hydrated[key]) continue;
    const file = hydrated[`${key}_FILE`];
    if (!file) continue;
    try {
      const value = readFileSync(file, "utf8").trim();
      if (!value) throw new Error("empty");
      hydrated[key] = value;
    } catch {
      throw new EnvironmentSecretFileError(key);
    }
  }
  return hydrated;
}

function parseEnvironment<T extends z.ZodType>(
  scope: string,
  schema: T,
  source: Record<string, string | undefined>,
): z.output<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvironmentValidationError(scope, result.error.issues);
  }
  return result.data;
}

export type ApiEnvironment = z.output<typeof apiEnvironmentSchema>;
export type ConsumerEnvironment = z.output<typeof consumerEnvironmentSchema>;
export type WebEnvironment = z.output<typeof webEnvironmentSchema>;
export type MigrationEnvironment = z.output<typeof migrationEnvironmentSchema>;

export function loadApiEnvironment(
  source: Record<string, string | undefined> = process.env,
): ApiEnvironment {
  return parseEnvironment(
    "api",
    apiEnvironmentSchema,
    hydrateSecretFiles(source, [
      "MYSQL_URL",
      "CLICKHOUSE_PASSWORD",
      "ACCOUNT_HMAC_KEY",
      "AUTH_TOKEN_SECRET",
    ]),
  );
}

export function loadConsumerEnvironment(
  source: Record<string, string | undefined> = process.env,
): ConsumerEnvironment {
  return parseEnvironment(
    "consumer",
    consumerEnvironmentSchema,
    hydrateSecretFiles(source, ["MYSQL_URL", "CLICKHOUSE_PASSWORD"]),
  );
}

export function loadWebEnvironment(
  source: Record<string, string | undefined>,
): WebEnvironment {
  return parseEnvironment("web", webEnvironmentSchema, source);
}

export function loadMigrationEnvironment(
  source: Record<string, string | undefined> = process.env,
): MigrationEnvironment {
  return parseEnvironment(
    "migration",
    migrationEnvironmentSchema,
    hydrateSecretFiles(source, ["MYSQL_URL", "CLICKHOUSE_PASSWORD"]),
  );
}

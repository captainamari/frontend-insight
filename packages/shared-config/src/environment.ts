import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
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
  ACCOUNT_HMAC_KEY: z.string().min(32),
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
  CLICKHOUSE_URL: z.string().url(),
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
  return parseEnvironment("api", apiEnvironmentSchema, source);
}

export function loadConsumerEnvironment(
  source: Record<string, string | undefined> = process.env,
): ConsumerEnvironment {
  return parseEnvironment("consumer", consumerEnvironmentSchema, source);
}

export function loadWebEnvironment(
  source: Record<string, string | undefined>,
): WebEnvironment {
  return parseEnvironment("web", webEnvironmentSchema, source);
}

export function loadMigrationEnvironment(
  source: Record<string, string | undefined> = process.env,
): MigrationEnvironment {
  return parseEnvironment("migration", migrationEnvironmentSchema, source);
}

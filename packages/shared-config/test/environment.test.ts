import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EnvironmentSecretFileError,
  EnvironmentValidationError,
  loadApiEnvironment,
  loadConsumerEnvironment,
  loadWebEnvironment,
} from "../src/index.js";

describe("environment validation", () => {
  it("fails fast and reports keys without echoing secret values", () => {
    const secret = "short-secret-value-that-must-not-be-logged";
    expect(() =>
      loadApiEnvironment({
        NODE_ENV: "development",
        LOG_LEVEL: "info",
        API_PORT: "3000",
        KAFKA_BROKERS: "kafka:9092",
        MYSQL_URL: "not-a-url",
        CLICKHOUSE_URL: "http://clickhouse:8123",
        CLICKHOUSE_PASSWORD: "local-only",
        CLICKHOUSE_DATABASE: "frontend_insight",
        ACCOUNT_HMAC_KEY: secret,
        AUTH_TOKEN_SECRET: "test-token-secret-at-least-32-characters",
      }),
    ).toThrow(EnvironmentValidationError);

    try {
      loadApiEnvironment({});
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain("API_PORT");
    }
  });

  it("parses numeric and list fields once at the process boundary", () => {
    const environment = loadConsumerEnvironment({
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
      KAFKA_BROKERS: "kafka-a:9092, kafka-b:9092",
      CONSUMER_GROUP_ID: "frontend-insight-consumer",
      CONSUMER_BATCH_SIZE: "500",
      MYSQL_URL: "mysql://user:password@mysql:3306/frontend_insight",
      CLICKHOUSE_URL: "http://clickhouse:8123",
      CLICKHOUSE_PASSWORD: "local-only",
      CLICKHOUSE_DATABASE: "frontend_insight",
    });

    expect(environment.KAFKA_BROKERS).toEqual(["kafka-a:9092", "kafka-b:9092"]);
    expect(environment.CONSUMER_BATCH_SIZE).toBe(500);
  });

  it("keeps browser configuration intentionally small", () => {
    expect(
      loadWebEnvironment({ PUBLIC_API_BASE_URL: "http://localhost:3000" }),
    ).toEqual({ PUBLIC_API_BASE_URL: "http://localhost:3000" });
  });

  it("loads production secrets from mounted files without exposing values", () => {
    const directory = mkdtempSync(join(tmpdir(), "frontend-insight-secret-"));
    try {
      const mysqlFile = join(directory, "mysql-url");
      const clickhouseFile = join(directory, "clickhouse-password");
      writeFileSync(mysqlFile, "mysql://user:secret@mysql:3306/frontend_insight\n", {
        mode: 0o600,
      });
      writeFileSync(clickhouseFile, "clickhouse-secret\n", { mode: 0o600 });
      const environment = loadConsumerEnvironment({
        NODE_ENV: "production",
        KAFKA_BROKERS: "kafka:9092",
        CONSUMER_GROUP_ID: "frontend-insight-production",
        CONSUMER_BATCH_SIZE: "500",
        MYSQL_URL_FILE: mysqlFile,
        CLICKHOUSE_URL: "http://clickhouse:8123",
        CLICKHOUSE_PASSWORD_FILE: clickhouseFile,
        CLICKHOUSE_DATABASE: "frontend_insight",
      });
      expect(environment.MYSQL_URL).toContain("mysql:3306");
      expect(environment.CLICKHOUSE_PASSWORD).toBe("clickhouse-secret");
      expect(() =>
        loadConsumerEnvironment({
          NODE_ENV: "production",
          KAFKA_BROKERS: "kafka:9092",
          CONSUMER_GROUP_ID: "frontend-insight-production",
          CONSUMER_BATCH_SIZE: "500",
          MYSQL_URL_FILE: join(directory, "missing-secret"),
          CLICKHOUSE_URL: "http://clickhouse:8123",
          CLICKHOUSE_PASSWORD_FILE: clickhouseFile,
          CLICKHOUSE_DATABASE: "frontend_insight",
        }),
      ).toThrow(EnvironmentSecretFileError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

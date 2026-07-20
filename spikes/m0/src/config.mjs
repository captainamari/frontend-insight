function integerFromEnvironment(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig() {
  return {
    api: {
      host: process.env.M0_API_HOST ?? "0.0.0.0",
      port: integerFromEnvironment("M0_API_PORT", 3100),
      baseUrl: process.env.M0_API_BASE_URL ?? "http://spike-app:3100",
      publicUrl: process.env.M0_PUBLIC_API_URL ?? "http://localhost:3100",
      allowedOrigin: process.env.M0_ALLOWED_ORIGIN ?? "http://localhost:4173",
    },
    demo: {
      host: process.env.M0_DEMO_HOST ?? "0.0.0.0",
      port: integerFromEnvironment("M0_DEMO_PORT", 4173),
      baseUrl: process.env.M0_DEMO_BASE_URL ?? "http://spike-app:4173",
    },
    mysql: {
      host: process.env.M0_MYSQL_HOST ?? "mysql",
      port: integerFromEnvironment("M0_MYSQL_PORT", 3306),
      user: process.env.M0_MYSQL_USER ?? "m0",
      password: process.env.M0_MYSQL_PASSWORD ?? "m0-mysql-local-only",
      database: process.env.M0_MYSQL_DATABASE ?? "frontend_insight_m0",
    },
    clickhouse: {
      url: process.env.M0_CLICKHOUSE_URL ?? "http://clickhouse:8123",
      username: process.env.M0_CLICKHOUSE_USER ?? "m0",
      password:
        process.env.M0_CLICKHOUSE_PASSWORD ?? "m0-clickhouse-local-only",
      database:
        process.env.M0_CLICKHOUSE_DATABASE ?? "frontend_insight_m0",
    },
    kafka: {
      brokers: (process.env.M0_KAFKA_BROKERS ?? "kafka:9092")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      topic: process.env.M0_KAFKA_TOPIC ?? "frontend-insight-m0-events",
      publisherEnabled: process.env.M0_KAFKA_PUBLISHER_ENABLED === "1",
    },
    ingestion: {
      accountHmacKey:
        process.env.M0_ACCOUNT_HMAC_KEY ??
        "m0-account-hmac-local-only-change-me",
    },
    consumer: {
      healthPort: integerFromEnvironment("M0_CONSUMER_HEALTH_PORT", 3200),
    },
  };
}

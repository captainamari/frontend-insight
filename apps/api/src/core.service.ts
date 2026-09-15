import {
  AnalyticsStore,
  AuthManager,
  IngestionManager,
  KafkaEnvelopePublisher,
  MetricLibraryService,
  ScoreManagementService,
  ProjectSummaryService,
  ProjectOverviewService,
  OverviewFactStore,
  MySqlStore,
  ObservabilityStore,
} from "@frontend-insight/server-core";
import {
  loadApiEnvironment,
  type ApiEnvironment,
} from "@frontend-insight/shared-config";
import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";

@Injectable()
export class CoreService implements OnModuleDestroy {
  readonly environment: ApiEnvironment = loadApiEnvironment();
  readonly mysql = new MySqlStore(this.environment.MYSQL_URL);
  readonly metricLibrary = new MetricLibraryService(this.mysql);
  readonly scores = new ScoreManagementService(this.mysql, this.metricLibrary);
  readonly publisher = new KafkaEnvelopePublisher(
    this.environment.KAFKA_BROKERS,
    this.environment.KAFKA_EVENTS_TOPIC,
  );
  readonly ingestion = new IngestionManager(
    this.mysql,
    this.publisher,
    this.environment.ACCOUNT_HMAC_KEY,
    {
      projectCacheTtlMs: this.environment.PROJECT_CACHE_TTL_MS,
      maximumRequestsPerMinute: this.environment.INGESTION_RATE_LIMIT_PER_MINUTE,
    },
  );
  readonly auth = new AuthManager(this.mysql, this.environment.AUTH_TOKEN_SECRET);
  readonly analytics = new AnalyticsStore(
    {
      url: this.environment.CLICKHOUSE_URL,
      username: this.environment.CLICKHOUSE_USERNAME,
      password: this.environment.CLICKHOUSE_PASSWORD,
      database: this.environment.CLICKHOUSE_DATABASE,
    },
    this.mysql,
  );
  readonly observability = new ObservabilityStore(
    {
      url: this.environment.CLICKHOUSE_URL,
      username: this.environment.CLICKHOUSE_USERNAME,
      password: this.environment.CLICKHOUSE_PASSWORD,
      database: this.environment.CLICKHOUSE_DATABASE,
    },
    this.mysql,
  );

  readonly projectSummary = new ProjectSummaryService(
    this.mysql,
    this.scores,
    this.analytics,
  );

  readonly overviewFacts = new OverviewFactStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });
  readonly projectOverview = new ProjectOverviewService(
    this.mysql,
    this.scores,
    this.analytics,
    this.overviewFacts,
    this.observability,
  );

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.publisher.disconnect(),
      this.analytics.close(),
      this.overviewFacts.close(),
      this.observability.close(),
      this.mysql.close(),
    ]);
  }
}

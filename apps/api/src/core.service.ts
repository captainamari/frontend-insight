import {
  SettingsService,
  SettingsFactStore,
  QualityFactStore,
  PageQualityStore,
  PageUsageStore,
  UsageSourceService,
  OrganizationDirectoryService,
  EfficiencyFactStore,
  readDirectories,
  AnalyticsStore,
  AuthManager,
  IngestionManager,
  KafkaEnvelopePublisher,
  MetricLibraryService,
  ScoreManagementService,
  ProjectSummaryService,
  ProjectOverviewService,
  OverviewFactStore,
  BusinessFactStore,
  WorkflowFactStore,
  BusinessAnalysisService,
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
  readonly settings = new SettingsService(this.mysql);
  readonly settingsFacts = new SettingsFactStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });
  readonly usageSource = new UsageSourceService(this.mysql);
  readonly directory = new OrganizationDirectoryService(
    this.mysql,
    this.environment.ACCOUNT_HMAC_KEY,
  );
  readonly metricLibrary = new MetricLibraryService(this.mysql);
  readonly workflowFacts = new WorkflowFactStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });
  readonly pageQuality = new PageQualityStore(
    {
      url: this.environment.CLICKHOUSE_URL,
      username: this.environment.CLICKHOUSE_USERNAME,
      password: this.environment.CLICKHOUSE_PASSWORD,
      database: this.environment.CLICKHOUSE_DATABASE,
    },
    this.environment.AUTH_TOKEN_SECRET,
  );
  readonly pageUsage = new PageUsageStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });
  readonly qualityFacts = new QualityFactStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });
  readonly scores = new ScoreManagementService(
    this.mysql,
    this.metricLibrary,
    this.workflowFacts,
    this.qualityFacts,
  );
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
      checkProbe: (project, version) => this.settings.assertProbe(project, version),
      directories: (projectId) => readDirectories(this.mysql.pool, projectId),
      maximumRequestsPerMinute: this.environment.INGESTION_RATE_LIMIT_PER_MINUTE,
    },
  );
  readonly auth = new AuthManager(this.mysql, this.environment.AUTH_TOKEN_SECRET);
  readonly analytics = new AnalyticsStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });
  readonly observability = new ObservabilityStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });

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

  readonly businessFacts = new BusinessFactStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });
  readonly efficiencyFacts = new EfficiencyFactStore({
    url: this.environment.CLICKHOUSE_URL,
    username: this.environment.CLICKHOUSE_USERNAME,
    password: this.environment.CLICKHOUSE_PASSWORD,
    database: this.environment.CLICKHOUSE_DATABASE,
  });
  readonly businessAnalysis = new BusinessAnalysisService(
    this.mysql,
    this.scores,
    this.businessFacts,
    this.workflowFacts,
    this.efficiencyFacts,
  );

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.publisher.disconnect(),
      this.analytics.close(),
      this.overviewFacts.close(),
      this.businessFacts.close(),
      this.efficiencyFacts.close(),
      this.workflowFacts.close(),
      this.qualityFacts.close(),
      this.pageQuality.close(),
      this.pageUsage.close(),
      this.settingsFacts.close(),
      this.observability.close(),
      this.mysql.close(),
    ]);
  }
}

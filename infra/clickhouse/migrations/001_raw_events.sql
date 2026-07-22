CREATE TABLE IF NOT EXISTS raw_events (
  event_id String,
  schema_version UInt16,
  sdk_version LowCardinality(String),
  project_id UUID,
  event_name LowCardinality(String),
  event_time DateTime64(3, 'UTC'),
  received_at DateTime64(3, 'UTC'),
  visitor_id String,
  session_id String,
  page_view_id String,
  account_id Nullable(String),
  feature_id Nullable(UUID),
  feature_key Nullable(String),
  feature_stage Nullable(String),
  duration_ms Nullable(UInt64),
  route String,
  title Nullable(String),
  visible_duration_ms Nullable(UInt64),
  properties_json String,
  request_id UUID,
  origin String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(received_at)
ORDER BY (project_id, toDate(received_at), event_name, route, event_time, event_id)
TTL received_at + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;

ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS release_version LowCardinality(Nullable(String))
  AFTER interaction_type,
  ADD COLUMN IF NOT EXISTS deployment_environment LowCardinality(Nullable(String))
  AFTER release_version,
  ADD COLUMN IF NOT EXISTS browser_family LowCardinality(Nullable(String))
  AFTER deployment_environment,
  ADD COLUMN IF NOT EXISTS os_family LowCardinality(Nullable(String))
  AFTER browser_family,
  ADD COLUMN IF NOT EXISTS viewport_bucket LowCardinality(Nullable(String))
  AFTER os_family,
  ADD COLUMN IF NOT EXISTS error_type LowCardinality(Nullable(String))
  AFTER viewport_bucket,
  ADD COLUMN IF NOT EXISTS error_name Nullable(String)
  AFTER error_type,
  ADD COLUMN IF NOT EXISTS error_message Nullable(String)
  AFTER error_name,
  ADD COLUMN IF NOT EXISTS error_stack_frame Nullable(String)
  AFTER error_message,
  ADD COLUMN IF NOT EXISTS error_group_id Nullable(String)
  AFTER error_stack_frame,
  ADD COLUMN IF NOT EXISTS request_method LowCardinality(Nullable(String))
  AFTER error_group_id,
  ADD COLUMN IF NOT EXISTS request_path Nullable(String)
  AFTER request_method,
  ADD COLUMN IF NOT EXISTS http_status Nullable(UInt16)
  AFTER request_path,
  ADD COLUMN IF NOT EXISTS resource_type LowCardinality(Nullable(String))
  AFTER http_status,
  ADD COLUMN IF NOT EXISTS vital_name LowCardinality(Nullable(String))
  AFTER resource_type,
  ADD COLUMN IF NOT EXISTS vital_value Nullable(Float64)
  AFTER vital_name,
  ADD COLUMN IF NOT EXISTS vital_rating LowCardinality(Nullable(String))
  AFTER vital_value,
  ADD COLUMN IF NOT EXISTS navigation_type LowCardinality(Nullable(String))
  AFTER vital_rating;

-- statement-breakpoint

ALTER TABLE raw_events
  ADD INDEX IF NOT EXISTS idx_error_group error_group_id TYPE bloom_filter(0.01) GRANULARITY 4;

-- statement-breakpoint

ALTER TABLE raw_events
  ADD INDEX IF NOT EXISTS idx_release_version release_version TYPE bloom_filter(0.01) GRANULARITY 4;

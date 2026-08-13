ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS collector_sample_rate Nullable(Float64) AFTER navigation_type,
  ADD COLUMN IF NOT EXISTS request_count Nullable(UInt32) AFTER collector_sample_rate,
  ADD COLUMN IF NOT EXISTS request_success_count Nullable(UInt32) AFTER request_count,
  ADD COLUMN IF NOT EXISTS request_error_count Nullable(UInt32) AFTER request_success_count,
  ADD COLUMN IF NOT EXISTS request_slow_count Nullable(UInt32) AFTER request_error_count,
  ADD COLUMN IF NOT EXISTS slow_threshold_ms Nullable(UInt32) AFTER request_slow_count,
  ADD COLUMN IF NOT EXISTS resource_total_count Nullable(UInt32) AFTER slow_threshold_ms,
  ADD COLUMN IF NOT EXISTS resource_failed_count Nullable(UInt32) AFTER resource_total_count,
  ADD COLUMN IF NOT EXISTS resource_total_duration_ms Nullable(UInt64) AFTER resource_failed_count,
  ADD COLUMN IF NOT EXISTS readiness_template LowCardinality(Nullable(String)) AFTER resource_total_duration_ms,
  ADD COLUMN IF NOT EXISTS readiness_state LowCardinality(Nullable(String)) AFTER readiness_template,
  ADD COLUMN IF NOT EXISTS first_screen_collected Nullable(Boolean) AFTER readiness_state,
  ADD COLUMN IF NOT EXISTS blank_detection_collected Nullable(Boolean) AFTER first_screen_collected,
  ADD COLUMN IF NOT EXISTS row_count_bucket LowCardinality(Nullable(String)) AFTER blank_detection_collected,
  ADD COLUMN IF NOT EXISTS long_task_count Nullable(UInt32) AFTER row_count_bucket,
  ADD COLUMN IF NOT EXISTS long_task_duration_ms Nullable(UInt64) AFTER long_task_count,
  ADD COLUMN IF NOT EXISTS long_task_maximum_ms Nullable(UInt32) AFTER long_task_duration_ms,
  ADD COLUMN IF NOT EXISTS observed_page_views Nullable(UInt32) AFTER long_task_maximum_ms,
  ADD COLUMN IF NOT EXISTS breadcrumbs_json Nullable(String) AFTER observed_page_views;

-- statement-breakpoint

ALTER TABLE raw_events
  ADD INDEX IF NOT EXISTS idx_request_path request_path TYPE bloom_filter(0.01) GRANULARITY 4;

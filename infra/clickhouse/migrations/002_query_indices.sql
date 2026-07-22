ALTER TABLE raw_events
  ADD INDEX IF NOT EXISTS idx_feature_key feature_key TYPE bloom_filter(0.01) GRANULARITY 4;

-- statement-breakpoint

ALTER TABLE raw_events
  ADD INDEX IF NOT EXISTS idx_session_id session_id TYPE bloom_filter(0.01) GRANULARITY 4;

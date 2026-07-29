ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS sdk_name LowCardinality(String) DEFAULT 'unknown'
  AFTER schema_version;

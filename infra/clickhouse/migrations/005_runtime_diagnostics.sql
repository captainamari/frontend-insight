CREATE TABLE IF NOT EXISTS diagnostic_details (
  project_id UUID,
  event_id String,
  envelope_json String,
  received_at DateTime64(3, 'UTC'),
  expires_at DateTime('UTC')
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(expires_at)
ORDER BY (project_id,event_id)
TTL expires_at DELETE;

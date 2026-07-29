ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS operation_instance_id Nullable(String)
  AFTER page_view_id;

-- statement-breakpoint

ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS interaction_type LowCardinality(Nullable(String))
  AFTER operation_instance_id;
